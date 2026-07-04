/**
 * Tests de routes/sync.js: HTTP sobre /api/sync/* (config, reprocess-order, audit, prices,
 * returns, pending-tasks). No hay supertest instalado: montamos el router en un Express real,
 * lo levantamos en un puerto libre (`listen(0)`) y le pegamos con `fetch` nativo de Node.
 *
 * Mockeamos '../src/services/syncService.js', '../src/store.js', '../src/lib/mercadolibre.js',
 * '../src/lib/tiendanube.js' y '../src/db.js' — sin red ni Postgres real.
 */
import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbState = {
  hasDb: true,
  syncEnabled: true,
  auditRows: { rows: [], total: 0 },
  auditById: new Map(),
  reverted: [],
  pendingReturns: { rows: [], total: 0 },
  insertedReturns: [],
  hasPendingReturnForClaimItem: false,
  pendingTasks: { tasks: [], total: 0, activeCount: 0, failedCount: 0 },
  retryResult: true,
  waitForMlTaskResult: null,
  releaseCalls: [],
};

const storeState = {
  resolvedSkus: [],
  skuByMlItem: null,
  mlToken: 'ml-tok',
  tokens: { mercadolibre: { user_id: 999 }, tiendanube: { access_token: null, store_id: null } },
};

const syncServiceState = {
  syncPricesResult: { ml: true, tn: true },
  syncPricesError: null,
  approveResult: { ok: true, mlRestored: true, tnRestored: true },
  revertResult: { ok: true },
  onMlPaidResults: [],
  onTnPaidResults: [],
};

const mlState = {
  pack: null,
  order: null,
  claimsSearch: { data: [] },
  claim: null,
  claimReturns: null,
  item: null,
};
const tnState = { findOrderByNumberResult: null };

let app;
let server;
let baseUrl;

before(async () => {
  mock.module('../src/services/syncService.js', {
    exports: {
      syncPricesForSku: async () => {
        if (syncServiceState.syncPricesError) throw syncServiceState.syncPricesError;
        return syncServiceState.syncPricesResult;
      },
      approvePendingReturn: async () => syncServiceState.approveResult,
      revertSyncAudit: async () => syncServiceState.revertResult,
      onMercadoLibreOrderPaid: async () => syncServiceState.onMlPaidResults,
      onTiendaNubeOrderPaid: async () => syncServiceState.onTnPaidResults,
    },
  });
  mock.module('../src/store.js', {
    exports: {
      getResolvedSkus: () => storeState.resolvedSkus,
      getSkuByMlItem: () => storeState.skuByMlItem,
      getMlToken: async () => storeState.mlToken,
      tokens: storeState.tokens,
    },
  });
  mock.module('../src/lib/mercadolibre.js', {
    exports: {
      getPack: async () => mlState.pack,
      getOrder: async () => mlState.order,
      getClaimsSearch: async () => mlState.claimsSearch,
      getClaim: async () => mlState.claim,
      getClaimReturns: async () => mlState.claimReturns,
      getItem: async () => mlState.item,
      extractSkuFromItem: (item) => item?.seller_sku || null,
    },
  });
  mock.module('../src/lib/tiendanube.js', {
    exports: {
      findOrderByNumber: async () => tnState.findOrderByNumberResult,
      registerOrderWebhooks: async () => [],
    },
  });
  mock.module('../src/db.js', {
    exports: {
      getSyncEnabled: async () => dbState.syncEnabled,
      setSyncEnabled: async (v) => { dbState.syncEnabled = v; },
      getAuditLog: async () => dbState.auditRows,
      getAuditRowById: async (id) => dbState.auditById.get(id) ?? null,
      setAuditReverted: async (id) => { dbState.reverted.push(id); return true; },
      hasDatabase: () => dbState.hasDb,
      getPendingReturns: async () => dbState.pendingReturns,
      insertPendingReturn: async (row) => { const r = { id: dbState.insertedReturns.length + 1, ...row }; dbState.insertedReturns.push(r); return r; },
      hasPendingReturnForClaimItem: async () => dbState.hasPendingReturnForClaimItem,
      releaseOrderProcessingClaim: async (...args) => { dbState.releaseCalls.push(args); return true; },
      getPendingMlTasks: async () => dbState.pendingTasks,
      retryMlTask: async () => dbState.retryResult,
      waitForMlTask: async () => dbState.waitForMlTaskResult,
    },
  });

  const { syncRoutes } = await import('../src/routes/sync.js');
  app = express();
  app.use(express.json());
  app.use('/api/sync', syncRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/sync`;
});

after(() => {
  server.close();
});

beforeEach(() => {
  dbState.hasDb = true;
  dbState.syncEnabled = true;
  dbState.auditRows = { rows: [], total: 0 };
  dbState.auditById = new Map();
  dbState.reverted = [];
  dbState.pendingReturns = { rows: [], total: 0 };
  dbState.insertedReturns = [];
  dbState.hasPendingReturnForClaimItem = false;
  dbState.pendingTasks = { tasks: [], total: 0, activeCount: 0, failedCount: 0 };
  dbState.retryResult = true;
  dbState.waitForMlTaskResult = null;
  dbState.releaseCalls = [];
  storeState.resolvedSkus = [];
  storeState.skuByMlItem = null;
  storeState.mlToken = 'ml-tok';
  storeState.tokens.mercadolibre = { user_id: 999 };
  storeState.tokens.tiendanube = { access_token: null, store_id: null };
  syncServiceState.syncPricesResult = { ml: true, tn: true };
  syncServiceState.syncPricesError = null;
  syncServiceState.approveResult = { ok: true, mlRestored: true, tnRestored: true };
  syncServiceState.revertResult = { ok: true };
  syncServiceState.onMlPaidResults = [];
  syncServiceState.onTnPaidResults = [];
  mlState.pack = null;
  mlState.order = null;
  mlState.claimsSearch = { data: [] };
  mlState.claim = null;
  mlState.claimReturns = null;
  mlState.item = null;
  tnState.findOrderByNumberResult = null;
});

// ─── GET/PATCH /config ──────────────────────────────────────────────────────

test('GET /config: devuelve enabled y hasDatabase', async () => {
  const res = await fetch(`${baseUrl}/config`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { enabled: true, hasDatabase: true });
});

test('PATCH /config: sin DB → 503', async () => {
  dbState.hasDb = false;
  const res = await fetch(`${baseUrl}/config`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
  assert.equal(res.status, 503);
});

test('PATCH /config: con DB actualiza y devuelve enabled', async () => {
  const res = await fetch(`${baseUrl}/config`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { enabled: false });
});

// ─── POST /reprocess-order ──────────────────────────────────────────────────

test('POST /reprocess-order: sin packId → 400', async () => {
  const res = await fetch(`${baseUrl}/reprocess-order`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  assert.equal(res.status, 400);
});

test('POST /reprocess-order: sin DB → 503', async () => {
  dbState.hasDb = false;
  const res = await fetch(`${baseUrl}/reprocess-order`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packId: '123' }) });
  assert.equal(res.status, 503);
});

test('POST /reprocess-order: sync desactivada → 400', async () => {
  dbState.syncEnabled = false;
  const res = await fetch(`${baseUrl}/reprocess-order`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packId: '123' }) });
  assert.equal(res.status, 400);
});

test('POST /reprocess-order: encuentra pack en ML y sincroniza', async () => {
  mlState.pack = { orders: [{ id: 555 }] };
  mlState.order = { id: 555, order_items: [{ item: { id: 'MLA1' }, quantity: 1 }] };
  syncServiceState.onMlPaidResults = [{ ok: true }];
  const res = await fetch(`${baseUrl}/reprocess-order`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packId: '123' }) });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.itemsSynced, 1);
});

test('POST /reprocess-order: no está en ML, se encuentra en TN', async () => {
  mlState.pack = null;
  mlState.order = null;
  storeState.tokens.tiendanube = { access_token: 'tn-tok', store_id: '5' };
  tnState.findOrderByNumberResult = { id: 9, number: 205, products: [{ variant_id: 1, quantity: 1 }] };
  syncServiceState.onTnPaidResults = [{ ok: true, queued: true, taskId: 1 }];
  const res = await fetch(`${baseUrl}/reprocess-order`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packId: '205' }) });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.itemsSynced, 1);
});

test('POST /reprocess-order: no se encuentra en ningún canal → 404', async () => {
  const res = await fetch(`${baseUrl}/reprocess-order`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packId: '999999' }) });
  assert.equal(res.status, 404);
});

test('POST /reprocess-order: se encuentra pero no sincroniza nada → 400', async () => {
  mlState.pack = { orders: [{ id: 555 }] };
  mlState.order = { id: 555, order_items: [{ item: { id: 'MLA1' }, quantity: 1 }] };
  syncServiceState.onMlPaidResults = [];
  const res = await fetch(`${baseUrl}/reprocess-order`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packId: '123' }) });
  assert.equal(res.status, 400);
});

// ─── GET /audit, POST /audit/:id/revert ─────────────────────────────────────

test('GET /audit: devuelve rows y total', async () => {
  dbState.auditRows = { rows: [{ id: 1 }], total: 1 };
  const res = await fetch(`${baseUrl}/audit?limit=10&offset=0`);
  const body = await res.json();
  assert.deepEqual(body, { rows: [{ id: 1 }], total: 1 });
});

test('POST /audit/:id/revert: id inválido → 400', async () => {
  const res = await fetch(`${baseUrl}/audit/abc/revert`, { method: 'POST' });
  assert.equal(res.status, 400);
});

test('POST /audit/:id/revert: registro no encontrado → 404', async () => {
  const res = await fetch(`${baseUrl}/audit/1/revert`, { method: 'POST' });
  assert.equal(res.status, 404);
});

test('POST /audit/:id/revert: ya revertido → 400', async () => {
  dbState.auditById.set(1, { id: 1, revertedAt: new Date() });
  const res = await fetch(`${baseUrl}/audit/1/revert`, { method: 'POST' });
  assert.equal(res.status, 400);
});

test('POST /audit/:id/revert: revierte con éxito', async () => {
  dbState.auditById.set(1, { id: 1, revertedAt: null, sku: 'X', quantity: 1, updatedChannel: 'mercadolibre' });
  const res = await fetch(`${baseUrl}/audit/1/revert`, { method: 'POST' });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { ok: true });
  assert.deepEqual(dbState.reverted, [1]);
});

test('POST /audit/:id/revert: revertSyncAudit falla → 502', async () => {
  dbState.auditById.set(2, { id: 2, revertedAt: null, sku: 'X', quantity: 1, updatedChannel: 'mercadolibre' });
  syncServiceState.revertResult = { ok: false, error: 'no se pudo' };
  const res = await fetch(`${baseUrl}/audit/2/revert`, { method: 'POST' });
  assert.equal(res.status, 502);
});

// ─── prices ─────────────────────────────────────────────────────────────────

test('POST /prices/:sku: sincroniza un SKU', async () => {
  const res = await fetch(`${baseUrl}/prices/SKU1`, { method: 'POST' });
  const body = await res.json();
  assert.deepEqual(body, { ml: true, tn: true });
});

test('POST /prices/:sku: si syncPricesForSku lanza → 500', async () => {
  syncServiceState.syncPricesError = new Error('boom');
  const res = await fetch(`${baseUrl}/prices/SKU-ERR`, { method: 'POST' });
  assert.equal(res.status, 500);
});

test('POST /prices: sincroniza todos los SKU resueltos', async () => {
  storeState.resolvedSkus = ['A', 'B'];
  const res = await fetch(`${baseUrl}/prices`, { method: 'POST' });
  const body = await res.json();
  assert.ok(body.A);
  assert.ok(body.B);
});

// ─── returns ────────────────────────────────────────────────────────────────

test('GET /returns: devuelve rows y total', async () => {
  dbState.pendingReturns = { rows: [{ id: 1 }], total: 1 };
  const res = await fetch(`${baseUrl}/returns`);
  const body = await res.json();
  assert.deepEqual(body, { rows: [{ id: 1 }], total: 1 });
});

test('POST /returns/fetch: sin token ML → 401', async () => {
  storeState.mlToken = null;
  const res = await fetch(`${baseUrl}/returns/fetch`, { method: 'POST' });
  assert.equal(res.status, 401);
});

test('POST /returns/fetch: sin DB → 503', async () => {
  dbState.hasDb = false;
  const res = await fetch(`${baseUrl}/returns/fetch`, { method: 'POST' });
  assert.equal(res.status, 503);
});

test('POST /returns/fetch: sin claims, created=0 skipped=0', async () => {
  mlState.claimsSearch = { data: [] };
  const res = await fetch(`${baseUrl}/returns/fetch`, { method: 'POST' });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.created, 0);
  assert.equal(body.skipped, 0);
});

test('POST /returns: packId requerido → 400', async () => {
  const res = await fetch(`${baseUrl}/returns`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  assert.equal(res.status, 400);
});

test('POST /returns: sin token ML → 401', async () => {
  storeState.mlToken = null;
  const res = await fetch(`${baseUrl}/returns`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packId: '123' }) });
  assert.equal(res.status, 401);
});

test('POST /returns: pack no encontrado → 404', async () => {
  mlState.pack = null;
  mlState.order = null;
  const res = await fetch(`${baseUrl}/returns`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packId: '123' }) });
  assert.equal(res.status, 404);
});

test('POST /returns: carga devoluciones de un pack con éxito → 201', async () => {
  mlState.pack = { orders: [{ id: 1 }] };
  mlState.order = { id: 1, order_items: [{ item: { id: 'MLA1', title: 'Cuaderno' }, quantity: 1 }] };
  const res = await fetch(`${baseUrl}/returns`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packId: '123' }) });
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.equal(body.created, 1);
});

test('POST /returns/:id/approve: id inválido → 400', async () => {
  const res = await fetch(`${baseUrl}/returns/abc/approve`, { method: 'POST' });
  assert.equal(res.status, 400);
});

test('POST /returns/:id/approve: aprueba con éxito', async () => {
  const res = await fetch(`${baseUrl}/returns/1/approve`, { method: 'POST' });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
});

test('POST /returns/:id/approve: falla → 400 con detalle', async () => {
  syncServiceState.approveResult = { ok: false, error: 'no se pudo', mlRestored: false, tnRestored: false };
  const res = await fetch(`${baseUrl}/returns/1/approve`, { method: 'POST' });
  assert.equal(res.status, 400);
});

// ─── pending-tasks ──────────────────────────────────────────────────────────

test('GET /pending-tasks: sin DB → 503', async () => {
  dbState.hasDb = false;
  const res = await fetch(`${baseUrl}/pending-tasks`);
  assert.equal(res.status, 503);
});

test('GET /pending-tasks: devuelve tasks', async () => {
  dbState.pendingTasks = { tasks: [{ id: 1 }], total: 1, activeCount: 1, failedCount: 0 };
  const res = await fetch(`${baseUrl}/pending-tasks`);
  const body = await res.json();
  assert.equal(body.total, 1);
});

test('POST /pending-tasks/:id/retry: id inválido → 400', async () => {
  const res = await fetch(`${baseUrl}/pending-tasks/abc/retry`, { method: 'POST' });
  assert.equal(res.status, 400);
});

test('POST /pending-tasks/:id/retry: sin DB → 503', async () => {
  dbState.hasDb = false;
  const res = await fetch(`${baseUrl}/pending-tasks/1/retry`, { method: 'POST' });
  assert.equal(res.status, 503);
});

test('POST /pending-tasks/:id/retry: no encontrada → 404', async () => {
  dbState.retryResult = false;
  const res = await fetch(`${baseUrl}/pending-tasks/1/retry`, { method: 'POST' });
  assert.equal(res.status, 404);
});

test('POST /pending-tasks/:id/retry: reintenta con éxito', async () => {
  dbState.retryResult = true;
  const res = await fetch(`${baseUrl}/pending-tasks/1/retry`, { method: 'POST' });
  const body = await res.json();
  assert.deepEqual(body, { ok: true });
});

// ─── register-webhooks ──────────────────────────────────────────────────────

test('POST /register-webhooks: sin WEBHOOK_BASE_URL → 400', async () => {
  delete process.env.WEBHOOK_BASE_URL;
  const res = await fetch(`${baseUrl}/register-webhooks`, { method: 'POST' });
  assert.equal(res.status, 400);
});

test('POST /register-webhooks: sin TN conectada → 401', async () => {
  process.env.WEBHOOK_BASE_URL = 'https://example.com';
  storeState.tokens.tiendanube = { access_token: null, store_id: null };
  const res = await fetch(`${baseUrl}/register-webhooks`, { method: 'POST' });
  assert.equal(res.status, 401);
  delete process.env.WEBHOOK_BASE_URL;
});
