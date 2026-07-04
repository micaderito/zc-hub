/**
 * Tests de updateItemOrVariationPrice / updateItemOrVariationStock.
 *
 * Mockeamos `node-fetch` con mock.module (requiere --experimental-test-module-mocks, ya en el
 * script npm test) e interceptamos las llamadas para inspeccionar URL/método/body sin red.
 *
 * Casos clave (ver CLAUDE.md → "Precio por variación"):
 *  - Precio con variación (ítem legacy): ML exige el MISMO precio en todas las variaciones.
 *  - Precio sin variación / ítem sin variaciones: PUT directo { price }.
 *  - Stock con variación: solo la variación objetivo lleva available_quantity; el resto { id }.
 *  - Error de ML: se propaga el mensaje real con mlStatus.
 */
import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// Estado compartido que controla qué responde el fetch mockeado y registra las llamadas.
const state = { responder: null, calls: [] };

// IMPORTANTE: nunca debe throw-ear de forma síncrona. mlSchedule (mlLimiter.js) asume que
// run() siempre devuelve una promesa (hace job.run().then(...)); si run() tira sincrónicamente
// (p. ej. porque el body no es JSON — exchangeCodeForToken/refreshAccessToken mandan
// URLSearchParams, no JSON.stringify), el .then nunca se agrega, `active` nunca se decrementa
// y el limitador queda trabado para siempre (todas las llamadas siguientes cuelgan). Por eso acá
// todo se resuelve/rechaza async y el parseo de body es tolerante a bodies no-JSON.
async function mockFetch(url, opts = {}) {
  let body;
  if (typeof opts.body === 'string') {
    try { body = JSON.parse(opts.body); } catch { body = opts.body; }
  } else if (opts.body != null) {
    body = String(opts.body); // ej. URLSearchParams
  }
  state.calls.push({ url, method: opts.method || 'GET', body });
  return state.responder(url, opts);
}

/** Construye una Response mínima compatible con lo que usa mercadolibre.js. */
function makeRes({ status = 200, json = null, text = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => json,
    text: async () => (text != null ? text : JSON.stringify(json ?? {})),
  };
}

const TOKEN = 'test-token';
const ITEM = 'MLA123';
const itemWithVariations = {
  id: ITEM,
  variations: [
    { id: 111, price: 100, available_quantity: 5, user_product_id: 'MLAU1' },
    { id: 222, price: 100, available_quantity: 3, user_product_id: 'MLAU2' },
    { id: 333, price: 100, available_quantity: 0, user_product_id: 'MLAU3' },
  ],
};

const isGetItem = (url) => url.includes(`/items/${ITEM}`) && url.includes('include_attributes');
const isPutItem = (url, opts) => url.endsWith(`/items/${ITEM}`) && opts.method === 'PUT';
const putCalls = () => state.calls.filter((c) => c.method === 'PUT');
const getCalls = () => state.calls.filter((c) => c.method === 'GET');

let ml;
before(async () => {
  mock.module('node-fetch', { exports: { default: mockFetch } });
  ml = await import('../src/lib/mercadolibre.js');
});
beforeEach(() => {
  state.calls = [];
  state.responder = null;
});

// ─── Precio ──────────────────────────────────────────────────────────────────

test('precio: con variación aplica el MISMO precio a TODAS las variaciones', async () => {
  state.responder = (url, opts) => {
    if (isGetItem(url)) return makeRes({ json: itemWithVariations });
    if (isPutItem(url, opts)) return makeRes({ json: {} });
    throw new Error(`URL inesperada: ${opts.method} ${url}`);
  };

  const ok = await ml.updateItemOrVariationPrice(TOKEN, ITEM, '111', 150);
  assert.equal(ok, true);

  const put = putCalls();
  assert.equal(put.length, 1, 'debe hacer un único PUT');
  assert.deepEqual(put[0].body, {
    variations: [
      { id: 111, price: 150 },
      { id: 222, price: 150 },
      { id: 333, price: 150 },
    ],
  });
});

test('precio: con variación pero ítem sin variaciones → PUT directo { price }', async () => {
  state.responder = (url, opts) => {
    if (isGetItem(url)) return makeRes({ json: { id: ITEM, variations: [] } });
    if (isPutItem(url, opts)) return makeRes({ json: {} });
    throw new Error(`URL inesperada: ${opts.method} ${url}`);
  };

  const ok = await ml.updateItemOrVariationPrice(TOKEN, ITEM, '111', 150);
  assert.equal(ok, true);
  assert.deepEqual(putCalls()[0].body, { price: 150 });
});

test('precio: sin variación → PUT directo { price } sin GET previo', async () => {
  state.responder = (url, opts) => {
    if (isPutItem(url, opts)) return makeRes({ json: {} });
    throw new Error(`URL inesperada: ${opts.method} ${url}`);
  };

  const ok = await ml.updateItemOrVariationPrice(TOKEN, ITEM, null, 150);
  assert.equal(ok, true);
  assert.equal(getCalls().length, 0, 'no debe consultar el ítem');
  assert.deepEqual(putCalls()[0].body, { price: 150 });
});

test('precio: si ML rechaza, lanza con mlStatus y el mensaje real', async () => {
  state.responder = (url, opts) => {
    if (isGetItem(url)) return makeRes({ json: itemWithVariations });
    if (isPutItem(url, opts)) {
      return makeRes({
        status: 400,
        json: { message: 'error', cause: [{ message: 'Found different prices in variations' }] },
      });
    }
    throw new Error(`URL inesperada: ${opts.method} ${url}`);
  };

  await assert.rejects(
    () => ml.updateItemOrVariationPrice(TOKEN, ITEM, '111', 150),
    (err) => {
      assert.equal(err.mlStatus, 400);
      assert.match(err.message, /different prices/i);
      return true;
    }
  );
});

// ─── Stock ───────────────────────────────────────────────────────────────────

test('stock: con variación solo la objetivo lleva available_quantity; el resto { id }', async () => {
  state.responder = (url, opts) => {
    if (isGetItem(url)) return makeRes({ json: itemWithVariations });
    if (isPutItem(url, opts)) return makeRes({ json: {} });
    throw new Error(`URL inesperada: ${opts.method} ${url}`);
  };

  const ok = await ml.updateItemOrVariationStock(TOKEN, ITEM, '222', 7);
  assert.equal(ok, true);
  assert.deepEqual(putCalls()[0].body, {
    variations: [
      { id: 111 },
      { id: 222, available_quantity: 7 },
      { id: 333 },
    ],
  });
});

test('stock: sin variación → PUT directo { available_quantity }', async () => {
  state.responder = (url, opts) => {
    if (isPutItem(url, opts)) return makeRes({ json: {} });
    throw new Error(`URL inesperada: ${opts.method} ${url}`);
  };

  const ok = await ml.updateItemOrVariationStock(TOKEN, ITEM, undefined, 7);
  assert.equal(ok, true);
  assert.equal(getCalls().length, 0);
  assert.deepEqual(putCalls()[0].body, { available_quantity: 7 });
});

test('stock: con variación pero ítem sin variaciones → devuelve false sin PUT', async () => {
  state.responder = (url) => {
    if (isGetItem(url)) return makeRes({ json: { id: ITEM, variations: [] } });
    throw new Error(`URL inesperada: ${url}`);
  };

  const ok = await ml.updateItemOrVariationStock(TOKEN, ITEM, '111', 7);
  assert.equal(ok, false);
  assert.equal(putCalls().length, 0);
});

test('stock: cantidad negativa se normaliza a 0', async () => {
  state.responder = (url, opts) => {
    if (isPutItem(url, opts)) return makeRes({ json: {} });
    throw new Error(`URL inesperada: ${opts.method} ${url}`);
  };

  await ml.updateItemOrVariationStock(TOKEN, ITEM, undefined, -5);
  assert.deepEqual(putCalls()[0].body, { available_quantity: 0 });
});

// ─── OAuth ───────────────────────────────────────────────────────────────────

test('getAuthUrl: arma la url de autorización con client_id y redirect_uri', async () => {
  const url = await ml.getAuthUrl('https://app.example/callback', 'estado1');
  assert.match(url, /^https:\/\/auth\.mercadolibre\.com\.ar\/authorization\?/);
  assert.match(url, /redirect_uri=https/);
  assert.match(url, /state=estado1/);
});

test('exchangeCodeForToken: éxito devuelve el JSON de ML', async () => {
  state.responder = (url, opts) => {
    assert.equal(opts.method, 'POST');
    return makeRes({ json: { access_token: 'a', refresh_token: 'r' } });
  };
  const data = await ml.exchangeCodeForToken('code123', 'https://app/callback');
  assert.equal(data.access_token, 'a');
});

test('exchangeCodeForToken: error de ML lanza con status y body', async () => {
  state.responder = () => makeRes({ status: 400, text: 'invalid_grant' });
  await assert.rejects(() => ml.exchangeCodeForToken('bad', 'https://app/callback'), /ML token error: 400/);
});

test('refreshAccessToken: éxito devuelve el JSON de ML', async () => {
  state.responder = () => makeRes({ json: { access_token: 'new', refresh_token: 'r2' } });
  const data = await ml.refreshAccessToken('old-refresh');
  assert.equal(data.access_token, 'new');
});

test('refreshAccessToken: error lanza con status y body', async () => {
  state.responder = () => makeRes({ status: 400, text: 'invalid_grant' });
  await assert.rejects(() => ml.refreshAccessToken('old'), /ML refresh failed: 400/);
});

test('getMe: devuelve el usuario si la respuesta es ok', async () => {
  state.responder = () => makeRes({ json: { id: 555 } });
  const me = await ml.getMe(TOKEN);
  assert.equal(me.id, 555);
});

test('getMe: devuelve null si la respuesta no es ok', async () => {
  state.responder = () => makeRes({ status: 401 });
  const me = await ml.getMe(TOKEN);
  assert.equal(me, null);
});

// ─── getItem / getItems ──────────────────────────────────────────────────────

test('getItem: devuelve null si la respuesta no es ok', async () => {
  state.responder = () => makeRes({ status: 404 });
  const item = await ml.getItem(TOKEN, ITEM);
  assert.equal(item, null);
});

test('getItems: multiget en tandas y filtra por code 200, descarta catalog_listing si hay originales', async () => {
  state.responder = (url) => {
    assert.match(url, /\/items\?ids=/);
    return makeRes({
      json: [
        { code: 200, body: { id: 'MLA1', catalog_listing: false } },
        { code: 200, body: { id: 'MLA2', catalog_listing: true } },
        { code: 404, body: null },
      ],
    });
  };
  const items = await ml.getItems(TOKEN, ['MLA1', 'MLA2', 'MLA3']);
  assert.equal(items.length, 2);
});

test('getItems: array vacío no dispara ningún request', async () => {
  state.responder = () => { throw new Error('no debería llamar'); };
  const items = await ml.getItems(TOKEN, []);
  assert.deepEqual(items, []);
});

// ─── getPack / getOrder / getOrdersSearch ────────────────────────────────────

test('getPack: devuelve el pack si la respuesta es ok', async () => {
  state.responder = () => makeRes({ json: { id: 'PACK1', orders: [{ id: 1 }] } });
  const pack = await ml.getPack(TOKEN, 'PACK1');
  assert.equal(pack.id, 'PACK1');
});

test('getPack: devuelve null si falla', async () => {
  state.responder = () => makeRes({ status: 404, text: 'not found' });
  const pack = await ml.getPack(TOKEN, 'PACK1');
  assert.equal(pack, null);
});

test('getOrder: devuelve la orden si la respuesta es ok', async () => {
  state.responder = () => makeRes({ json: { id: 1, order_items: [] } });
  const order = await ml.getOrder(TOKEN, '1');
  assert.equal(order.id, 1);
});

test('getOrder: si falla con status distinto de 429, devuelve null', async () => {
  state.responder = () => makeRes({ status: 404, text: 'not found' });
  const order = await ml.getOrder(TOKEN, '1');
  assert.equal(order, null);
});

test('getOrdersSearch: arma query params y devuelve resultados', async () => {
  state.responder = (url) => {
    assert.match(url, /\/orders\/search\?/);
    return makeRes({ json: { results: [{ id: 1 }] } });
  };
  const res = await ml.getOrdersSearch(TOKEN, { seller: 999, q: '123', limit: 10, offset: 0 });
  assert.equal(res.results.length, 1);
});

test('getOrdersSearch: si falla con status distinto de 429, devuelve null', async () => {
  state.responder = () => makeRes({ status: 500, text: 'error' });
  const res = await ml.getOrdersSearch(TOKEN, {});
  assert.equal(res, null);
});

// ─── claims ──────────────────────────────────────────────────────────────────

test('getClaim: devuelve el reclamo si ok, null si falla', async () => {
  state.responder = () => makeRes({ json: { id: 1, type: 'return' } });
  const claim = await ml.getClaim(TOKEN, '1');
  assert.equal(claim.type, 'return');
  state.responder = () => makeRes({ status: 404 });
  assert.equal(await ml.getClaim(TOKEN, '2'), null);
});

test('getClaimsSearch: arma query params opcionales y devuelve resultados', async () => {
  state.responder = (url) => {
    assert.match(url, /\/post-purchase\/v1\/claims\/search\?/);
    return makeRes({ json: { data: [] } });
  };
  const res = await ml.getClaimsSearch(TOKEN, { limit: 10, status: 'opened', player_role: 'respondent', player_user_id: 999 });
  assert.deepEqual(res.data, []);
});

test('getClaimsSearch: si falla devuelve null', async () => {
  state.responder = () => makeRes({ status: 500, text: 'error' });
  assert.equal(await ml.getClaimsSearch(TOKEN, {}), null);
});

test('getClaimReturns: devuelve datos si ok, null si falla', async () => {
  state.responder = () => makeRes({ json: { status: 'pending' } });
  const r = await ml.getClaimReturns(TOKEN, '1');
  assert.equal(r.status, 'pending');
  state.responder = () => makeRes({ status: 404 });
  assert.equal(await ml.getClaimReturns(TOKEN, '2'), null);
});

// ─── updateItemStock / updateItemSku / updateVariationSku ───────────────────

test('updateItemStock: PUT directo con available_quantity', async () => {
  state.responder = (url, opts) => { assert.equal(opts.method, 'PUT'); return makeRes({ json: {} }); };
  const ok = await ml.updateItemStock(TOKEN, ITEM, 10);
  assert.equal(ok, true);
});

test('updateItemSku: éxito directo con seller_sku', async () => {
  state.responder = (url, opts) => {
    assert.deepEqual(JSON.parse(opts.body), { seller_sku: 'NEW-SKU' });
    return makeRes({ json: {} });
  };
  const ok = await ml.updateItemSku(TOKEN, ITEM, 'NEW-SKU');
  assert.equal(ok, true);
});

test('updateItemSku: falla con has_bids true → reintenta vía atributos', async () => {
  let calls = 0;
  state.responder = (url, opts) => {
    calls++;
    if (isGetItem(url)) return makeRes({ json: { id: ITEM, attributes: [] } });
    const body = JSON.parse(opts.body);
    if (body.seller_sku) return makeRes({ status: 400, json: { message: 'has_bids true' } });
    if (body.attributes) return makeRes({ json: {} });
    throw new Error('inesperado');
  };
  const ok = await ml.updateItemSku(TOKEN, ITEM, 'NEW-SKU');
  assert.equal(ok, true);
  assert.ok(calls >= 3);
});

test('updateItemSku: error no reintentable lanza directo', async () => {
  state.responder = () => makeRes({ status: 400, json: { message: 'error desconocido' } });
  await assert.rejects(() => ml.updateItemSku(TOKEN, ITEM, 'X'), /error desconocido/);
});

test('updateVariationSku: sin variaciones lanza error', async () => {
  state.responder = (url) => {
    if (isGetItem(url)) return makeRes({ json: { id: ITEM, variations: [] } });
    throw new Error('no debería llamar más');
  };
  await assert.rejects(() => ml.updateVariationSku(TOKEN, ITEM, '111', 'X'), /no tiene variaciones/);
});

test('updateVariationSku: éxito actualiza attributes de la variación objetivo, deja las demás con solo id', async () => {
  state.responder = (url, opts) => {
    if (isGetItem(url)) return makeRes({ json: itemWithVariations });
    if (isPutItem(url, opts)) return makeRes({ json: {} });
    throw new Error('inesperado');
  };
  const ok = await ml.updateVariationSku(TOKEN, ITEM, '111', 'NEW-SKU');
  assert.equal(ok, true);
  const body = putCalls()[0].body;
  assert.equal(body.variations.find((v) => v.id === 111).attributes[0].value_name, 'NEW-SKU');
  assert.deepEqual(body.variations.find((v) => v.id === 222), { id: 222 });
});

test('updateVariationSku: si ML rechaza, lanza con el mensaje real', async () => {
  state.responder = (url, opts) => {
    if (isGetItem(url)) return makeRes({ json: itemWithVariations });
    if (isPutItem(url, opts)) return makeRes({ status: 400, json: { message: 'no se puede' } });
    throw new Error('inesperado');
  };
  await assert.rejects(() => ml.updateVariationSku(TOKEN, ITEM, '111', 'X'), /no se puede/);
});

// ─── extractSkuFromItem ──────────────────────────────────────────────────────

test('extractSkuFromItem: usa seller_sku directo si está', () => {
  assert.equal(ml.extractSkuFromItem({ seller_sku: 'A' }), 'A');
});

test('extractSkuFromItem: busca en variations si el ítem no tiene seller_sku directo', () => {
  assert.equal(ml.extractSkuFromItem({ variations: [{ seller_sku: 'B' }] }), 'B');
});

test('extractSkuFromItem: sin SKU en ningún lado devuelve null', () => {
  assert.equal(ml.extractSkuFromItem({}), null);
});

// ─── fetchWith429Retry / 429 ─────────────────────────────────────────────────

test('fetchWith429Retry: reintenta ante 429 respetando Retry-After y devuelve la respuesta final', async () => {
  let attempt = 0;
  state.responder = () => {
    attempt++;
    if (attempt === 1) return { ok: false, status: 429, headers: { get: (h) => (h === 'retry-after' ? '0' : null) }, json: async () => ({}), text: async () => '' };
    return makeRes({ json: { ok: true } });
  };
  const res = await ml.fetchWith429Retry('https://api.mercadolibre.com/x', {}, 'test');
  assert.equal(res.ok, true);
  assert.equal(attempt, 2);
});
