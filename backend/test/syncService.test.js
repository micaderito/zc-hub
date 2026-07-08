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
};

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
      getPendingReturnById: async () => null,
      setReturnApproved: async () => true,
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
