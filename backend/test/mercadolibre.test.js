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

function mockFetch(url, opts = {}) {
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  state.calls.push({ url, method: opts.method || 'GET', body });
  return Promise.resolve(state.responder(url, opts));
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
