/**
 * Tests de findOrderByNumber (lib/tiendanube.js).
 *
 * TN necesita el id interno de la orden para GET /orders/:id, pero el "nro de venta" que ve el
 * dueño (y que el usuario tipea en "Reintentar venta") es order.number. findOrderByNumber recorre
 * /orders paginado hasta encontrar ese número (o el id interno, por si lo tipean directo).
 *
 * Mockeamos `node-fetch` (igual que mercadolibre.test.js) para no pegarle a la API real. Nota: TN
 * enruta todo por el limitador (lib/tnLimiter.js), que espacia los requests. El script `npm test`
 * setea TN_MIN_SPACING_MS=0 para que los tests no esperen ese espaciado real.
 */
import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const state = { responder: null, calls: [] };

function mockFetch(url, opts = {}) {
  state.calls.push({ url });
  return Promise.resolve(state.responder(url, opts));
}

function makeRes({ status = 200, json = null, resetMs = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (h === 'x-rate-limit-reset' ? resetMs : null) },
    json: async () => json,
    text: async () => (json != null ? JSON.stringify(json) : ''),
  };
}

const STORE_ID = '7377171';
const TOKEN = 'tn-token';

let tn;
before(async () => {
  mock.module('node-fetch', { exports: { default: mockFetch } });
  tn = await import('../src/lib/tiendanube.js');
});
beforeEach(() => {
  state.calls = [];
  state.responder = null;
});

test('encuentra la orden por su número visible (order.number) en la primera página', async () => {
  const order = { id: 2005685156, number: 102, products: [{ sku: 'CREANDO' }] };
  state.responder = (url) => {
    assert.match(url, /\/orders\?page=1&per_page=100/);
    return makeRes({ json: [order, { id: 1, number: 99 }] });
  };

  const found = await tn.findOrderByNumber(TOKEN, STORE_ID, '102');
  assert.deepEqual(found, order);
  assert.equal(state.calls.length, 1, 'no debe seguir paginando una vez que encuentra la orden');
});

test('encuentra la orden por su id interno si el usuario tipea el id en vez del número', async () => {
  const order = { id: 2005685156, number: 102 };
  state.responder = () => makeRes({ json: [order] });

  const found = await tn.findOrderByNumber(TOKEN, STORE_ID, '2005685156');
  assert.deepEqual(found, order);
});

test('pagina hasta encontrarla si no está en la primera página', async () => {
  const order = { id: 5, number: 205 };
  // Página 1: llena (100 items) para forzar que siga a la página 2.
  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i, number: 1000 + i }));
  state.responder = (url) => {
    const page = new URL(url).searchParams.get('page');
    if (page === '1') return makeRes({ json: page1 });
    if (page === '2') return makeRes({ json: [order] });
    throw new Error(`página inesperada: ${url}`);
  };

  const found = await tn.findOrderByNumber(TOKEN, STORE_ID, '205');
  assert.deepEqual(found, order);
  assert.equal(state.calls.length, 2);
});

test('devuelve null si no aparece y la paginación se corta (página no llena)', async () => {
  state.responder = () => makeRes({ json: [{ id: 1, number: 1 }] });

  const found = await tn.findOrderByNumber(TOKEN, STORE_ID, '999');
  assert.equal(found, null);
  assert.equal(state.calls.length, 1, 'una página con menos de per_page items corta la búsqueda');
});

test('devuelve null si la API de TN responde error', async () => {
  state.responder = () => makeRes({ status: 401 });
  const found = await tn.findOrderByNumber(TOKEN, STORE_ID, '102');
  assert.equal(found, null);
});

test('número vacío no dispara ningún request', async () => {
  state.responder = () => { throw new Error('no debería llamar a la API'); };
  const found = await tn.findOrderByNumber(TOKEN, STORE_ID, '  ');
  assert.equal(found, null);
  assert.equal(state.calls.length, 0);
});

/**
 * A diferencia de ML (precio único por ítem legacy), en TN el precio vive en cada variante
 * de forma independiente. "Aplicar a todas las variantes" es una elección de UX, no una
 * obligación de la API: updateVariantPriceAllVariants la resuelve trayendo las variantes del
 * producto y aplicando el precio con el bulk endpoint (1 PATCH cada 50 variantes, no N PUTs).
 */
test('updateVariantPriceAllVariants: trae las variantes y aplica el precio con un solo PATCH bulk', async () => {
  const variants = [{ id: 501 }, { id: 502 }, { id: 503 }];
  const patches = [];
  state.responder = (url, opts) => {
    if (opts.method === 'PATCH') {
      patches.push({ url, body: JSON.parse(opts.body) });
      return makeRes({ json: {} });
    }
    assert.match(url, /\/products\/999\/variants\?page=1&per_page=100/);
    return makeRes({ json: variants });
  };

  const ok = await tn.updateVariantPriceAllVariants(TOKEN, STORE_ID, 999, 1500);

  assert.equal(ok, true);
  assert.equal(patches.length, 1, '3 variantes = 1 request bulk, no 3 PUTs');
  assert.equal(patches[0].url, `https://api.tiendanube.com/v1/${STORE_ID}/products/stock-price`);
  assert.deepEqual(patches[0].body, [
    { id: 999, variants: [
      { id: 501, price: '1500' },
      { id: 502, price: '1500' },
      { id: 503, price: '1500' },
    ] },
  ]);
});

/**
 * Bulk PATCH /products/stock-price: TN acepta hasta 50 variantes por request (contando todos los
 * productos). updateVariantsStockPrice parte la lista en chunks de 50 y agrupa por producto.
 */
test('updateVariantsStockPrice: parte en chunks de 50 y arma el body agrupado por producto', async () => {
  const updates = Array.from({ length: 51 }, (_, i) => ({
    productId: 999, variantId: 600 + i, price: 100 + i, stock: i,
  }));
  const patches = [];
  state.responder = (url, opts) => {
    assert.equal(opts.method, 'PATCH');
    assert.equal(url, `https://api.tiendanube.com/v1/${STORE_ID}/products/stock-price`);
    patches.push(JSON.parse(opts.body));
    return makeRes({ json: {} });
  };

  const ok = await tn.updateVariantsStockPrice(TOKEN, STORE_ID, updates);

  assert.equal(ok, true);
  assert.equal(patches.length, 2, '51 variantes = 2 requests (50 + 1)');
  assert.equal(patches[0][0].variants.length, 50);
  assert.equal(patches[1][0].variants.length, 1);
  // El precio va como string y el stock dentro de inventory_levels.
  assert.deepEqual(patches[0][0].variants[0], {
    id: 600, price: '100', inventory_levels: [{ stock: 0 }],
  });
});

/**
 * El limitador comparte gate y reintenta ante 429 respetando x-rate-limit-reset. Antes el retry
 * era único; ahora hay varios, así que un 429 aislado se recupera solo sin perder el write.
 */
test('updateVariant reintenta ante 429 y respeta x-rate-limit-reset', async () => {
  let n = 0;
  state.responder = () => {
    n++;
    if (n === 1) return makeRes({ status: 429, resetMs: 10 });
    return makeRes({ json: {} });
  };

  const ok = await tn.updateVariantStock(TOKEN, STORE_ID, 999, 501, 7);

  assert.equal(ok, true);
  assert.equal(n, 2, 'un 429 dispara exactamente un reintento que sale OK');
});
