/**
 * Tests de routes/mapping.js: listar/vincular pares SKU↔canal y listar el catálogo de ML/TN
 * para autocomplete (ej. Depósito Marañón). Las rutas /sources/* leen del snapshot cacheado de
 * conflictsService (getAnalysis) — mismo catálogo completo que usan Precio y stock/Conflictos.
 */
import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const storeState = {
  resolvedMappings: [],
};

const syncServiceState = { persistResult: { ml: true, tn: true }, persistError: null };

const conflictsServiceState = {
  analysisResult: { mlConnected: true, tnConnected: true, matched: [], onlyML: [], onlyTN: [] },
  analysisError: null,
};

let app, server, baseUrl;

before(async () => {
  mock.module('../src/store.js', {
    exports: {
      getResolvedMappings: () => storeState.resolvedMappings,
    },
  });
  mock.module('../src/services/syncService.js', {
    exports: {
      persistSkuToChannels: async () => {
        if (syncServiceState.persistError) throw syncServiceState.persistError;
        return syncServiceState.persistResult;
      },
    },
  });
  mock.module('../src/services/conflictsService.js', {
    exports: {
      getAnalysis: async () => {
        if (conflictsServiceState.analysisError) throw conflictsServiceState.analysisError;
        return conflictsServiceState.analysisResult;
      },
    },
  });

  const { mappingRoutes } = await import('../src/routes/mapping.js');
  app = express();
  app.use(express.json());
  app.use('/api/mapping', mappingRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/mapping`;
});

after(() => { server.close(); });

beforeEach(() => {
  storeState.resolvedMappings = [];
  syncServiceState.persistResult = { ml: true, tn: true };
  syncServiceState.persistError = null;
  conflictsServiceState.analysisResult = { mlConnected: true, tnConnected: true, matched: [], onlyML: [], onlyTN: [] };
  conflictsServiceState.analysisError = null;
});

test('GET /: lista los pares vinculados', async () => {
  storeState.resolvedMappings = [{ sku: 'X', mercadolibre: {}, tiendanube: {} }];
  const res = await fetch(`${baseUrl}/`);
  const body = await res.json();
  assert.equal(body.length, 1);
});

test('POST /: sin sku → 400', async () => {
  const res = await fetch(`${baseUrl}/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  assert.equal(res.status, 400);
});

test('POST /: sin mercadolibre.itemId → 400', async () => {
  const res = await fetch(`${baseUrl}/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sku: 'X' }) });
  assert.equal(res.status, 400);
});

test('POST /: vincula con éxito', async () => {
  const res = await fetch(`${baseUrl}/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sku: 'X', mercadolibre: { itemId: 'MLA1' }, tiendanube: { productId: 1, variantId: 2 } }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
});

test('POST /: si persistSkuToChannels lanza → 500', async () => {
  syncServiceState.persistError = new Error('boom');
  const res = await fetch(`${baseUrl}/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sku: 'X', mercadolibre: { itemId: 'MLA1' }, tiendanube: { productId: 1, variantId: 2 } }),
  });
  assert.equal(res.status, 500);
});

test('PUT /:sku y DELETE /:sku son no-op y devuelven ok', async () => {
  const put = await fetch(`${baseUrl}/X`, { method: 'PUT' });
  assert.deepEqual(await put.json(), { ok: true });
  const del = await fetch(`${baseUrl}/X`, { method: 'DELETE' });
  assert.deepEqual(await del.json(), { ok: true });
});

test('GET /sources/mercadolibre: ML no conectado → 401', async () => {
  conflictsServiceState.analysisResult = { mlConnected: false, tnConnected: true, matched: [], onlyML: [], onlyTN: [] };
  const res = await fetch(`${baseUrl}/sources/mercadolibre`);
  assert.equal(res.status, 401);
});

test('GET /sources/mercadolibre: combina matched.ml + onlyML, dedupe por sku, incluye thumbnail', async () => {
  conflictsServiceState.analysisResult = {
    mlConnected: true,
    tnConnected: true,
    matched: [{ ml: { sku: 'SKU1', title: 'Coincidente', thumbnail: 'https://ml/x.jpg' }, tn: { sku: 'SKU1', productName: 'Coincidente TN' } }],
    onlyML: [
      { sku: 'SKU2', title: 'Solo ML', thumbnail: null },
      { sku: 'SKU1', title: 'Duplicado, no debe pisar el primero' },
    ],
    onlyTN: [],
  };
  const res = await fetch(`${baseUrl}/sources/mercadolibre`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, [
    { sku: 'SKU1', label: 'Coincidente', thumbnail: 'https://ml/x.jpg' },
    { sku: 'SKU2', label: 'Solo ML', thumbnail: null },
  ]);
});

test('GET /sources/mercadolibre: si getAnalysis lanza → 500', async () => {
  conflictsServiceState.analysisError = new Error('boom');
  const res = await fetch(`${baseUrl}/sources/mercadolibre`);
  assert.equal(res.status, 500);
});

test('GET /sources/tiendanube: TN no conectado → 401', async () => {
  conflictsServiceState.analysisResult = { mlConnected: true, tnConnected: false, matched: [], onlyML: [], onlyTN: [] };
  const res = await fetch(`${baseUrl}/sources/tiendanube`);
  assert.equal(res.status, 401);
});

test('GET /sources/tiendanube: combina matched.tn + onlyTN, incluye thumbnail', async () => {
  conflictsServiceState.analysisResult = {
    mlConnected: true,
    tnConnected: true,
    matched: [{ ml: { sku: 'SKU1', title: 'Coincidente ML' }, tn: { sku: 'SKU1', productName: 'Coincidente', thumbnail: 'https://tn/x.jpg' } }],
    onlyML: [],
    onlyTN: [{ sku: 'SKU3', productName: 'Solo TN', thumbnail: null }],
  };
  const res = await fetch(`${baseUrl}/sources/tiendanube`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, [
    { sku: 'SKU1', label: 'Coincidente', thumbnail: 'https://tn/x.jpg' },
    { sku: 'SKU3', label: 'Solo TN', thumbnail: null },
  ]);
});

test('GET /sources/tiendanube: si getAnalysis lanza → 500', async () => {
  conflictsServiceState.analysisError = new Error('boom');
  const res = await fetch(`${baseUrl}/sources/tiendanube`);
  assert.equal(res.status, 500);
});
