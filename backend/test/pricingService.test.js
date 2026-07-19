/**
 * Tests de services/pricingService.js.
 *
 * Los helpers puros (buildSettings, costToInput, previewRow) se testean directo. La orquestación
 * (enqueueApply) se testea con '../src/db.js', '../src/store.js' y '../src/lib/tiendanube.js'
 * mockeados, para verificar que encola un price_ml por SKU y arma el bulk de TN sin tocar la red.
 */
import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../src/lib/pricing.js';

const dbState = {
  settings: null,
  costs: {},          // sku → cost
  enqueued: [],       // tareas price_ml encoladas
};
const storeState = { mlBySku: {}, tnBySku: {}, tnTokens: { access_token: 'tn-tok', store_id: '55' } };
const tnState = { bulkCalls: [], bulkError: null };

let svc;
before(async () => {
  mock.module('../src/db.js', {
    exports: {
      getPricingSettings: async () => dbState.settings,
      savePricingSettings: async () => true,
      saveMlFeeTiers: async () => true,
      getAllProductCosts: async () => Object.values(dbState.costs),
      getProductCost: async (sku) => dbState.costs[sku] || null,
      upsertProductCost: async () => true,
      deleteProductCost: async () => true,
      enqueueMlTask: async (task) => { dbState.enqueued.push(task); return dbState.enqueued.length; },
    },
  });
  mock.module('../src/store.js', {
    exports: {
      getMlItemBySku: (sku) => storeState.mlBySku[sku] || null,
      getTnVariantBySku: (sku) => storeState.tnBySku[sku] || null,
      tokens: storeState,
    },
  });
  mock.module('../src/lib/tiendanube.js', {
    exports: {
      updateVariantsStockPrice: async (_t, _s, updates) => {
        if (tnState.bulkError) throw tnState.bulkError;
        tnState.bulkCalls.push(updates);
        return true;
      },
    },
  });
  svc = await import('../src/services/pricingService.js');
});

beforeEach(() => {
  dbState.settings = null;
  dbState.costs = {};
  dbState.enqueued = [];
  storeState.mlBySku = {};
  storeState.tnBySku = {};
  storeState.tiendanube = { access_token: 'tn-tok', store_id: '55' };
  storeState.access_token = undefined;
  tnState.bulkCalls = [];
  tnState.bulkError = null;
});

// ── helpers puros ──────────────────────────────────────────────────────────

test('buildSettings: sin DB devuelve los defaults', () => {
  const s = svc.buildSettings(null);
  assert.equal(s.commissionPct, DEFAULT_SETTINGS.commissionPct);
  assert.equal(s.roundStep, 50);
  assert.deepEqual(s.tiers, DEFAULT_SETTINGS.tiers);
});

test('buildSettings: la config de la DB pisa los defaults', () => {
  const s = svc.buildSettings({ commissionPct: 13, taxes: 500, tiers: [{ maxPrice: Infinity, fixedFee: 0 }] });
  assert.equal(s.commissionPct, 13);
  assert.equal(s.taxes, 500);
  assert.equal(s.roundStep, DEFAULT_SETTINGS.roundStep); // lo no provisto queda en default
  assert.equal(s.tiers.length, 1);
});

test('costToInput: bulto usa descuentos; unidad usa el costo directo; margen override manda', () => {
  const bulk = svc.costToInput(
    { source: 'manual', bulkPrice: 70400, bulkQty: 8, discount1: 25, discount2: 5, marginOverride: null },
    { defaultMarginPct: 100 },
  );
  assert.deepEqual(bulk, { bulkPrice: 70400, bulkQty: 8, discount1: 25, discount2: 5, marginPct: 100 });

  const unit = svc.costToInput(
    { source: 'manual', unitCost: 3200, marginOverride: 50 },
    { defaultMarginPct: 100 },
  );
  assert.deepEqual(unit, { unitCost: 3200, marginPct: 50 }); // override 50 le gana al default 100
});

test('previewRow: calcula una fila completa de Punto Cero (30700)', () => {
  const row = svc.previewRow(
    { sku: '30700', source: 'manual', bulkPrice: 70400, bulkQty: 8, discount1: 25, discount2: 5 },
    DEFAULT_SETTINGS,
    { defaultMarginPct: 100 },
    { ml: 17850, tn: 16000 },
  );
  assert.equal(row.valorFinal, 12540);
  assert.equal(row.tn.list, 16350);
  assert.equal(row.currentMl, 17850);
  assert.ok(row.mlNet >= row.valorFinal);
  assert.equal(row.freeShipping, false);
});

// ── orquestación ───────────────────────────────────────────────────────────

test('enqueueApply: encola un price_ml por SKU con costo y mapeo de ML', async () => {
  dbState.costs['30700'] = { sku: '30700', source: 'manual', bulkPrice: 70400, bulkQty: 8, discount1: 25, discount2: 5 };
  storeState.mlBySku['30700'] = { itemId: 'MLA123', variationId: null };
  storeState.tnBySku['30700'] = { productId: 10, variantId: 20 };

  const res = await svc.enqueueApply(['30700'], { ml: true, tn: true });

  assert.equal(res.enqueuedMl, 1);
  assert.equal(res.appliedTn, 1);
  assert.equal(res.failed, 0);
  assert.equal(dbState.enqueued.length, 1);
  assert.equal(dbState.enqueued[0].kind, 'price_ml');
  assert.equal(dbState.enqueued[0].itemId, 'MLA123');
  assert.ok(dbState.enqueued[0].targetPrice > 0);
  assert.ok(dbState.enqueued[0].idempotencyKey.startsWith('price_ml:MLA123:'));
  // TN recibió el precio de lista en el bulk
  assert.equal(tnState.bulkCalls.length, 1);
  assert.equal(tnState.bulkCalls[0][0].productId, 10);
});

test('enqueueApply: SKU sin costo se reporta como fallo, no encola', async () => {
  const res = await svc.enqueueApply(['NOEXISTE']);
  assert.equal(res.failed, 1);
  assert.equal(res.enqueuedMl, 0);
  assert.equal(dbState.enqueued.length, 0);
  assert.equal(res.results[0].reason, 'sin costo cargado');
});

test('enqueueApply: SKU sin ítem de ML mapeado no encola ML pero sí aplica TN', async () => {
  dbState.costs['X'] = { sku: 'X', source: 'manual', unitCost: 3200 };
  storeState.tnBySku['X'] = { productId: 1, variantId: 2 };
  const res = await svc.enqueueApply(['X'], { ml: true, tn: true });
  assert.equal(res.enqueuedMl, 0);
  assert.equal(res.appliedTn, 1);
  const mlResult = res.results.find((r) => r.channel === 'ml');
  assert.equal(mlResult.ok, false);
  assert.match(mlResult.reason, /sin ítem de ML/);
});

test('enqueueApply: si el bulk de TN falla, esos SKUs quedan marcados como fallidos', async () => {
  dbState.costs['A'] = { sku: 'A', source: 'manual', unitCost: 1000 };
  storeState.tnBySku['A'] = { productId: 1, variantId: 2 };
  tnState.bulkError = new Error('422 bulk');
  const res = await svc.enqueueApply(['A'], { ml: false, tn: true });
  assert.equal(res.appliedTn, 0);
  assert.equal(res.failed, 1);
  assert.match(res.results.find((r) => r.channel === 'tn').reason, /bulk TN falló/);
});

test('enqueueApply: channels.ml=false no encola ML', async () => {
  dbState.costs['B'] = { sku: 'B', source: 'manual', unitCost: 1000 };
  storeState.mlBySku['B'] = { itemId: 'MLB', variationId: null };
  storeState.tnBySku['B'] = { productId: 3, variantId: 4 };
  const res = await svc.enqueueApply(['B'], { ml: false, tn: true });
  assert.equal(dbState.enqueued.length, 0);
  assert.equal(res.appliedTn, 1);
});
