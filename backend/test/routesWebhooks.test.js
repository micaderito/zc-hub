/**
 * Tests de routes/webhooks.js: POST /api/webhooks/mercadolibre y /api/webhooks/tiendanube.
 * Mismo patrón que los otros tests de rutas: Express real + fetch nativo, todo lo demás mockeado.
 *
 * Nota: el archivo arma un setInterval(…, 60_000) a nivel de módulo para reprocesar órdenes ML
 * pendientes por 429; ya viene con `.unref()` en el código de producción, así que no hace falta
 * nada especial acá para que el proceso de test termine solo.
 *
 * processClaimToPendingReturns se importa desde './sync.js' (mismo router de /api/sync). En vez
 * de levantar todas las dependencias de sync.js, mockeamos ese named export directo — webhooks.js
 * solo usa esa función del módulo.
 */
import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const storeState = {
  tokens: { mercadolibre: { user_id: 999 }, tiendanube: { access_token: null, store_id: null } },
  resolvedSkus: ['X'],
  mlToken: 'ml-tok',
  setMlInvalidCalls: [],
};

const dbState = {
  hasDb: true,
  claimCalls: [],
  claimed: true,
  hasProcessed: false,
  hasPendingReturn: false,
};

const mlState = {
  order: null,
  ordersSearchResult: { results: [] },
  claim: null,
  getOrderError: null,
};
const tnState = { order: null };

const syncServiceState = {
  onMlPaidResults: [],
  onMlCancelledResults: [],
  onTnPaidCalls: [],
  onTnCancelledCalls: [],
};

const syncRouteState = { processClaimResult: { created: 0, skipped: 0 } };
const conflictsServiceState = { getAnalysisCalls: 0, refreshItemCalls: [], refreshTnProductCalls: [] };

let app, server, baseUrl;

before(async () => {
  mock.module('../src/store.js', {
    exports: {
      tokens: storeState.tokens,
      getResolvedSkus: () => storeState.resolvedSkus,
      getMlToken: async () => storeState.mlToken,
      setMlTokenKnownInvalid: (v) => storeState.setMlInvalidCalls.push(v),
    },
  });
  mock.module('../src/lib/mercadolibre.js', {
    exports: {
      getOrder: async () => {
        if (mlState.getOrderError) throw mlState.getOrderError;
        return mlState.order;
      },
      getOrdersSearch: async () => mlState.ordersSearchResult,
      getClaim: async () => mlState.claim,
      getClaimsSearch: async () => ({ data: [] }),
    },
  });
  mock.module('../src/lib/tiendanube.js', {
    exports: { getOrder: async () => tnState.order },
  });
  mock.module('../src/services/conflictsService.js', {
    exports: {
      getAnalysis: async () => { conflictsServiceState.getAnalysisCalls++; return {}; },
      refreshMlItemInSnapshot: async (...a) => { conflictsServiceState.refreshItemCalls.push(a); },
      refreshTnProductInSnapshot: async (...a) => { conflictsServiceState.refreshTnProductCalls.push(a); },
    },
  });
  mock.module('../src/db.js', {
    exports: {
      tryClaimOrderProcessing: async (...args) => { dbState.claimCalls.push(['tryClaim', ...args]); return dbState.claimed; },
      hasOrderProcessingClaimed: async () => dbState.hasProcessed,
      releaseOrderProcessingClaim: async (...args) => { dbState.claimCalls.push(['release', ...args]); return true; },
      hasDatabase: () => dbState.hasDb,
      hasPendingReturnForOrder: async () => dbState.hasPendingReturn,
    },
  });
  mock.module('../src/services/syncService.js', {
    exports: {
      onMercadoLibreOrderPaid: async () => syncServiceState.onMlPaidResults,
      onMercadoLibreOrderCancelled: async () => syncServiceState.onMlCancelledResults,
      onTiendaNubeOrderPaid: async (...args) => { syncServiceState.onTnPaidCalls.push(args); return []; },
      onTiendaNubeOrderCancelled: async (...args) => { syncServiceState.onTnCancelledCalls.push(args); return []; },
    },
  });
  mock.module('../src/routes/sync.js', {
    exports: { processClaimToPendingReturns: async () => syncRouteState.processClaimResult },
  });

  const { webhookRoutes } = await import('../src/routes/webhooks.js');
  app = express();
  app.use(express.json());
  app.use('/api/webhooks', webhookRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/webhooks`;
});

after(() => { server.close(); });

beforeEach(() => {
  storeState.tokens.mercadolibre = { user_id: 999 };
  storeState.tokens.tiendanube = { access_token: null, store_id: null };
  storeState.resolvedSkus = ['X'];
  storeState.mlToken = 'ml-tok';
  storeState.setMlInvalidCalls = [];
  dbState.hasDb = true;
  dbState.claimCalls = [];
  dbState.claimed = true;
  dbState.hasProcessed = false;
  dbState.hasPendingReturn = false;
  mlState.order = null;
  mlState.ordersSearchResult = { results: [] };
  mlState.claim = null;
  mlState.getOrderError = null;
  tnState.order = null;
  syncServiceState.onMlPaidResults = [];
  syncServiceState.onMlCancelledResults = [];
  syncServiceState.onTnPaidCalls = [];
  syncServiceState.onTnCancelledCalls = [];
  syncRouteState.processClaimResult = { created: 0, skipped: 0 };
  conflictsServiceState.getAnalysisCalls = 0;
  conflictsServiceState.refreshItemCalls = [];
  conflictsServiceState.refreshTnProductCalls = [];
  delete process.env.TN_CLIENT_SECRET;
});

function postJson(path, body) {
  return fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

// ─── POST /mercadolibre ─────────────────────────────────────────────────────

test('topic distinto de orders/claims responde 200 sin hacer nada', async () => {
  const res = await postJson('/mercadolibre', { topic: 'items', resource: '123' });
  assert.equal(res.status, 200);
});

test('topic orders sin resource válido responde 200', async () => {
  const res = await postJson('/mercadolibre', { topic: 'orders', resource: '' });
  assert.equal(res.status, 200);
});

test('topic orders sin token ML responde 200', async () => {
  storeState.mlToken = null;
  const res = await postJson('/mercadolibre', { topic: 'orders', resource: '/orders/555' });
  assert.equal(res.status, 200);
});

test('topic orders: orden paid dentro de la ventana de tiempo, descuenta stock', async () => {
  mlState.order = {
    id: 555, status: 'paid', date_closed: new Date().toISOString(),
    order_items: [{ item: { id: 'MLA1' }, quantity: 1 }],
  };
  syncServiceState.onMlPaidResults = [{ ok: true }];
  const res = await postJson('/mercadolibre', { topic: 'orders', resource: '/orders/555' });
  assert.equal(res.status, 200);
  assert.ok(dbState.claimCalls.some((c) => c[0] === 'tryClaim' && c[3] === 'deduct'));
});

test('topic orders: orden paid pero ya procesada (idempotencia) no vuelve a descontar', async () => {
  mlState.order = {
    id: 556, status: 'paid', date_closed: new Date().toISOString(),
    order_items: [{ item: { id: 'MLA1' }, quantity: 1 }],
  };
  dbState.hasProcessed = true;
  const res = await postJson('/mercadolibre', { topic: 'orders', resource: '/orders/556' });
  assert.equal(res.status, 200);
  assert.ok(!dbState.claimCalls.some((c) => c[0] === 'tryClaim' && c[3] === 'deduct'));
});

test('topic orders: orden cancelada restaura stock', async () => {
  mlState.order = {
    id: 557, status: 'cancelled',
    order_items: [{ item: { id: 'MLA1' }, quantity: 1 }],
  };
  const res = await postJson('/mercadolibre', { topic: 'orders', resource: '/orders/557' });
  assert.equal(res.status, 200);
  assert.ok(dbState.claimCalls.some((c) => c[0] === 'tryClaim' && c[3] === 'restore'));
});

test('topic orders: orden cancelada con devolución pendiente en DB no restaura automáticamente', async () => {
  mlState.order = {
    id: 558, status: 'cancelled',
    order_items: [{ item: { id: 'MLA1' }, quantity: 1 }],
  };
  dbState.hasPendingReturn = true;
  const res = await postJson('/mercadolibre', { topic: 'orders', resource: '/orders/558' });
  assert.equal(res.status, 200);
  assert.ok(!dbState.claimCalls.some((c) => c[0] === 'tryClaim' && c[3] === 'restore'));
});

test('topic orders: sin order_items intenta fallback getOrdersSearch, si no hay nada responde 200', async () => {
  mlState.order = null;
  mlState.ordersSearchResult = { results: [] };
  const res = await postJson('/mercadolibre', { topic: 'orders', resource: '/orders/559' });
  assert.equal(res.status, 200);
});

test('topic orders: getOrder lanza 429 → encola pendiente y responde 200', async () => {
  mlState.getOrderError = Object.assign(new Error('rate limited'), { statusCode: 429 });
  const res = await postJson('/mercadolibre', { topic: 'orders', resource: '/orders/560' });
  assert.equal(res.status, 200);
});

test('topic orders: getOrder lanza error genérico → responde 200 igual (no hace loop)', async () => {
  mlState.getOrderError = new Error('boom');
  const res = await postJson('/mercadolibre', { topic: 'orders', resource: '/orders/561' });
  assert.equal(res.status, 200);
});

test('topic claims: sin claimId parseable no hace nada (200 ya enviado)', async () => {
  const res = await postJson('/mercadolibre', { topic: 'claims', resource: '' });
  assert.equal(res.status, 200);
});

test('topic claims: sin token ML no llama a processClaimToPendingReturns', async () => {
  storeState.mlToken = null;
  const res = await postJson('/mercadolibre', { topic: 'claims', resource: '/claims/1' });
  assert.equal(res.status, 200);
});

test('topic claims: claim tipo return procesa devoluciones pendientes', async () => {
  mlState.claim = { id: 1, type: 'return' };
  syncRouteState.processClaimResult = { created: 1, skipped: 0 };
  const res = await postJson('/mercadolibre', { topic: 'claims', resource: '/claims/1' });
  assert.equal(res.status, 200);
});

test('topic claims: claim que no es return se ignora', async () => {
  mlState.claim = { id: 2, type: 'mediations' };
  const res = await postJson('/mercadolibre', { topic: 'claims', resource: '/claims/2' });
  assert.equal(res.status, 200);
});

// ─── POST /tiendanube ────────────────────────────────────────────────────

test('sin id en el body, se ignora', async () => {
  const res = await postJson('/tiendanube', { event: 'order/paid' });
  assert.equal(res.status, 200);
});

test('evento no soportado se ignora', async () => {
  storeState.tokens.tiendanube = { access_token: 'tn-tok', store_id: '5' };
  const res = await postJson('/tiendanube', { event: 'category/updated', id: 1 });
  assert.equal(res.status, 200);
  assert.equal(conflictsServiceState.refreshTnProductCalls.length, 0);
});

test('product/updated: refresca ese producto en el snapshot (no re-baja el catálogo)', async () => {
  storeState.tokens.tiendanube = { access_token: 'tn-tok', store_id: '5' };
  const res = await postJson('/tiendanube', { event: 'product/updated', id: 42 });
  assert.equal(res.status, 200);
  assert.deepEqual(conflictsServiceState.refreshTnProductCalls, [['tn-tok', '5', 42]]);
});

test('sin token TN no procesa', async () => {
  const res = await postJson('/tiendanube', { event: 'order/paid', id: 1 });
  assert.equal(res.status, 200);
});

test('order/paid: refresca mapeo si está vacío y descuenta en ML', async () => {
  storeState.tokens.tiendanube = { access_token: 'tn-tok', store_id: '5' };
  storeState.resolvedSkus = [];
  tnState.order = { id: 10, number: 205, products: [{ variant_id: 1, quantity: 1 }] };
  const res = await postJson('/tiendanube', { event: 'order/paid', id: 10 });
  assert.equal(res.status, 200);
  assert.equal(conflictsServiceState.getAnalysisCalls, 1);
  assert.equal(syncServiceState.onTnPaidCalls.length, 1);
});

test('order/paid ya procesada (idempotencia) no vuelve a descontar', async () => {
  storeState.tokens.tiendanube = { access_token: 'tn-tok', store_id: '5' };
  dbState.claimed = false;
  tnState.order = { id: 11, number: 206, products: [{ variant_id: 1, quantity: 1 }] };
  const res = await postJson('/tiendanube', { event: 'order/paid', id: 11 });
  assert.equal(res.status, 200);
  assert.equal(syncServiceState.onTnPaidCalls.length, 0);
});

test('order/cancelled: nunca se descontó, no restaura', async () => {
  storeState.tokens.tiendanube = { access_token: 'tn-tok', store_id: '5' };
  dbState.hasProcessed = false; // hasOrderProcessingClaimed('deduct') false
  tnState.order = { id: 12, number: 207, products: [{ variant_id: 1, quantity: 1 }] };
  const res = await postJson('/tiendanube', { event: 'order/cancelled', id: 12 });
  assert.equal(res.status, 200);
  assert.equal(syncServiceState.onTnCancelledCalls.length, 0);
});

test('order/cancelled: se había descontado, restaura', async () => {
  storeState.tokens.tiendanube = { access_token: 'tn-tok', store_id: '5' };
  dbState.hasProcessed = true;
  dbState.claimed = true;
  tnState.order = { id: 13, number: 208, products: [{ variant_id: 1, quantity: 1 }] };
  const res = await postJson('/tiendanube', { event: 'order/cancelled', id: 13 });
  assert.equal(res.status, 200);
  assert.equal(syncServiceState.onTnCancelledCalls.length, 1);
});

test('orden TN no encontrada (getOrder null) no lanza', async () => {
  storeState.tokens.tiendanube = { access_token: 'tn-tok', store_id: '5' };
  tnState.order = null;
  const res = await postJson('/tiendanube', { event: 'order/paid', id: 14 });
  assert.equal(res.status, 200);
});
