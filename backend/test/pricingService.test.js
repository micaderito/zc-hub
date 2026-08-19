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
// patchTnPrice devuelve el precio previo del snapshot (null = fila ausente), igual que en prod.
const patchState = { tnPriceBefore: null, calls: [] };
const auditState = { priceRows: [] };
// fase 4: listas importadas, ítems, catálogo de códigos y mapeos guardados (SKU y pack).
const listState = { saved: [], items: [], codes: [], map: [], packMap: [] };
// packs del hub (para el mapeo por pack y para agrupar el preview).
const packState = { packs: [] };
// ajustes manuales de precio por SKU + canal (price_overrides).
const overrideState = { rows: [] };
// fase 5: lo que devuelve la API de comisiones de ML (o un error).
const feesState = { config: null, error: null };
// registro de lo guardado en Ajustes (savePricingSettings/saveMlFeeTiers).
const saveState = { settings: [], tiers: [] };

let svc;
before(async () => {
  mock.module('../src/db.js', {
    exports: {
      getPricingSettings: async () => dbState.settings,
      savePricingSettings: async (patch) => { saveState.settings.push(patch); return true; },
      saveMlFeeTiers: async (tiers) => { saveState.tiers.push(tiers); return true; },
      getAllProductCosts: async () => Object.values(dbState.costs),
      getProductCost: async (sku) => dbState.costs[sku] || null,
      upsertProductCost: async () => true,
      deleteProductCost: async () => true,
      enqueueMlTask: async (task) => { dbState.enqueued.push(task); return dbState.enqueued.length; },
      insertPriceAudit: async (row) => { auditState.priceRows.push(row); return true; },
      getPriceHistoryBySku: async () => ({ rows: [], total: 0 }),
      // fase 4: listas y mapeo
      savePriceList: async (list) => { listState.saved.push(list); return 1; },
      getPriceLists: async () => listState.saved.map((l, i) => ({ id: i + 1, ...l })),
      getPriceListItems: async () => listState.items,
      getSupplierCodes: async () => listState.codes,
      getSkuCodeMap: async () => listState.map,
      upsertSkuCodeMap: async (sku, code, matchSource) => {
        listState.map = listState.map.filter((m) => m.sku !== sku).concat({ sku, code, matchSource });
        return true;
      },
      deleteSkuCodeMap: async (sku) => { listState.map = listState.map.filter((m) => m.sku !== sku); return true; },
      getPackCodeMap: async () => listState.packMap,
      upsertPackCodeMap: async (packId, code, matchSource) => {
        listState.packMap = listState.packMap.filter((m) => m.packId !== packId).concat({ packId, code, matchSource });
        return true;
      },
      deletePackCodeMap: async (packId) => { listState.packMap = listState.packMap.filter((m) => m.packId !== packId); return true; },
      listPacks: async () => packState.packs,
      getPriceOverrides: async () => overrideState.rows,
      upsertPriceOverride: async (sku, channel, value) => {
        overrideState.rows = overrideState.rows.filter((r) => !(r.sku === sku && r.channel === channel)).concat({ sku, channel, value });
        return true;
      },
      deletePriceOverride: async (sku, channel) => {
        overrideState.rows = overrideState.rows.filter((r) => !(r.sku === sku && r.channel === channel));
        return true;
      },
    },
  });
  // pricingService usa patchTnPrice para refrescar el snapshot y saber el precio previo.
  mock.module('../src/services/conflictsService.js', {
    exports: {
      patchTnPrice: async (...a) => {
        patchState.calls.push(a);
        return patchState.tnPriceBefore;
      },
    },
  });
  mock.module('../src/store.js', {
    exports: {
      getMlItemBySku: (sku) => storeState.mlBySku[sku] || null,
      getTnVariantBySku: (sku) => storeState.tnBySku[sku] || null,
      getResolvedSkus: () => storeState.resolvedSkus,
      getMlToken: async () => storeState.mlToken,
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
  mock.module('../src/lib/mlFees.js', {
    exports: {
      fetchFeeConfig: async () => {
        if (feesState.error) throw feesState.error;
        return feesState.config;
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
  patchState.tnPriceBefore = null;
  patchState.calls = [];
  auditState.priceRows = [];
  storeState.resolvedSkus = [];
  storeState.mlToken = 'ml-tok';
  listState.saved = [];
  listState.items = [];
  listState.codes = [];
  listState.map = [];
  listState.packMap = [];
  packState.packs = [];
  overrideState.rows = [];
  feesState.config = null;
  feesState.error = null;
  saveState.settings = [];
  saveState.tiers = [];
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

// ── historial de precios (fase 3) ──────────────────────────────────────────

test('enqueueApply: registra el cambio de precio de TN en el historial', async () => {
  dbState.costs['H1'] = { sku: 'H1', source: 'manual', unitCost: 1000, label: 'Producto H1' };
  storeState.tnBySku['H1'] = { productId: 7, variantId: 8 };
  patchState.tnPriceBefore = { priceBefore: 1500, sku: 'H1' };

  await svc.enqueueApply(['H1'], { ml: false, tn: true });

  assert.equal(auditState.priceRows.length, 1);
  const row = auditState.priceRows[0];
  assert.equal(row.sku, 'H1');
  assert.equal(row.channel, 'tiendanube');
  assert.equal(row.priceBefore, 1500);
  assert.equal(row.source, 'bulk');
  assert.ok(row.priceAfter > 0);
  // y parcheó el snapshot con el precio nuevo
  assert.equal(patchState.calls.length, 1);
  assert.equal(patchState.calls[0][0], 7);
});

test('enqueueApply: si el precio de TN no cambió, no ensucia el historial', async () => {
  dbState.costs['H2'] = { sku: 'H2', source: 'manual', unitCost: 1000 };
  storeState.tnBySku['H2'] = { productId: 1, variantId: 2 };
  // el precio previo es exactamente el que vamos a aplicar
  const expected = svc.previewRow(dbState.costs['H2'], DEFAULT_SETTINGS, null).tn.list;
  patchState.tnPriceBefore = { priceBefore: expected, sku: 'H2' };

  await svc.enqueueApply(['H2'], { ml: false, tn: true });

  assert.equal(auditState.priceRows.length, 0);
});

test('enqueueApply: si el bulk de TN falla, no registra historial', async () => {
  dbState.costs['H3'] = { sku: 'H3', source: 'manual', unitCost: 1000 };
  storeState.tnBySku['H3'] = { productId: 1, variantId: 2 };
  patchState.tnPriceBefore = { priceBefore: 999, sku: 'H3' };
  tnState.bulkError = new Error('422');

  await svc.enqueueApply(['H3'], { ml: false, tn: true });

  assert.equal(auditState.priceRows.length, 0);
  assert.equal(patchState.calls.length, 0);
});

// ── importación de listas y mapeo (fase 4) ─────────────────────────────────

/** Texto mínimo con el formato real del PDF de Punto Cero. */
const PDF_SNIPPET =
  '30700A5 T/Dx80hjs.Removible c/elástico. Pack x8 unid.$ 8.800,008 $ 70.400,00*' +
  '39001Repuesto Rayado x80hjs de 90g. Pack x8 unid.$ 5.800,008 $ 46.400,00*';

test('previewImport: parsea y sugiere el mapeo sin guardar nada', async () => {
  storeState.resolvedSkus = ['30700', '30700-ROSA', 'OTRA-MARCA'];

  const out = await svc.previewImport(PDF_SNIPPET);

  assert.equal(out.stats.total, 2);
  assert.equal(out.stats.flagged, 0);
  // 30700 matchea exacto (auto); 30700-ROSA es "base" y va a revisión; OTRA-MARCA no matchea.
  assert.equal(out.mapping.auto, 1);
  assert.equal(out.mapping.review.length, 1);
  assert.equal(out.mapping.review[0].sku, '30700-ROSA');
  assert.equal(out.mapping.review[0].suggestion.auto, false);
  assert.equal(out.mapping.unmatched, 1);
  // no guardó nada
  assert.equal(listState.saved.length, 0);
  assert.equal(listState.map.length, 0);
});

test('previewImport: acepta CSV además del PDF', async () => {
  storeState.resolvedSkus = [];
  const csv = 'Codigo;Precio unitario;Cant x bulto;Precio x bulto\n30700;8.800,00;8;70.400,00';
  const out = await svc.previewImport(csv, { format: 'csv' });
  assert.equal(out.stats.total, 1);
  assert.equal(out.rows[0].code, '30700');
});

test('confirmImport: guarda la lista y aplica solo los mapeos exactos', async () => {
  storeState.resolvedSkus = ['30700', '30700-ROSA'];
  const parsed = await svc.previewImport(PDF_SNIPPET);

  const res = await svc.confirmImport({
    label: 'Marzo 2026', discount1: 25, discount2: 5, rows: parsed.rows,
  });

  assert.equal(res.ok, true);
  assert.equal(listState.saved.length, 1);
  assert.equal(listState.saved[0].label, 'Marzo 2026');
  assert.equal(listState.saved[0].discount1, 25);
  assert.equal(listState.saved[0].items.length, 2);
  // Solo el exacto quedó mapeado: el dudoso (30700-ROSA) espera confirmación.
  assert.deepEqual(listState.map.map((m) => m.sku), ['30700']);
  assert.equal(listState.map[0].matchSource, 'exact');
});

test('confirmImport: no guarda las filas marcadas para revisión', async () => {
  storeState.resolvedSkus = [];
  const rows = [
    { code: '30700', description: 'ok', unitPrice: 100, bulkQty: 2, bulkPrice: 200, valid: true },
    { code: '99999', description: 'no cierra', unitPrice: 100, bulkQty: 2, bulkPrice: 999, valid: false },
  ];
  await svc.confirmImport({ label: 'X', rows });
  assert.equal(listState.saved[0].items.length, 1);
  assert.equal(listState.saved[0].items[0].code, '30700');
});

test('applyListCosts: vuelca los precios de la lista a los SKUs mapeados', async () => {
  listState.items = [{ code: '30700', description: 'Cuaderno', unitPrice: 8800, bulkQty: 8, bulkPrice: 70400 }];
  listState.map = [{ sku: '30700', code: '30700' }, { sku: 'SIN-ITEM', code: 'NOEXISTE' }];

  const { updated, changedSkus } = await svc.applyListCosts(null, { discount1: 25, discount2: 5 });

  assert.equal(updated, 1, 'solo el SKU con ítem en la lista se actualiza');
  assert.deepEqual(changedSkus, ['30700'], 'sin costo previo, cuenta como cambiado');
});

test('getMappingState: separa SKUs sin código y códigos sin SKU', async () => {
  storeState.resolvedSkus = ['30700', 'OTRA-MARCA'];
  listState.codes = [{ code: '30700' }, { code: '39001' }];
  listState.map = [{ sku: '30700', code: '30700' }];

  const state = await svc.getMappingState();

  assert.deepEqual(state.skusWithoutCode, ['OTRA-MARCA']);
  assert.deepEqual(state.codesWithoutSku.map((c) => c.code), ['39001']);
  assert.equal(state.totals.mapped, 1);
});

test('confirmMapping / removeMapping: se guarda una vez y se puede rehacer', async () => {
  await svc.confirmMapping('30700-ROSA', '30700', 'base');
  assert.deepEqual(listState.map, [{ sku: '30700-ROSA', code: '30700', matchSource: 'base' }]);

  // Una vez confirmado, deja de pedir revisión: la siguiente importación lo aplica solo.
  storeState.resolvedSkus = ['30700-ROSA'];
  const out = await svc.previewImport(PDF_SNIPPET);
  assert.equal(out.mapping.review.length, 0);
  assert.equal(out.mapping.auto, 1);

  await svc.removeMapping('30700-ROSA');
  assert.equal(listState.map.length, 0);
});

// ── mapeo por pack ────────────────────────────────────────────────────────

test('previewImport: un pack con SKU propio matchea exacto y sus miembros no aparecen sueltos', async () => {
  // Pack surtido: modelos sin ninguna relación textual con el código del proveedor — solo el
  // propio SKU del pack (39001) puede matchear.
  packState.packs = [{ id: 1, name: 'Repuesto surtido', sku: '39001', unitCount: 8, mode: 'assorted', skus: ['REP-ROJO', 'REP-AZUL'] }];
  storeState.resolvedSkus = ['REP-ROJO', 'REP-AZUL', 'OTRA-MARCA'];

  const out = await svc.previewImport(PDF_SNIPPET);

  assert.equal(out.mapping.auto, 1); // 30700 (individual) + el pack — pero acá 39001 matchea exacto
  assert.equal(out.mapping.unmatched, 1); // solo OTRA-MARCA: los miembros del pack no se listan sueltos
});

test('previewImport: un pack SIN SKU propio no cambia nada — sus miembros siguen matcheando solos', async () => {
  // Pack de repuestos: mismo producto ×8, sin código propio del proveedor. El SKU del producto
  // matchea directo, como si no hubiera pack.
  packState.packs = [{ id: 2, name: 'Repuesto x8', sku: null, unitCount: 8, mode: 'single', skus: ['30700'] }];
  storeState.resolvedSkus = ['30700'];

  const out = await svc.previewImport(PDF_SNIPPET);

  assert.equal(out.mapping.auto, 1);
  assert.equal(out.mapping.unmatched, 0);
});

test('confirmImport: el mapeo automático de un pack se guarda en pack_code_map, no en sku_code_map', async () => {
  packState.packs = [{ id: 1, name: 'Repuesto surtido', sku: '39001', unitCount: 8, mode: 'assorted', skus: ['REP-ROJO', 'REP-AZUL'] }];
  storeState.resolvedSkus = ['REP-ROJO', 'REP-AZUL'];

  const parsed = await svc.previewImport(PDF_SNIPPET);
  await svc.confirmImport({ label: 'Marzo 2026', discount1: 25, discount2: 5, rows: parsed.rows });

  assert.deepEqual(listState.packMap.map((m) => ({ packId: m.packId, code: m.code })), [{ packId: 1, code: '39001' }]);
  assert.equal(listState.map.length, 0); // los miembros del pack no quedan en el mapeo individual
});

test('applyListCosts: un código de pack vuelca el MISMO costo a todos sus SKUs miembro', async () => {
  listState.items = [{ code: '39001', description: 'Repuesto surtido', unitPrice: 725, bulkQty: 8, bulkPrice: 5800 }];
  listState.packMap = [{ packId: 1, code: '39001' }];
  packState.packs = [{ id: 1, name: 'Repuesto surtido', sku: '39001', unitCount: 8, mode: 'assorted', skus: ['REP-ROJO', 'REP-AZUL'] }];

  const { updated, changedSkus } = await svc.applyListCosts(null, { discount1: 0, discount2: 0 });

  assert.equal(updated, 2, 'los dos miembros del pack se actualizan con la misma lista');
  assert.deepEqual(changedSkus.sort(), ['REP-AZUL', 'REP-ROJO']);
});

test('applyListCosts: un mapeo individual pisa el costo que dejó el pack (más específico)', async () => {
  listState.items = [
    { code: '39001', description: 'Repuesto surtido', unitPrice: 725, bulkQty: 8, bulkPrice: 5800 },
    { code: 'ESPECIAL', description: 'Precio puntual', unitPrice: 900, bulkQty: 1, bulkPrice: 900 },
  ];
  listState.packMap = [{ packId: 1, code: '39001' }];
  listState.map = [{ sku: 'REP-ROJO', code: 'ESPECIAL' }];
  packState.packs = [{ id: 1, name: 'Repuesto surtido', sku: '39001', unitCount: 8, mode: 'assorted', skus: ['REP-ROJO', 'REP-AZUL'] }];

  const { updated, changedSkus } = await svc.applyListCosts(null, { discount1: 0, discount2: 0 });

  // 2 del pack (REP-ROJO, REP-AZUL) + 1 del mapeo individual (REP-ROJO otra vez, con otro código)
  assert.equal(updated, 3);
  assert.equal(changedSkus.length, 3);
});

test('getMappingState: separa packs sin código de los SKUs sin código', async () => {
  packState.packs = [
    { id: 1, name: 'Repuesto surtido', sku: '39001', unitCount: 8, mode: 'assorted', skus: ['REP-ROJO', 'REP-AZUL'] },
    { id: 2, name: 'Sin código', sku: '39999', unitCount: 8, mode: 'assorted', skus: ['OTRO-A', 'OTRO-B'] },
  ];
  listState.packMap = [{ packId: 1, code: '39001' }];
  storeState.resolvedSkus = ['REP-ROJO', 'REP-AZUL', 'OTRO-A', 'OTRO-B'];

  const state = await svc.getMappingState();

  assert.deepEqual(state.packsWithoutCode.map((p) => p.id), [2]);
  // Los miembros de los packs (con o sin código) no cuentan como "SKU sin código" sueltos.
  assert.deepEqual(state.skusWithoutCode, []);
});

test('confirmPackMapping / removePackMapping: se guarda una vez y se puede rehacer', async () => {
  await svc.confirmPackMapping(1, '39001', 'manual');
  assert.deepEqual(listState.packMap, [{ packId: 1, code: '39001', matchSource: 'manual' }]);

  await svc.removePackMapping(1);
  assert.equal(listState.packMap.length, 0);
});

// ── preview agrupado por pack ────────────────────────────────────────────────

test('getPreview: anota el pack de cada fila para que el front pueda agruparlas', async () => {
  packState.packs = [{ id: 1, name: 'Repuesto surtido', sku: '39001', unitCount: 8, mode: 'assorted', skus: ['REP-ROJO', 'REP-AZUL'] }];
  dbState.costs['REP-ROJO'] = { sku: 'REP-ROJO', source: 'list', bulkPrice: 5800, bulkQty: 8, discount1: 0, discount2: 0, label: 'Repuesto rojo' };
  dbState.costs['30700'] = { sku: '30700', source: 'manual', bulkPrice: 70400, bulkQty: 8, discount1: 25, discount2: 5 };

  const rows = await svc.getPreview();

  const rojo = rows.find((r) => r.sku === 'REP-ROJO');
  const suelto = rows.find((r) => r.sku === '30700');
  assert.equal(rojo.pack.packId, 1);
  assert.equal(rojo.pack.name, 'Repuesto surtido');
  assert.equal(suelto.pack, null);
});

// ── ajustes manuales de precio (price_overrides) ─────────────────────────────

test('previewRow: sin override, "effective" es el calculado; con override, el calculado sigue de referencia', () => {
  const cost = { sku: '30700', source: 'manual', bulkPrice: 70400, bulkQty: 8, discount1: 25, discount2: 5 };

  const sinAjuste = svc.previewRow(cost, DEFAULT_SETTINGS, { defaultMarginPct: 100 });
  assert.equal(sinAjuste.tn.override, null);
  assert.equal(sinAjuste.tn.effective, sinAjuste.tn.list);
  assert.equal(sinAjuste.mlOverride, null);
  assert.equal(sinAjuste.mlEffective, sinAjuste.ml);

  const conAjuste = svc.previewRow(cost, DEFAULT_SETTINGS, { defaultMarginPct: 100 }, {}, { tn: 9000, ml: 18500 });
  assert.equal(conAjuste.tn.list, sinAjuste.tn.list, 'el calculado no se pisa');
  assert.equal(conAjuste.tn.override, 9000);
  assert.equal(conAjuste.tn.effective, 9000);
  assert.equal(conAjuste.ml, sinAjuste.ml);
  assert.equal(conAjuste.mlOverride, 18500);
  assert.equal(conAjuste.mlEffective, 18500);
  // "Te queda" es el neto de lo que en realidad se va a publicar (el ajustado), no del calculado.
  assert.notEqual(conAjuste.mlNet, sinAjuste.mlNet);
  assert.ok(conAjuste.mlNet > sinAjuste.mlNet, 'el ajuste subió el precio de ML, así que también sube lo que queda');
});

test('getPreview: trae bulkQty (de la lista del proveedor) y los ajustes guardados', async () => {
  dbState.costs['30700'] = { sku: '30700', source: 'list', bulkPrice: 70400, bulkQty: 8, discount1: 25, discount2: 5, label: 'Cuaderno' };
  overrideState.rows = [{ sku: '30700', channel: 'tn', value: 9000 }];

  const rows = await svc.getPreview();
  const row = rows.find((r) => r.sku === '30700');

  assert.equal(row.bulkQty, 8);
  assert.equal(row.tn.override, 9000);
  assert.equal(row.tn.effective, 9000);
  assert.equal(row.mlOverride, null);
});

test('saveOverride: guarda el ajuste; con value null lo saca (vuelve al calculado)', async () => {
  await svc.saveOverride('30700', 'tn', 9000);
  assert.deepEqual(overrideState.rows, [{ sku: '30700', channel: 'tn', value: 9000 }]);

  await svc.saveOverride('30700', 'tn', null);
  assert.equal(overrideState.rows.length, 0);
});

test('enqueueApply: si hay un ajuste manual, encola/aplica ESE precio, no el calculado', async () => {
  dbState.costs['30700'] = { sku: '30700', source: 'manual', bulkPrice: 70400, bulkQty: 8, discount1: 25, discount2: 5 };
  storeState.mlBySku['30700'] = { itemId: 'MLA123', variationId: null };
  storeState.tnBySku['30700'] = { productId: 10, variantId: 20 };
  overrideState.rows = [{ sku: '30700', channel: 'ml', value: 18500 }, { sku: '30700', channel: 'tn', value: 9000 }];

  const res = await svc.enqueueApply(['30700'], { ml: true, tn: true });

  assert.equal(dbState.enqueued[0].targetPrice, 18500);
  assert.equal(tnState.bulkCalls[0][0].price, 9000);
  const mlResult = res.results.find((r) => r.channel === 'ml');
  const tnResult = res.results.find((r) => r.channel === 'tn');
  assert.equal(mlResult.price, 18500);
  assert.equal(tnResult.price, 9000);
});

// ── sincronización de comisiones desde la API de ML (fase 5) ────────────────

test('syncMlFees: sin apply solo compara (no guarda nada en Ajustes)', async () => {
  feesState.config = {
    commissionPct: 13,
    tiers: [{ maxPrice: 15000, fixedFee: 1115 }, { maxPrice: null, fixedFee: 0 }],
    probes: [], fetchedAt: '2026-07-20T00:00:00Z', source: 'api',
  };
  const res = await svc.syncMlFees({ apply: false });
  assert.equal(res.applied, false);
  assert.equal(res.remote.commissionPct, 13);
  assert.equal(res.current.commissionPct, DEFAULT_SETTINGS.commissionPct); // 15, lo cargado
  assert.equal(saveState.settings.length, 0, 'no debe guardar sin apply');
  assert.equal(saveState.tiers.length, 0);
});

test('syncMlFees: con apply guarda la comisión y los tramos que trajo ML', async () => {
  feesState.config = {
    commissionPct: 13,
    tiers: [{ maxPrice: 15000, fixedFee: 1115 }, { maxPrice: null, fixedFee: 0 }],
    probes: [], fetchedAt: '2026-07-20T00:00:00Z', source: 'api',
  };
  const res = await svc.syncMlFees({ apply: true });
  assert.equal(res.applied, true);
  assert.equal(saveState.settings.at(-1).commissionPct, 13);
  assert.deepEqual(saveState.tiers.at(-1), feesState.config.tiers);
});

test('syncMlFees: si la API falla, propaga el error (los valores a mano quedan intactos)', async () => {
  feesState.error = new Error('listing_prices 403: PolicyAgent');
  await assert.rejects(() => svc.syncMlFees({ apply: true }), /403/);
  assert.equal(saveState.settings.length, 0);
});
