/**
 * Tests de findOrderByNumber (lib/tiendanube.js).
 *
 * TN necesita el id interno de la orden para GET /orders/:id, pero el "nro de venta" que ve el
 * dueño (y que el usuario tipea en "Reintentar venta") es order.number. findOrderByNumber recorre
 * /orders paginado hasta encontrar ese número (o el id interno, por si lo tipean directo).
 *
 * Mockeamos `node-fetch` (igual que mercadolibre.test.js) para no pegarle a la API real. Nota: TN
 * tiene un rate-limit de 500ms entre requests (tiendanube.js MIN_INTERVAL_MS), así que los tests
 * con varias páginas tardan ese tiempo real — se mantienen en pocas páginas a propósito.
 */
import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const state = { responder: null, calls: [] };

function mockFetch(url, opts = {}) {
  state.calls.push({ url });
  return Promise.resolve(state.responder(url, opts));
}

function makeRes({ status = 200, json = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => json,
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
