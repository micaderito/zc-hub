/**
 * Tests de routes/conflicts.js: HTTP sobre /api/conflicts/* (análisis, update-sku, link,
 * update-prices, task/:id). Mismo patrón que routesSync.test.js: Express real en un puerto
 * libre, `fetch` nativo, todos los módulos de negocio mockeados con mock.module.
 *
 * Nota: POST /update-prices serializa llamadas con una pausa de 450ms (UPDATE_ML_DELAY_MS) para
 * no saturar la API de ML — los tests que la ejercitan son deliberadamente pocos.
 */
import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const storeState = {
  tokens: { mercadolibre: {}, tiendanube: { access_token: null, store_id: null } },
  mlToken: 'ml-tok',
  addResolutionCalls: [],
};

const analysisState = {
  result: {
    matched: [], onlyML: [], onlyTN: [], noSkuML: [], noSkuTN: [], duplicateSkuML: [], duplicateSkuTN: [],
    mlConnected: true, tnConnected: true, summary: {},
  },
};

const syncServiceState = { persistResult: { ml: true, tn: true } };
const dbState = { invalidateCalls: 0, enqueueResult: 5, taskStatus: null };
const mlState = {
  updateVariationSkuError: null,
  updateItemSkuError: null,
  updateStockResult: true,
};
const tnState = {
  updateVariantSkuError: null,
  updateVariantPriceResult: true,
  updateVariantStockResult: true,
};

let app, server, baseUrl;

// GET / arma un Promise.race con un setTimeout(120000) para acotar el análisis, pero nunca lo
// limpia (no hay clearTimeout) — el timer sigue vivo y mantiene el event loop despierto 2 minutos
// después de cada test. No es algo que toque el código de producción para arreglar acá: alcanza
// con marcar como unref() los timers largos que arma esta ruta, así el proceso de test no espera.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  const t = realSetTimeout(fn, ms, ...args);
  if (ms >= 60000 && t?.unref) t.unref();
  return t;
};

before(async () => {
  mock.module('../src/store.js', {
    exports: {
      tokens: storeState.tokens,
      getMlToken: async () => storeState.mlToken,
      addResolution: (e) => storeState.addResolutionCalls.push(e),
    },
  });
  mock.module('../src/services/conflictsService.js', {
    exports: { getAnalysis: async () => analysisState.result },
  });
  mock.module('../src/services/syncService.js', {
    exports: { persistSkuToChannels: async () => syncServiceState.persistResult },
  });
  mock.module('../src/db.js', {
    exports: {
      invalidateAnalysisCache: async () => { dbState.invalidateCalls++; },
      enqueueMlTask: async () => dbState.enqueueResult,
      getMlTaskStatus: async () => dbState.taskStatus,
    },
  });
  mock.module('../src/lib/mercadolibre.js', {
    exports: {
      updateVariationSku: async () => { if (mlState.updateVariationSkuError) throw mlState.updateVariationSkuError; return true; },
      updateItemSku: async () => { if (mlState.updateItemSkuError) throw mlState.updateItemSkuError; return true; },
      updateItemOrVariationStock: async () => mlState.updateStockResult,
    },
  });
  mock.module('../src/lib/tiendanube.js', {
    exports: {
      updateVariantSku: async () => { if (tnState.updateVariantSkuError) throw tnState.updateVariantSkuError; return true; },
      updateVariantPrice: async () => tnState.updateVariantPriceResult,
      updateVariantStock: async () => tnState.updateVariantStockResult,
    },
  });

  const { conflictsRoutes } = await import('../src/routes/conflicts.js');
  app = express();
  app.use(express.json());
  app.use('/api/conflicts', conflictsRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/conflicts`;
});

after(() => { server.close(); });

beforeEach(() => {
  storeState.tokens.mercadolibre = {};
  storeState.tokens.tiendanube = { access_token: null, store_id: null };
  storeState.mlToken = 'ml-tok';
  storeState.addResolutionCalls = [];
  analysisState.result = {
    matched: [{ ml: { stock: 5, title: 'A' }, tn: { stock: 5, productName: 'A' }, sku: 'A' }],
    onlyML: [{ title: 'Solo ML', sku: 'B' }],
    onlyTN: [{ productName: 'Solo TN', sku: 'C' }],
    noSkuML: [], noSkuTN: [], duplicateSkuML: [], duplicateSkuTN: [],
    mlConnected: true, tnConnected: true, summary: {},
  };
  syncServiceState.persistResult = { ml: true, tn: true };
  dbState.invalidateCalls = 0;
  dbState.enqueueResult = 5;
  dbState.taskStatus = null;
  mlState.updateVariationSkuError = null;
  mlState.updateItemSkuError = null;
  mlState.updateStockResult = true;
  tnState.updateVariantSkuError = null;
  tnState.updateVariantPriceResult = true;
  tnState.updateVariantStockResult = true;
});

// ─── GET / (análisis) ────────────────────────────────────────────────────

test('GET /: tab=coincidencias devuelve matched paginado y stockSummary', async () => {
  const res = await fetch(`${baseUrl}/?tab=coincidencias&page=1&limit=25`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.matched.length, 1);
  assert.ok(body.stockSummary);
  assert.ok(body.paging);
});

test('GET /: tab=solo-ml filtra por búsqueda', async () => {
  const res = await fetch(`${baseUrl}/?tab=solo-ml&search=Solo`);
  const body = await res.json();
  assert.equal(body.onlyML.length, 1);
});

test('GET /: tab=solo-tn devuelve onlyTN paginado', async () => {
  const res = await fetch(`${baseUrl}/?tab=solo-tn`);
  const body = await res.json();
  assert.equal(body.onlyTN.length, 1);
});

test('GET /: filter=mismatch filtra coincidencias con stock distinto', async () => {
  analysisState.result.matched.push({ ml: { stock: 3 }, tn: { stock: 9 }, sku: 'X' });
  const res = await fetch(`${baseUrl}/?tab=coincidencias&filter=mismatch`);
  const body = await res.json();
  assert.equal(body.matched.length, 1);
  assert.equal(body.matched[0].sku, 'X');
});

// ─── POST /update-sku ────────────────────────────────────────────────────

test('POST /update-sku: sin sku → 400', async () => {
  const res = await fetch(`${baseUrl}/update-sku`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'mercadolibre' }) });
  assert.equal(res.status, 400);
});

test('POST /update-sku: ML sin token → 401', async () => {
  storeState.mlToken = null;
  const res = await fetch(`${baseUrl}/update-sku`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'mercadolibre', sku: 'X', itemId: 'MLA1' }) });
  assert.equal(res.status, 401);
});

test('POST /update-sku: ML sin itemId → 400', async () => {
  const res = await fetch(`${baseUrl}/update-sku`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'mercadolibre', sku: 'X' }) });
  assert.equal(res.status, 400);
});

test('POST /update-sku: ML éxito sin variationId (updateItemSku)', async () => {
  const res = await fetch(`${baseUrl}/update-sku`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'mercadolibre', sku: 'X', itemId: 'MLA1' }) });
  const body = await res.json();
  assert.deepEqual(body, { ok: true });
  assert.equal(dbState.invalidateCalls, 1);
});

test('POST /update-sku: ML éxito con variationId (updateVariationSku)', async () => {
  const res = await fetch(`${baseUrl}/update-sku`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'mercadolibre', sku: 'X', itemId: 'MLA1', variationId: '111' }) });
  const body = await res.json();
  assert.deepEqual(body, { ok: true });
});

test('POST /update-sku: ML error has_bids → mensaje amigable, 502', async () => {
  mlState.updateItemSkuError = new Error('has_bids true');
  const res = await fetch(`${baseUrl}/update-sku`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'mercadolibre', sku: 'X', itemId: 'MLA1' }) });
  const body = await res.json();
  assert.equal(res.status, 502);
  assert.match(body.error, /panel de ML/);
});

test('POST /update-sku: ML error under_review → mensaje específico', async () => {
  mlState.updateItemSkuError = new Error('status under_review');
  const res = await fetch(`${baseUrl}/update-sku`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'mercadolibre', sku: 'X', itemId: 'MLA1' }) });
  const body = await res.json();
  assert.equal(res.status, 502);
  assert.match(body.error, /revisión/);
});

test('POST /update-sku: TN sin token → 401', async () => {
  const res = await fetch(`${baseUrl}/update-sku`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'tiendanube', sku: 'X', productId: 1, variantId: 2 }) });
  assert.equal(res.status, 401);
});

test('POST /update-sku: TN sin productId/variantId → 400', async () => {
  storeState.tokens.tiendanube = { access_token: 'tn-tok', store_id: '5' };
  const res = await fetch(`${baseUrl}/update-sku`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'tiendanube', sku: 'X' }) });
  assert.equal(res.status, 400);
});

test('POST /update-sku: TN éxito', async () => {
  storeState.tokens.tiendanube = { access_token: 'tn-tok', store_id: '5' };
  const res = await fetch(`${baseUrl}/update-sku`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'tiendanube', sku: 'X', productId: 1, variantId: 2 }) });
  const body = await res.json();
  assert.deepEqual(body, { ok: true });
});

test('POST /update-sku: TN error → 502', async () => {
  storeState.tokens.tiendanube = { access_token: 'tn-tok', store_id: '5' };
  tnState.updateVariantSkuError = new Error('TN rechazó');
  const res = await fetch(`${baseUrl}/update-sku`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'tiendanube', sku: 'X', productId: 1, variantId: 2 }) });
  assert.equal(res.status, 502);
});

test('POST /update-sku: channel inválido → 400', async () => {
  const res = await fetch(`${baseUrl}/update-sku`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'otro', sku: 'X' }) });
  assert.equal(res.status, 400);
});

// ─── POST /link ──────────────────────────────────────────────────────────

test('POST /link: sin sku → 400', async () => {
  const res = await fetch(`${baseUrl}/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  assert.equal(res.status, 400);
});

test('POST /link: sin mercadolibre.itemId → 400', async () => {
  const res = await fetch(`${baseUrl}/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sku: 'X' }) });
  assert.equal(res.status, 400);
});

test('POST /link: sin tiendanube.productId/variantId → 400', async () => {
  const res = await fetch(`${baseUrl}/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sku: 'X', mercadolibre: { itemId: 'MLA1' } }) });
  assert.equal(res.status, 400);
});

test('POST /link: sin token ML → 401', async () => {
  storeState.mlToken = null;
  const res = await fetch(`${baseUrl}/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sku: 'X', mercadolibre: { itemId: 'MLA1' }, tiendanube: { productId: 1, variantId: 2 } }) });
  assert.equal(res.status, 401);
});

test('POST /link: sin token TN → 401', async () => {
  const res = await fetch(`${baseUrl}/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sku: 'X', mercadolibre: { itemId: 'MLA1' }, tiendanube: { productId: 1, variantId: 2 } }) });
  assert.equal(res.status, 401);
});

test('POST /link: éxito vincula y persiste', async () => {
  storeState.tokens.tiendanube = { access_token: 'tn-tok', store_id: '5' };
  const res = await fetch(`${baseUrl}/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sku: 'X', mercadolibre: { itemId: 'MLA1' }, tiendanube: { productId: 1, variantId: 2 } }) });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(storeState.addResolutionCalls.length, 1);
});

test('POST /link: persisted.ml false → 502', async () => {
  storeState.tokens.tiendanube = { access_token: 'tn-tok', store_id: '5' };
  syncServiceState.persistResult = { ml: false, tn: true };
  const res = await fetch(`${baseUrl}/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sku: 'X', mercadolibre: { itemId: 'MLA1' }, tiendanube: { productId: 1, variantId: 2 } }) });
  assert.equal(res.status, 502);
});

// ─── GET /task/:taskId ─────────────────────────────────────────────────────

test('GET /task/:taskId: id inválido → 400', async () => {
  const res = await fetch(`${baseUrl}/task/abc`);
  assert.equal(res.status, 400);
});

test('GET /task/:taskId: no encontrada → 404', async () => {
  dbState.taskStatus = null;
  const res = await fetch(`${baseUrl}/task/1`);
  assert.equal(res.status, 404);
});

test('GET /task/:taskId: encontrada → 200', async () => {
  dbState.taskStatus = { id: 1, status: 'done' };
  const res = await fetch(`${baseUrl}/task/1`);
  const body = await res.json();
  assert.deepEqual(body, { id: 1, status: 'done' });
});

// ─── POST /update-prices (serializado, pocos tests por la pausa de 450ms) ──

test('POST /update-prices: sin itemId → 400', async () => {
  const res = await fetch(`${baseUrl}/update-prices`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  assert.equal(res.status, 400);
});

test('POST /update-prices: encola precio ML y actualiza TN → ok', async () => {
  storeState.tokens.tiendanube = { access_token: 'tn-tok', store_id: '5' };
  const res = await fetch(`${baseUrl}/update-prices`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemId: 'MLA1', productId: 1, variantId: 2, priceML: 100, priceTN: 100 }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.mlTaskId, 5);
});
