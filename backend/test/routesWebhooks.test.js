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
  /** hasOrderProcessingClaimed('deduct'): la orden llegó a descontar stock. */
  hasProcessed: false,
  /** hasOrderProcessingClaimed('return_restore'): ya se aprobó una devolución de esta orden. */
  hasReturnRestored: false,
  hasPendingReturn: false,
};

const mlState = {
  order: null,
  ordersSearchResult: { results: [] },
  claim: null,
  getOrderError: null,
  shipment: null,
  getShipmentCalls: [],
  getShipmentError: null,
};
const tnState = { order: null };

const syncServiceState = {
  onMlPaidResults: [],
  onMlCancelledResults: [],
  onTnPaidCalls: [],
  onTnCancelledCalls: [],
};

const syncRouteState = { processClaimResult: { created: 0, skipped: 0 }, pendingReturnCalls: [] };
const conflictsServiceState = { getAnalysisCalls: 0, refreshItemCalls: [], refreshTnProductCalls: [] };

let app, server, baseUrl, resetShipmentCache, processNextPendingMlOrder;

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
      getShipment: async (_tok, id) => {
        mlState.getShipmentCalls.push(String(id));
        if (mlState.getShipmentError) throw mlState.getShipmentError;
        return mlState.shipment;
      },
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
      hasOrderProcessingClaimed: async (_channel, _orderId, op) => (
        op === 'return_restore' ? dbState.hasReturnRestored : dbState.hasProcessed
      ),
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
    exports: {
      processClaimToPendingReturns: async () => syncRouteState.processClaimResult,
      insertPendingReturnsForOrder: async (_tok, order, opts) => {
        syncRouteState.pendingReturnCalls.push({ orderId: order?.id, opts });
        return { created: (order?.order_items ?? []).length, skipped: 0, rows: [] };
      },
    },
  });

  const mod = await import('../src/routes/webhooks.js');
  const { webhookRoutes } = mod;
  resetShipmentCache = mod.__resetShipmentCacheForTests;
  processNextPendingMlOrder = mod.processNextPendingMlOrder;
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
  dbState.hasReturnRestored = false;
  dbState.hasPendingReturn = false;
  mlState.order = null;
  mlState.ordersSearchResult = { results: [] };
  mlState.claim = null;
  mlState.getOrderError = null;
  mlState.shipment = null;
  mlState.getShipmentCalls = [];
  mlState.getShipmentError = null;
  resetShipmentCache();
  tnState.order = null;
  syncServiceState.onMlPaidResults = [];
  syncServiceState.onMlCancelledResults = [];
  syncServiceState.onTnPaidCalls = [];
  syncServiceState.onTnCancelledCalls = [];
  syncRouteState.processClaimResult = { created: 0, skipped: 0 };
  syncRouteState.pendingReturnCalls = [];
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

test('topic orders: orden cancelada antes del despacho que sí se había descontado, restaura stock', async () => {
  mlState.order = {
    id: 557, status: 'cancelled', shipping: { id: 44557 },
    order_items: [{ item: { id: 'MLA1' }, quantity: 1 }],
  };
  mlState.shipment = { id: 44557, status: 'ready_to_ship', substatus: 'printed' };
  dbState.hasProcessed = true; // simula que la orden llegó a pagarse y descontar stock antes de cancelarse
  const res = await postJson('/mercadolibre', { topic: 'orders', resource: '/orders/557' });
  assert.equal(res.status, 200);
  assert.ok(dbState.claimCalls.some((c) => c[0] === 'tryClaim' && c[3] === 'restore'));
  assert.equal(syncRouteState.pendingReturnCalls.length, 0);
});

test('topic orders: orden cancelada que nunca se descontó (el pago ni entró) no restaura ni queda pendiente', async () => {
  mlState.order = {
    id: 557, status: 'cancelled', shipping: { id: 44557 },
    order_items: [{ item: { id: 'MLA1' }, quantity: 1 }],
  };
  const res = await postJson('/mercadolibre', { topic: 'orders', resource: '/orders/557' });
  assert.equal(res.status, 200);
  assert.ok(!dbState.claimCalls.some((c) => c[0] === 'tryClaim' && c[3] === 'restore'));
  // No hay nada que restaurar ni nada que confirmar a mano: se resuelve sola, sin ruido en la UI.
  assert.equal(syncRouteState.pendingReturnCalls.length, 0);
  assert.equal(mlState.getShipmentCalls.length, 0, 'ni siquiera hace falta consultar el envío');
});

test('topic orders: orden cancelada con devolución pendiente en DB no restaura automáticamente', async () => {
  mlState.order = {
    id: 558, status: 'cancelled',
    order_items: [{ item: { id: 'MLA1' }, quantity: 1 }],
  };
  dbState.hasProcessed = true;
  dbState.hasPendingReturn = true;
  const res = await postJson('/mercadolibre', { topic: 'orders', resource: '/orders/558' });
  assert.equal(res.status, 200);
  assert.ok(!dbState.claimCalls.some((c) => c[0] === 'tryClaim' && c[3] === 'restore'));
});

// ─── Entrega fallida: el caso de prod del 2026-07-21 ────────────────────────
// ML no abre ningún claim cuando no puede entregar: cancela la orden y devuelve el paquete al
// vendedor. Antes de este fix el stock se restauraba al toque, con la mercadería todavía en viaje.

test('topic orders: cancelada por entrega fallida (not_delivered) NO restaura, deja devolución pendiente', async () => {
  mlState.order = {
    id: 2000017283879110, status: 'cancelled', shipping: { id: 99001 },
    order_items: [{ item: { id: 'MLA1' }, quantity: 1 }],
  };
  mlState.shipment = { id: 99001, status: 'not_delivered', substatus: 'returning_to_sender' };
  dbState.hasProcessed = true;
  const res = await postJson('/mercadolibre', { topic: 'orders', resource: '/orders/2000017283879110' });
  assert.equal(res.status, 200);
  assert.ok(!dbState.claimCalls.some((c) => c[0] === 'tryClaim' && c[3] === 'restore'));
  assert.equal(syncRouteState.pendingReturnCalls.length, 1);
});

test('topic orders: cancelada con envío ya despachado tampoco restaura', async () => {
  mlState.order = {
    id: 560, status: 'cancelled', shipping: { id: 99002 },
    order_items: [{ item: { id: 'MLA1' }, quantity: 1 }],
  };
  mlState.shipment = { id: 99002, status: 'shipped', substatus: null };
  dbState.hasProcessed = true;
  const res = await postJson('/mercadolibre', { topic: 'orders', resource: '/orders/560' });
  assert.equal(res.status, 200);
  assert.ok(!dbState.claimCalls.some((c) => c[0] === 'tryClaim' && c[3] === 'restore'));
  assert.equal(syncRouteState.pendingReturnCalls.length, 1);
});

test('topic orders: envío que ML no devuelve (404, no es 429) → devolución pendiente', async () => {
  mlState.order = {
    id: 561, status: 'cancelled', shipping: { id: 99003 },
    order_items: [{ item: { id: 'MLA1' }, quantity: 1 }],
  };
  mlState.shipment = null; // getShipment devolvió null: no es un problema pasajero de rate limit
  dbState.hasProcessed = true;
  const res = await postJson('/mercadolibre', { topic: 'orders', resource: '/orders/561' });
  assert.equal(res.status, 200);
  assert.ok(!dbState.claimCalls.some((c) => c[0] === 'tryClaim' && c[3] === 'restore'));
  assert.equal(syncRouteState.pendingReturnCalls.length, 1);
});

// Una cancelación previa al despacho tiene que restaurar sola. Un 429 al consultar el envío no
// dice nada sobre la mercadería, así que se reintenta en vez de mandarla a pendientes.

test('topic orders: 429 al consultar el envío no decide nada todavía, reintenta', async () => {
  mlState.order = {
    id: 564, status: 'cancelled', shipping: { id: 99007 },
    order_items: [{ item: { id: 'MLA1' }, quantity: 1 }],
  };
  mlState.getShipmentError = Object.assign(new Error('429'), { statusCode: 429 });
  dbState.hasProcessed = true;

  const res = await postJson('/mercadolibre', { topic: 'orders', resource: '/orders/564' });
  assert.equal(res.status, 200);
  assert.ok(!dbState.claimCalls.some((c) => c[0] === 'tryClaim' && c[3] === 'restore'));
  assert.equal(syncRouteState.pendingReturnCalls.length, 0, 'no debe crear devolución pendiente por un rate limit');
});

test('topic orders: cancelación sin despachar que arrancó con 429 termina restaurando en el reintento', async () => {
  mlState.order = {
    id: 565, status: 'cancelled', shipping: { id: 99008 },
    order_items: [{ item: { id: 'MLA1' }, quantity: 1 }],
  };
  mlState.getShipmentError = Object.assign(new Error('429'), { statusCode: 429 });
  dbState.hasProcessed = true;
  await postJson('/mercadolibre', { topic: 'orders', resource: '/orders/565' });

  // ML se recupera y el worker vuelve a tomar la orden: el envío nunca se despachó.
  mlState.getShipmentError = null;
  mlState.shipment = { id: 99008, status: 'ready_to_ship', substatus: 'printed' };
  await processNextPendingMlOrder();

  assert.ok(dbState.claimCalls.some((c) => c[0] === 'tryClaim' && c[3] === 'restore'), 'debe restaurar sola');
  assert.equal(syncRouteState.pendingReturnCalls.length, 0);
});

test('topic orders: si el 429 no cede, tras agotar los reintentos queda como devolución pendiente', async () => {
  mlState.order = {
    id: 566, status: 'cancelled', shipping: { id: 99009 },
    order_items: [{ item: { id: 'MLA1' }, quantity: 1 }],
  };
  mlState.getShipmentError = Object.assign(new Error('429'), { statusCode: 429 });
  dbState.hasProcessed = true;

  await postJson('/mercadolibre', { topic: 'orders', resource: '/orders/566' });
  for (let i = 0; i < 3; i++) await processNextPendingMlOrder();

  assert.ok(!dbState.claimCalls.some((c) => c[0] === 'tryClaim' && c[3] === 'restore'));
  assert.equal(syncRouteState.pendingReturnCalls.length, 1, 'no puede quedar en el limbo: se registra para revisar a mano');
});

test('topic orders: orden cancelada sin envío asociado restaura sola (no hay paquete en viaje)', async () => {
  mlState.order = {
    id: 562, status: 'cancelled',
    order_items: [{ item: { id: 'MLA1' }, quantity: 1 }],
  };
  dbState.hasProcessed = true;
  const res = await postJson('/mercadolibre', { topic: 'orders', resource: '/orders/562' });
  assert.equal(res.status, 200);
  assert.ok(dbState.claimCalls.some((c) => c[0] === 'tryClaim' && c[3] === 'restore'));
  assert.equal(syncRouteState.pendingReturnCalls.length, 0);
  assert.equal(mlState.getShipmentCalls.length, 0, 'no hay envío que consultar');
});

test('topic orders: la devolución pendiente se guarda contra el pack, no contra la orden suelta', async () => {
  mlState.order = {
    id: 2000017283879110, pack_id: 2000009999, status: 'cancelled', shipping: { id: 99004 },
    order_items: [{ item: { id: 'MLA1' }, quantity: 1 }],
  };
  mlState.shipment = { id: 99004, status: 'not_delivered', substatus: 'returning_to_sender' };
  dbState.hasProcessed = true;
  await postJson('/mercadolibre', { topic: 'orders', resource: '/orders/2000017283879110' });
  assert.equal(syncRouteState.pendingReturnCalls[0].opts.displayOrderId, '2000009999');
});

test('topic orders: dos órdenes del mismo pack consultan el envío una sola vez', async () => {
  mlState.shipment = { id: 99005, status: 'not_delivered', substatus: 'returning_to_sender' };
  dbState.hasProcessed = true;
  for (const id of [701, 702]) {
    mlState.order = {
      id, pack_id: 700, status: 'cancelled', shipping: { id: 99005 },
      order_items: [{ item: { id: 'MLA1' }, quantity: 1 }],
    };
    await postJson('/mercadolibre', { topic: 'orders', resource: `/orders/${id}` });
  }
  assert.equal(mlState.getShipmentCalls.length, 1);
  assert.equal(syncRouteState.pendingReturnCalls.length, 2);
});

test('topic orders: si ya se aprobó una devolución de esa orden, no restaura ni recrea la pendiente', async () => {
  mlState.order = {
    id: 563, status: 'cancelled', shipping: { id: 99006 },
    order_items: [{ item: { id: 'MLA1' }, quantity: 1 }],
  };
  dbState.hasProcessed = true;
  dbState.hasReturnRestored = true;
  const res = await postJson('/mercadolibre', { topic: 'orders', resource: '/orders/563' });
  assert.equal(res.status, 200);
  assert.ok(!dbState.claimCalls.some((c) => c[0] === 'tryClaim' && c[3] === 'restore'));
  assert.equal(syncRouteState.pendingReturnCalls.length, 0);
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
