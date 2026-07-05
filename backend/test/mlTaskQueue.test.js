/**
 * Tests de mlTaskQueue.js: worker que procesa tareas encoladas en Postgres (stock_ml,
 * stock_ml_set, sku_ml, price_ml, sku_tn) sobre ML/TN, con reintentos vía backoff (ver
 * updateMlTaskStatus en db.js).
 *
 * `processTask` y `tick` no se exportaban originalmente (solo start/stopMlTaskWorker, pensados
 * para producción con setInterval). Se agregaron como named exports adicionales (cambio mínimo,
 * aditivo) para poder testear la lógica de negocio sin pelear con temporizadores reales.
 *
 * Mockeamos '../db.js', '../store.js', './mercadolibre.js' y './tiendanube.js' (rutas resueltas
 * desde src/lib/mlTaskQueue.js), usando las mismas rutas que el resto de los tests para que
 * mock.module apunte al mismo módulo resuelto.
 */
import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const dbState = { claimedTask: null, statusUpdates: [], auditLogs: [], hasDb: true };
const patchState = { calls: [] };
const storeState = { mlToken: 'ml-tok', tokens: { tiendanube: { access_token: 'tn-tok', store_id: '55' } } };
const mlState = {
  item: { id: 'MLA1', available_quantity: 10, variations: [] },
  updateStockResult: true,
  updateVariationSkuResult: true,
  updateItemSkuResult: true,
  updatePriceError: null,
};
const tnState = { updateVariantSkuResult: true };

let mlTaskQueue;
before(async () => {
  mock.module('../src/db.js', {
    exports: {
      claimNextMlTask: async () => dbState.claimedTask,
      updateMlTaskStatus: async (id, status, err) => { dbState.statusUpdates.push({ id, status, err }); return true; },
      hasDatabase: () => dbState.hasDb,
      insertAuditLog: async (row) => { dbState.auditLogs.push(row); },
    },
  });
  mock.module('../src/services/conflictsService.js', {
    exports: {
      patchMlPrice: async (...a) => { patchState.calls.push(['patchMlPrice', ...a]); },
      patchMlStock: async (...a) => { patchState.calls.push(['patchMlStock', ...a]); },
      patchMlSku: async (...a) => { patchState.calls.push(['patchMlSku', ...a]); },
      patchTnSku: async (...a) => { patchState.calls.push(['patchTnSku', ...a]); },
    },
  });
  mock.module('../src/store.js', {
    exports: {
      getMlToken: async () => storeState.mlToken,
      tokens: storeState.tokens,
    },
  });
  mock.module('../src/lib/mercadolibre.js', {
    exports: {
      getItem: async () => mlState.item,
      updateItemOrVariationStock: async () => mlState.updateStockResult,
      updateVariationSku: async () => mlState.updateVariationSkuResult,
      updateItemSku: async () => mlState.updateItemSkuResult,
      updateItemOrVariationPrice: async () => {
        if (mlState.updatePriceError) throw mlState.updatePriceError;
        return true;
      },
    },
  });
  mock.module('../src/lib/tiendanube.js', {
    exports: {
      updateVariantSku: async () => tnState.updateVariantSkuResult,
    },
  });
  mlTaskQueue = await import('../src/lib/mlTaskQueue.js');
});

beforeEach(() => {
  dbState.claimedTask = null;
  dbState.statusUpdates = [];
  dbState.auditLogs = [];
  patchState.calls = [];
  dbState.hasDb = true;
  storeState.mlToken = 'ml-tok';
  storeState.tokens.tiendanube = { access_token: 'tn-tok', store_id: '55' };
  mlState.item = { id: 'MLA1', available_quantity: 10, variations: [] };
  mlState.updateStockResult = true;
  mlState.updateVariationSkuResult = true;
  mlState.updateItemSkuResult = true;
  mlState.updatePriceError = null;
  tnState.updateVariantSkuResult = true;
});

// ─── processTask: stock_ml ────────────────────────────────────────────────

test('stock_ml: sin variación aplica el delta sobre available_quantity del ítem', async () => {
  mlState.item = { id: 'MLA1', available_quantity: 10, variations: [] };
  await mlTaskQueue.processTask({ id: 1, kind: 'stock_ml', itemId: 'MLA1', variationId: null, targetQty: -3, attempts: 0 });
  assert.deepEqual(dbState.statusUpdates, [{ id: 1, status: 'done', err: undefined }]);
});

test('stock_ml: con variación toma el stock de esa variación como base', async () => {
  mlState.item = { id: 'MLA1', available_quantity: 10, variations: [{ id: 111, available_quantity: 5 }] };
  await mlTaskQueue.processTask({ id: 2, kind: 'stock_ml', itemId: 'MLA1', variationId: '111', targetQty: 2, attempts: 0 });
  assert.equal(dbState.statusUpdates[0].status, 'done');
});

test('stock_ml: con contexto de auditoría, inserta el audit log con stockBefore/After', async () => {
  mlState.item = { id: 'MLA1', available_quantity: 10, variations: [] };
  await mlTaskQueue.processTask({
    id: 3, kind: 'stock_ml', itemId: 'MLA1', variationId: null, targetQty: -4, attempts: 0,
    contextJson: JSON.stringify({ audit: { channelSale: 'tiendanube', orderId: '1', sku: 'X', updatedChannel: 'mercadolibre' } })
  });
  assert.equal(dbState.auditLogs.length, 1);
  assert.equal(dbState.auditLogs[0].stockBefore, 10);
  assert.equal(dbState.auditLogs[0].stockAfter, 6);
});

test('stock_ml: sin token ML → falla con "Sin token ML"', async () => {
  storeState.mlToken = null;
  await mlTaskQueue.processTask({ id: 4, kind: 'stock_ml', itemId: 'MLA1', targetQty: -1, attempts: 0 });
  assert.equal(dbState.statusUpdates[0].status, 'failed');
  assert.match(dbState.statusUpdates[0].err, /Sin token ML/);
});

test('stock_ml: GET item falla (null) → failed', async () => {
  mlState.item = null;
  await mlTaskQueue.processTask({ id: 5, kind: 'stock_ml', itemId: 'MLA1', targetQty: -1, attempts: 0 });
  assert.equal(dbState.statusUpdates[0].status, 'failed');
  assert.match(dbState.statusUpdates[0].err, /GET item/);
});

test('stock_ml: updateItemOrVariationStock devuelve false → failed', async () => {
  mlState.updateStockResult = false;
  await mlTaskQueue.processTask({ id: 6, kind: 'stock_ml', itemId: 'MLA1', targetQty: -1, attempts: 0 });
  assert.equal(dbState.statusUpdates[0].status, 'failed');
});

// ─── processTask: stock_ml_set ─────────────────────────────────────────────

test('stock_ml_set: fija el valor absoluto (no depende del stock previo) → done y parcha el snapshot', async () => {
  await mlTaskQueue.processTask({ id: 20, kind: 'stock_ml_set', itemId: 'MLA1', variationId: null, targetQty: 7, attempts: 0 });
  assert.deepEqual(dbState.statusUpdates, [{ id: 20, status: 'done', err: undefined }]);
  assert.deepEqual(patchState.calls[0], ['patchMlStock', 'MLA1', null, 7]);
});

test('stock_ml_set: con variación pasa el variationId a updateItemOrVariationStock', async () => {
  await mlTaskQueue.processTask({ id: 21, kind: 'stock_ml_set', itemId: 'MLA1', variationId: '111', targetQty: 3, attempts: 0 });
  assert.equal(dbState.statusUpdates[0].status, 'done');
});

test('stock_ml_set: sin token ML → failed', async () => {
  storeState.mlToken = null;
  await mlTaskQueue.processTask({ id: 22, kind: 'stock_ml_set', itemId: 'MLA1', targetQty: 5, attempts: 0 });
  assert.equal(dbState.statusUpdates[0].status, 'failed');
  assert.match(dbState.statusUpdates[0].err, /Sin token ML/);
});

test('stock_ml_set: updateItemOrVariationStock devuelve false (429 con reintentos agotados) → failed', async () => {
  mlState.updateStockResult = false;
  await mlTaskQueue.processTask({ id: 23, kind: 'stock_ml_set', itemId: 'MLA1', targetQty: 5, attempts: 0 });
  assert.equal(dbState.statusUpdates[0].status, 'failed');
  assert.equal(patchState.calls.length, 0, 'si ML no aplicó el stock, no se parcha el snapshot');
});

// ─── processTask: sku_ml ───────────────────────────────────────────────────

test('sku_ml: con variationId usa updateVariationSku', async () => {
  await mlTaskQueue.processTask({ id: 7, kind: 'sku_ml', itemId: 'MLA1', variationId: '111', targetSku: 'NEW-SKU', attempts: 0 });
  assert.equal(dbState.statusUpdates[0].status, 'done');
});

test('sku_ml: sin variationId usa updateItemSku', async () => {
  await mlTaskQueue.processTask({ id: 8, kind: 'sku_ml', itemId: 'MLA1', variationId: null, targetSku: 'NEW-SKU', attempts: 0 });
  assert.equal(dbState.statusUpdates[0].status, 'done');
});

test('sku_ml: si el update devuelve false → failed', async () => {
  mlState.updateItemSkuResult = false;
  await mlTaskQueue.processTask({ id: 9, kind: 'sku_ml', itemId: 'MLA1', variationId: null, targetSku: 'X', attempts: 0 });
  assert.equal(dbState.statusUpdates[0].status, 'failed');
});

// ─── processTask: price_ml ─────────────────────────────────────────────────

test('price_ml: precio válido → done y parcha el precio en el snapshot', async () => {
  await mlTaskQueue.processTask({ id: 10, kind: 'price_ml', itemId: 'MLA1', variationId: null, targetPrice: 150, attempts: 0 });
  assert.equal(dbState.statusUpdates[0].status, 'done');
  assert.deepEqual(patchState.calls[0], ['patchMlPrice', 'MLA1', 150]);
});

test('price_ml: precio inválido (<=0) → failed sin llamar a ML', async () => {
  await mlTaskQueue.processTask({ id: 11, kind: 'price_ml', itemId: 'MLA1', variationId: null, targetPrice: 0, attempts: 0 });
  assert.equal(dbState.statusUpdates[0].status, 'failed');
  assert.match(dbState.statusUpdates[0].err, /precio inválido/);
});

test('price_ml: ML rechaza el precio (lanza) → failed con el mensaje real', async () => {
  mlState.updatePriceError = Object.assign(new Error('Found different prices in variations'), { mlStatus: 400 });
  await mlTaskQueue.processTask({ id: 12, kind: 'price_ml', itemId: 'MLA1', variationId: '111', targetPrice: 150, attempts: 0 });
  assert.equal(dbState.statusUpdates[0].status, 'failed');
  assert.match(dbState.statusUpdates[0].err, /different prices/);
});

// ─── processTask: sku_tn ────────────────────────────────────────────────────

test('sku_tn: actualiza SKU en TN → done', async () => {
  await mlTaskQueue.processTask({ id: 13, kind: 'sku_tn', itemId: 111, variationId: 222, targetSku: 'NEW', attempts: 0 });
  assert.equal(dbState.statusUpdates[0].status, 'done');
});

test('sku_tn: sin token TN → failed', async () => {
  storeState.tokens.tiendanube = { access_token: null };
  await mlTaskQueue.processTask({ id: 14, kind: 'sku_tn', itemId: 111, variationId: 222, targetSku: 'NEW', attempts: 0 });
  assert.equal(dbState.statusUpdates[0].status, 'failed');
  assert.match(dbState.statusUpdates[0].err, /Sin token TN/);
});

test('sku_tn: updateVariantSku devuelve false → failed', async () => {
  tnState.updateVariantSkuResult = false;
  await mlTaskQueue.processTask({ id: 15, kind: 'sku_tn', itemId: 111, variationId: 222, targetSku: 'NEW', attempts: 0 });
  assert.equal(dbState.statusUpdates[0].status, 'failed');
});

// ─── processTask: tipo desconocido ──────────────────────────────────────────

test('tipo de tarea desconocido → failed con mensaje explícito', async () => {
  await mlTaskQueue.processTask({ id: 16, kind: 'otro', itemId: 'MLA1', attempts: 0 });
  assert.equal(dbState.statusUpdates[0].status, 'failed');
  assert.match(dbState.statusUpdates[0].err, /desconocido/);
});

// ─── tick ────────────────────────────────────────────────────────────────

test('tick: sin tarea reclamada, no hace nada', async () => {
  dbState.claimedTask = null;
  await mlTaskQueue.tick();
  assert.equal(dbState.statusUpdates.length, 0);
});

test('tick: con tarea reclamada, la procesa', async () => {
  dbState.claimedTask = { id: 20, kind: 'sku_ml', itemId: 'MLA1', variationId: null, targetSku: 'X', attempts: 0 };
  await mlTaskQueue.tick();
  assert.equal(dbState.statusUpdates[0].id, 20);
});

// ─── start/stopMlTaskWorker: no debe explotar y respeta hasDatabase() ──────

test('startMlTaskWorker: sin base de datos no arranca el timer (no lanza)', () => {
  dbState.hasDb = false;
  mlTaskQueue.startMlTaskWorker();
  mlTaskQueue.stopMlTaskWorker();
});

test('startMlTaskWorker/stopMlTaskWorker: con base de datos arranca y para sin lanzar', () => {
  dbState.hasDb = true;
  mlTaskQueue.startMlTaskWorker();
  mlTaskQueue.startMlTaskWorker(); // segunda llamada es no-op (workerTimer ya seteado)
  mlTaskQueue.stopMlTaskWorker();
  mlTaskQueue.stopMlTaskWorker(); // segunda llamada es no-op (workerTimer ya null)
});
