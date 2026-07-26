/**
 * Tests de syncService.js: los dos bugs de esta sesión.
 *
 * 1) ensureSkuResolved: si el mapeo SKU→canal (store.js) está vacío (ej. tras reiniciar el
 *    backend, antes de visitar Conflictos/Precio y Stock), las funciones de descuento/restauración
 *    deben refrescarlo automáticamente vía getAnalysis() en vez de fallar con "SKU no vinculado".
 * 2) onTiendaNubeOrderPaid / onTiendaNubeOrderCancelled ya no cortan antes de tiempo con un chequeo
 *    redundante de getMlItemBySku — dejan que deductStockMercadoLibre/restoreStockMercadoLibre (que
 *    tienen el fallback de (1)) decidan si el SKU está resuelto o no.
 *
 * Mockeamos:
 * - '../src/db.js' (getSyncEnabled, insertAuditLog, enqueueMlTask, waitForMlTask) — no hay Postgres real.
 * - '../src/services/conflictsService.js' (getAnalysis) — ensureSkuResolved lo importa dinámicamente.
 * - global fetch + 'node-fetch' — deductStockTiendaNube/restoreStockTiendaNube pegan directo a la
 *   API de TN (fetch global para el GET, tiendanube.js/node-fetch para el PUT vía updateVariant*).
 */
import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setResolutionFromAnalysis, addResolution, tokens } from '../src/store.js';

const dbState = {
  syncEnabled: true,
  auditLogs: [],
  enqueuedTasks: [],
  taskStatuses: new Map(),
  pendingReturns: new Map(),
  approvedReturns: [],
  /** Claves `canal|orderId|operacion` de sync_processed_orders. */
  orderClaims: new Set(),
};

const claimKey = (channel, orderId, op) => `${channel}|${orderId}|${op}`;

const analysisState = { mappings: [] };

function makeRes({ status = 200, json = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => json,
    text: async () => JSON.stringify(json ?? {}),
  };
}

const tnFetchState = { responder: null };

let syncService;
before(async () => {
  mock.module('../src/db.js', {
    exports: {
      getSyncEnabled: async () => dbState.syncEnabled,
      insertAuditLog: async (row) => { dbState.auditLogs.push(row); },
      getPendingReturnById: async (id) => dbState.pendingReturns.get(Number(id)) ?? null,
      setReturnApproved: async (id) => { dbState.approvedReturns.push(Number(id)); return true; },
      hasOrderProcessingClaimed: async (channel, orderId, op) => dbState.orderClaims.has(claimKey(channel, orderId, op)),
      tryClaimOrderProcessing: async (channel, orderId, op) => {
        const k = claimKey(channel, orderId, op);
        if (dbState.orderClaims.has(k)) return false;
        dbState.orderClaims.add(k);
        return true;
      },
      enqueueMlTask: async (task) => {
        const id = dbState.enqueuedTasks.length + 1;
        dbState.enqueuedTasks.push({ id, ...task });
        return id;
      },
      waitForMlTask: async (taskId) => dbState.taskStatuses.get(taskId) ?? null,
      // store.js también importa estas tres desde db.js (persistencia de tokens OAuth); no las
      // usamos en estos tests pero deben existir como named export para que el import no rompa.
      getOAuthTokens: async () => null,
      setOAuthTokens: async () => {},
      hasDatabase: () => false,
    },
  });
  mock.module('../src/services/conflictsService.js', {
    exports: {
      getAnalysis: async () => ({ mappings: analysisState.mappings }),
      patchTnStock: async () => {},
      patchTnPrice: async () => {},
    },
  });
  mock.module('node-fetch', { exports: { default: (url, opts) => Promise.resolve(tnFetchState.responder(url, opts)) } });
  // deductStockTiendaNube/restoreStockTiendaNube usan el fetch global (no node-fetch) para el GET previo.
  mock.method(globalThis, 'fetch', (url, opts) => Promise.resolve(tnFetchState.responder(url, opts)));

  syncService = await import('../src/services/syncService.js');
});

beforeEach(() => {
  setResolutionFromAnalysis([], []);
  dbState.syncEnabled = true;
  dbState.auditLogs = [];
  dbState.enqueuedTasks = [];
  dbState.taskStatuses = new Map();
  dbState.pendingReturns = new Map();
  dbState.approvedReturns = [];
  dbState.orderClaims = new Set();
  analysisState.mappings = [];
  Object.assign(tokens.tiendanube, { access_token: null, store_id: null });
  tnFetchState.responder = null;
});

// ─── ensureSkuResolved (fallback cuando el mapeo en memoria está vacío) ───────

test('deductStockMercadoLibre: SKU ya resuelto en el mapeo → encola sin refrescar análisis', async () => {
  setResolutionFromAnalysis([{ sku: 'CREANDO', itemId: 'MLA1', variationId: '111' }], []);
  const out = await syncService.deductStockMercadoLibre('CREANDO', 2);
  assert.equal(out.ok, true);
  assert.equal(out.queued, true);
  assert.equal(dbState.enqueuedTasks[0].itemId, 'MLA1');
});

test('deductStockMercadoLibre: mapeo vacío pero el SKU existe en el análisis → se refresca solo y funciona', async () => {
  // Simula el backend recién reiniciado: nada en memoria todavía.
  analysisState.mappings = [
    { sku: 'CREANDO', mercadolibre: { itemId: 'MLA1', variationId: '111' }, tiendanube: { productId: 1, variantId: 2 } },
  ];
  const out = await syncService.deductStockMercadoLibre('CREANDO', 2);
  assert.equal(out.ok, true, 'debe resolver el SKU vía getAnalysis() en vez de fallar');
  assert.equal(dbState.enqueuedTasks[0].itemId, 'MLA1');
});

test('deductStockMercadoLibre: mapeo vacío y el SKU tampoco está en el análisis → falla (no está vinculado de verdad)', async () => {
  analysisState.mappings = [];
  const out = await syncService.deductStockMercadoLibre('NO-EXISTE', 2);
  assert.equal(out.ok, false);
  assert.equal(dbState.enqueuedTasks.length, 0);
});

test('deductStockTiendaNube: mapeo vacío pero resoluble vía análisis → refresca y descuenta en TN', async () => {
  analysisState.mappings = [
    { sku: 'LLUVIA', mercadolibre: { itemId: 'MLA2' }, tiendanube: { productId: 10, variantId: 20 } },
  ];
  Object.assign(tokens.tiendanube, { access_token: 'tn-token', store_id: '777' });
  tnFetchState.responder = (url, opts) => {
    if (!opts?.method || opts.method === 'GET') return makeRes({ json: { stock: 5 } });
    return makeRes({ status: 200, json: {} }); // PUT updateVariantStock
  };

  const out = await syncService.deductStockTiendaNube('LLUVIA', 2);
  assert.equal(out.ok, true);
  assert.equal(out.stockBefore, 5);
  assert.equal(out.stockAfter, 3);
});

// ─── onTiendaNubeOrderPaid / onTiendaNubeOrderCancelled: sin bail prematuro ───

test('onTiendaNubeOrderPaid: aunque el mapeo ML esté vacío, no corta antes de tiempo — deja que el fallback resuelva', async () => {
  // El SKU está resuelto del lado TN (para encontrar el SKU a partir del variant_id) pero el lado
  // ML todavía no está en el mapeo en memoria — antes, un chequeo redundante cortaba acá mismo.
  setResolutionFromAnalysis([], [{ sku: 'CREANDO', productId: 1, variantId: 42 }]);
  analysisState.mappings = [
    { sku: 'CREANDO', mercadolibre: { itemId: 'MLA1' }, tiendanube: { productId: 1, variantId: 42 } },
  ];

  const results = await syncService.onTiendaNubeOrderPaid(
    [{ variant_id: 42, quantity: 1, product_id: 1 }],
    '102',
    null
  );

  assert.equal(results.length, 1, 'debe intentar el ítem en vez de saltarlo');
  assert.equal(results[0].ok, true, 'debe terminar encolando la tarea en ML gracias al fallback');
  assert.equal(dbState.enqueuedTasks[0].itemId, 'MLA1');
});

test('onTiendaNubeOrderPaid: sincronización desactivada no descuenta nada', async () => {
  dbState.syncEnabled = false;
  const results = await syncService.onTiendaNubeOrderPaid([{ variant_id: 42, quantity: 1 }], '102', null);
  assert.deepEqual(results, []);
  assert.equal(dbState.enqueuedTasks.length, 0);
});

test('onTiendaNubeOrderCancelled: mismo fix — no corta antes de intentar restoreStockMercadoLibre', async () => {
  setResolutionFromAnalysis([], [{ sku: 'CREANDO', productId: 1, variantId: 42 }]);
  analysisState.mappings = [
    { sku: 'CREANDO', mercadolibre: { itemId: 'MLA1' }, tiendanube: { productId: 1, variantId: 42 } },
  ];

  const results = await syncService.onTiendaNubeOrderCancelled(
    [{ variant_id: 42, quantity: 1, product_id: 1 }],
    '102',
    null
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
});

// ─── revertSyncAudit: espera a que la tarea encolada en ML termine ───────────

test('revertSyncAudit (canal mercadolibre): tarea encolada termina "done" → ok true', async () => {
  setResolutionFromAnalysis([{ sku: 'CREANDO', itemId: 'MLA1' }], []);
  // enqueueMlTask asigna id 1 a la primera tarea encolada en este test.
  dbState.taskStatuses.set(1, { status: 'done' });

  const result = await syncService.revertSyncAudit({ sku: 'CREANDO', quantity: 2, updatedChannel: 'mercadolibre' });
  assert.equal(result.ok, true);
});

test('revertSyncAudit (canal mercadolibre): tarea encolada termina "failed" → ok false con el error real', async () => {
  setResolutionFromAnalysis([{ sku: 'CREANDO', itemId: 'MLA1' }], []);
  dbState.taskStatuses.set(1, { status: 'failed', lastError: 'ML devolvió 500' });

  const result = await syncService.revertSyncAudit({ sku: 'CREANDO', quantity: 2, updatedChannel: 'mercadolibre' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'ML devolvió 500');
});

test('revertSyncAudit: SKU o cantidad inválidos no llega a resolver nada', async () => {
  const result = await syncService.revertSyncAudit({ sku: '', quantity: 2, updatedChannel: 'mercadolibre' });
  assert.equal(result.ok, false);
  assert.equal(dbState.enqueuedTasks.length, 0);
});

test('revertSyncAudit: canal no reconocido devuelve error explícito', async () => {
  const result = await syncService.revertSyncAudit({ sku: 'X', quantity: 1, updatedChannel: 'otro' });
  assert.equal(result.ok, false);
  assert.match(result.error, /canal/i);
});

// ─── revertSyncAudit: la dirección de la reversión depende del movimiento original ──

test('revertSyncAudit (tiendanube, venta — el movimiento original restó stock): revertir SUMA', async () => {
  analysisState.mappings = [
    { sku: 'LLUVIA', mercadolibre: { itemId: 'MLA2' }, tiendanube: { productId: 10, variantId: 20 } },
  ];
  Object.assign(tokens.tiendanube, { access_token: 'tn-token', store_id: '777' });
  let putBody = null;
  tnFetchState.responder = (url, opts) => {
    if (!opts?.method || opts.method === 'GET') return makeRes({ json: { stock: 5 } });
    putBody = JSON.parse(opts.body);
    return makeRes({ status: 200, json: {} });
  };

  const result = await syncService.revertSyncAudit({
    sku: 'LLUVIA', quantity: 2, updatedChannel: 'tiendanube', stockBefore: 10, stockAfter: 8
  });

  assert.equal(result.ok, true);
  assert.equal(putBody.stock, 7, 'GET devolvió stock=5; al sumar 2 (revertir una venta) debe quedar en 7');
});

test('revertSyncAudit (tiendanube, cancelación — el movimiento original sumó stock): revertir DESCUENTA', async () => {
  analysisState.mappings = [
    { sku: 'LLUVIA', mercadolibre: { itemId: 'MLA2' }, tiendanube: { productId: 10, variantId: 20 } },
  ];
  Object.assign(tokens.tiendanube, { access_token: 'tn-token', store_id: '777' });
  let putBody = null;
  tnFetchState.responder = (url, opts) => {
    if (!opts?.method || opts.method === 'GET') return makeRes({ json: { stock: 5 } });
    putBody = JSON.parse(opts.body);
    return makeRes({ status: 200, json: {} });
  };

  const result = await syncService.revertSyncAudit({
    sku: 'LLUVIA', quantity: 2, updatedChannel: 'tiendanube', stockBefore: 8, stockAfter: 10
  });

  assert.equal(result.ok, true);
  assert.equal(putBody.stock, 3, 'GET devolvió stock=5; al descontar 2 (revertir una cancelación) debe quedar en 3');
});

test('revertSyncAudit (mercadolibre, venta — el movimiento original restó stock): encola delta positivo (suma)', async () => {
  setResolutionFromAnalysis([{ sku: 'CREANDO', itemId: 'MLA1' }], []);
  dbState.taskStatuses.set(1, { status: 'done' });

  const result = await syncService.revertSyncAudit({
    sku: 'CREANDO', quantity: 2, updatedChannel: 'mercadolibre', stockBefore: 10, stockAfter: 8
  });

  assert.equal(result.ok, true);
  assert.equal(dbState.enqueuedTasks[0].targetQty, 2);
});

test('revertSyncAudit (mercadolibre, cancelación — el movimiento original sumó stock): encola delta negativo (descuenta)', async () => {
  setResolutionFromAnalysis([{ sku: 'CREANDO', itemId: 'MLA1' }], []);
  dbState.taskStatuses.set(1, { status: 'done' });

  const result = await syncService.revertSyncAudit({
    sku: 'CREANDO', quantity: 2, updatedChannel: 'mercadolibre', stockBefore: 8, stockAfter: 10
  });

  assert.equal(result.ok, true);
  assert.equal(dbState.enqueuedTasks[0].targetQty, -2);
});

// ─── approvePendingReturn: que el flujo manual y el automático no sumen stock dos veces ──────

test('approvePendingReturn: si el webhook ya restauró esa orden, se niega en vez de sumar de nuevo', async () => {
  setResolutionFromAnalysis([{ sku: 'CREANDO', itemId: 'MLA1' }], []);
  dbState.pendingReturns.set(1, {
    id: 1, orderId: '2000009999', saleOrderId: '2000017283879110',
    itemId: 'MLA1', variationId: null, sku: 'CREANDO', quantity: 1, status: 'pending',
  });
  // La cancelación de esa orden ya pasó por la restauración automática.
  dbState.orderClaims.add(claimKey('mercadolibre', '2000017283879110', 'restore'));

  const result = await syncService.approvePendingReturn(1);

  assert.equal(result.ok, false);
  assert.match(result.error, /ya se había restaurado/);
  assert.equal(dbState.enqueuedTasks.length, 0, 'no debería encolar ninguna actualización de stock');
  assert.deepEqual(dbState.approvedReturns, [], 'la devolución debe seguir pendiente');
});

test('approvePendingReturn: el chequeo usa sale_order_id, no el nro de venta (pack)', async () => {
  setResolutionFromAnalysis([{ sku: 'CREANDO', itemId: 'MLA1' }], []);
  dbState.pendingReturns.set(2, {
    id: 2, orderId: '2000009999', saleOrderId: '2000017283879110',
    itemId: 'MLA1', variationId: null, sku: 'CREANDO', quantity: 1, status: 'pending',
  });
  // Claim tomado contra el pack: NO es la orden individual, así que no debe frenar la aprobación.
  dbState.orderClaims.add(claimKey('mercadolibre', '2000009999', 'restore'));
  dbState.taskStatuses.set(1, { status: 'done' });

  const result = await syncService.approvePendingReturn(2);

  assert.equal(result.ok, true);
  assert.equal(dbState.enqueuedTasks.length, 1);
});

test('approvePendingReturn: al aprobar deja la marca return_restore para frenar al webhook', async () => {
  setResolutionFromAnalysis([{ sku: 'CREANDO', itemId: 'MLA1' }], []);
  dbState.pendingReturns.set(3, {
    id: 3, orderId: '2000009999', saleOrderId: '2000017283879110',
    itemId: 'MLA1', variationId: null, sku: 'CREANDO', quantity: 1, status: 'pending',
  });
  dbState.taskStatuses.set(1, { status: 'done' });

  const result = await syncService.approvePendingReturn(3);

  assert.equal(result.ok, true);
  assert.ok(dbState.orderClaims.has(claimKey('mercadolibre', '2000017283879110', 'return_restore')));
  assert.deepEqual(dbState.approvedReturns, [3]);
});

test('approvePendingReturn: una orden con dos ítems se puede aprobar dos veces (no se auto-bloquea)', async () => {
  setResolutionFromAnalysis([{ sku: 'CREANDO', itemId: 'MLA1' }], []);
  for (const id of [4, 5]) {
    dbState.pendingReturns.set(id, {
      id, orderId: '2000009999', saleOrderId: '2000017283879110',
      itemId: 'MLA1', variationId: null, sku: 'CREANDO', quantity: 1, status: 'pending',
    });
  }
  dbState.taskStatuses.set(1, { status: 'done' });
  dbState.taskStatuses.set(2, { status: 'done' });

  assert.equal((await syncService.approvePendingReturn(4)).ok, true);
  assert.equal((await syncService.approvePendingReturn(5)).ok, true, 'la marca return_restore del primero no debe frenar al segundo');
  assert.deepEqual(dbState.approvedReturns, [4, 5]);
});
