/**
 * Tests de routes/mapping.js: listar/vincular pares SKU↔canal y listar publicaciones de ML/TN
 * para mapear. GET /sources/mercadolibre pega directo con `fetch` global (no node-fetch) para
 * /users/:id/items/search — se mockea globalThis.fetch para ese caso puntual.
 */
import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const storeState = {
  resolvedMappings: [],
  tokens: { mercadolibre: { user_id: null }, tiendanube: { access_token: null, store_id: null } },
  mlToken: null,
  persistCalls: 0,
};

const syncServiceState = { persistResult: { ml: true, tn: true }, persistError: null };

const mlState = { getMeResult: null, getItemsResult: [] };
const tnState = { getProductsResult: [], getProductVariantsResult: [], getProductsError: null };

const globalFetchState = { responder: null };

let app, server, baseUrl;

before(async () => {
  mock.module('../src/store.js', {
    exports: {
      getResolvedMappings: () => storeState.resolvedMappings,
      tokens: storeState.tokens,
      getMlToken: async () => storeState.mlToken,
      persistTokens: () => { storeState.persistCalls++; },
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
  mock.module('../src/lib/mercadolibre.js', {
    exports: {
      getMe: async () => mlState.getMeResult,
      getItems: async () => mlState.getItemsResult,
    },
  });
  mock.module('../src/lib/tiendanube.js', {
    exports: {
      getProducts: async () => { if (tnState.getProductsError) throw tnState.getProductsError; return tnState.getProductsResult; },
      getProductVariants: async () => tnState.getProductVariantsResult,
    },
  });
  // mapping.js usa el fetch global (no node-fetch) para /users/:id/items/search. Pero los tests
  // también usan fetch global para pegarle al servidor Express de prueba — hay que distinguir por
  // URL y dejar pasar las llamadas al servidor local sin mockear.
  const realFetch = globalThis.fetch;
  mock.method(globalThis, 'fetch', (url, opts) => {
    if (typeof url === 'string' && url.includes('127.0.0.1')) return realFetch(url, opts);
    if (globalFetchState.responder) return Promise.resolve(globalFetchState.responder(url, opts));
    throw new Error('fetch global inesperado: ' + url);
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
  storeState.tokens.mercadolibre = { user_id: null };
  storeState.tokens.tiendanube = { access_token: null, store_id: null };
  storeState.mlToken = null;
  storeState.persistCalls = 0;
  syncServiceState.persistResult = { ml: true, tn: true };
  syncServiceState.persistError = null;
  mlState.getMeResult = null;
  mlState.getItemsResult = [];
  tnState.getProductsResult = [];
  tnState.getProductVariantsResult = [];
  tnState.getProductsError = null;
  globalFetchState.responder = null;
});

function makeRes({ status = 200, json = null } = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => json, text: async () => JSON.stringify(json ?? {}) };
}

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

test('GET /sources/mercadolibre: sin token ML → 401', async () => {
  storeState.mlToken = null;
  const res = await fetch(`${baseUrl}/sources/mercadolibre`);
  assert.equal(res.status, 401);
});

test('GET /sources/mercadolibre: sin user_id, lo obtiene con getMe', async () => {
  storeState.mlToken = 'tok';
  storeState.tokens.mercadolibre.user_id = null;
  mlState.getMeResult = { id: 777 };
  globalFetchState.responder = (url) => {
    assert.match(url, /\/users\/777\/items\/search/);
    return makeRes({ json: { results: ['MLA1'] } });
  };
  mlState.getItemsResult = [{ id: 'MLA1', title: 'X', seller_sku: 'SKU1', catalog_listing: false, variations: [] }];
  const res = await fetch(`${baseUrl}/sources/mercadolibre`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body[0].sku, 'SKU1');
  assert.equal(storeState.persistCalls, 1);
});

test('GET /sources/mercadolibre: sin poder obtener user_id → 503', async () => {
  storeState.mlToken = 'tok';
  storeState.tokens.mercadolibre.user_id = null;
  mlState.getMeResult = null;
  const res = await fetch(`${baseUrl}/sources/mercadolibre`);
  assert.equal(res.status, 503);
});

test('GET /sources/mercadolibre: filtra catalog_listing y devuelve sku/variantes', async () => {
  storeState.mlToken = 'tok';
  storeState.tokens.mercadolibre.user_id = 999;
  globalFetchState.responder = () => makeRes({ json: { results: ['MLA1', 'MLA2'] } });
  mlState.getItemsResult = [
    { id: 'MLA1', title: 'Original', seller_sku: 'SKU1', catalog_listing: false, variations: [] },
    { id: 'MLA2', title: 'Catalogo', catalog_listing: true, variations: [] },
  ];
  const res = await fetch(`${baseUrl}/sources/mercadolibre`);
  const body = await res.json();
  assert.equal(body.length, 1);
  assert.equal(body[0].id, 'MLA1');
});

test('GET /sources/mercadolibre: si la búsqueda falla → 500', async () => {
  storeState.mlToken = 'tok';
  storeState.tokens.mercadolibre.user_id = 999;
  globalFetchState.responder = () => makeRes({ status: 500, json: { message: 'error ml' } });
  const res = await fetch(`${baseUrl}/sources/mercadolibre`);
  assert.equal(res.status, 500);
});

test('GET /sources/tiendanube: sin token TN → 401', async () => {
  const res = await fetch(`${baseUrl}/sources/tiendanube`);
  assert.equal(res.status, 401);
});

test('GET /sources/tiendanube: lista productos con variantes', async () => {
  storeState.tokens.tiendanube = { access_token: 'tn-tok', store_id: '5' };
  tnState.getProductsResult = [{ id: 1, name: { es: 'Cuaderno' } }];
  tnState.getProductVariantsResult = [{ id: 10, sku: 'SKU1', price: 100, stock: 5 }];
  const res = await fetch(`${baseUrl}/sources/tiendanube`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body[0].name, 'Cuaderno');
  assert.equal(body[0].variants[0].sku, 'SKU1');
});

test('GET /sources/tiendanube: si getProducts falla → 500', async () => {
  storeState.tokens.tiendanube = { access_token: 'tn-tok', store_id: '5' };
  tnState.getProductsError = new Error('boom');
  const res = await fetch(`${baseUrl}/sources/tiendanube`);
  assert.equal(res.status, 500);
});
