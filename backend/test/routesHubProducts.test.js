/**
 * Tests de routes/hubProducts.js: lista, detalle y "Vincular" (que iguala el SKU solo en el canal
 * que lo necesita). Mockea el snapshot (conflictsService) y la escritura (syncService).
 */
import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const state = { catalog: null, refreshed: 0, persisted: [], persistResult: { ml: true, tn: true }, tnPatches: [] };

let server, baseUrl;

before(async () => {
  mock.module('../src/services/conflictsService.js', {
    exports: {
      getCatalogRows: async () => state.catalog,
      refreshAnalysis: async () => { state.refreshed++; },
      patchTnSku: async (...a) => { state.tnPatches.push(a); },
    },
  });
  mock.module('../src/services/syncService.js', {
    exports: {
      persistSkuToChannels: async (entry) => { state.persisted.push(entry); return state.persistResult; },
    },
  });
  const { hubProductsRoutes } = await import('../src/routes/hubProducts.js');
  const app = express();
  app.use(express.json());
  app.use('/api/hub-products', hubProductsRoutes);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/hub-products`;
});

after(() => server.close());

beforeEach(() => {
  state.catalog = {
    mlConnected: true, tnConnected: true, at: 123,
    mlRows: [
      { itemId: 'MLA1', variationId: '1', title: 'Monoblock', variationName: 'Rayado', sku: 'LED-RAY', stock: 4, format: 'legacy' },
      { itemId: 'MLA1', variationId: '2', title: 'Monoblock', variationName: 'Cuadriculado', sku: null, stock: 9, format: 'legacy' },
    ],
    tnRows: [
      { productId: 7, variantId: 70, productName: 'Monoblock', sku: 'LED-RAY', stock: 4 },
      { productId: 7, variantId: 71, productName: 'Monoblock', sku: 'LED-CUA', stock: 9 },
    ],
  };
  state.refreshed = 0;
  state.persisted = [];
  state.persistResult = { ml: true, tn: true };
  state.tnPatches = [];
});

const post = (path, body) => fetch(baseUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('GET / lista los productos con conteos y no fuerza un crawl salvo con refresh=1', async () => {
  const r = await (await fetch(baseUrl)).json();
  assert.equal(r.total, 1);
  assert.equal(r.rows[0].status, 'orphan');
  assert.equal(r.counts.orphan, 1);
  assert.equal(state.refreshed, 0);
  await fetch(baseUrl + '?refresh=1');
  assert.equal(state.refreshed, 1);
});

test('GET /:key devuelve el detalle; 404 si el grupo ya no existe', async () => {
  const g = await (await fetch(baseUrl + '/' + encodeURIComponent('ml:MLA1'))).json();
  assert.equal(g.ml[0].itemId, 'MLA1');
  assert.equal(g.rows.length, 3);
  const miss = await fetch(baseUrl + '/' + encodeURIComponent('ml:NOPE'));
  assert.equal(miss.status, 404);
});

test('GET /link-candidates valida el canal y devuelve las variantes sin par', async () => {
  assert.equal((await fetch(baseUrl + '/link-candidates?channel=xx')).status, 400);
  const c = await (await fetch(baseUrl + '/link-candidates?channel=tn')).json();
  assert.deepEqual(c.map((x) => x.variantId), [71]);
});

test('POST /link escribe solo el canal cuyo SKU cambia', async () => {
  const res = await post('/link', { sku: 'LED-CUA', ml: { itemId: 'MLA1', variationId: '2' }, tn: { productId: 7, variantId: 71 } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.pendingMl, true);
  assert.equal(state.persisted.length, 1);
  assert.deepEqual(state.persisted[0].mercadolibre, { itemId: 'MLA1', variationId: '2' });
  assert.equal(state.persisted[0].tiendanube, undefined, 'TN ya tenía ese SKU: no se toca');
  assert.equal(state.tnPatches.length, 0);
});

test('POST /link con SKU nuevo escribe los dos canales y parchea la foto de TN', async () => {
  const res = await post('/link', { sku: 'LED-CUA-2', ml: { itemId: 'MLA1', variationId: '2' }, tn: { productId: 7, variantId: 71 } });
  assert.equal(res.status, 200);
  assert.ok(state.persisted[0].mercadolibre && state.persisted[0].tiendanube);
  assert.deepEqual(state.tnPatches, [[7, 71, 'LED-CUA-2']]);
});

test('POST /link rechaza un SKU que ya usa otra variante, datos faltantes y fallas del canal', async () => {
  const dup = await post('/link', { sku: 'LED-RAY', ml: { itemId: 'MLA1', variationId: '2' }, tn: { productId: 7, variantId: 71 } });
  assert.equal(dup.status, 409);
  assert.equal(state.persisted.length, 0);
  assert.equal((await post('/link', { sku: '', ml: { itemId: 'MLA1' }, tn: { productId: 7, variantId: 71 } })).status, 400);
  assert.equal((await post('/link', { sku: 'X', ml: { itemId: 'MLA9' }, tn: { productId: 7, variantId: 71 } })).status, 404);
  state.persistResult = { ml: true, tn: false };
  assert.equal((await post('/link', { sku: 'NUEVO', ml: { itemId: 'MLA1', variationId: '2' }, tn: { productId: 7, variantId: 71 } })).status, 502);
});
