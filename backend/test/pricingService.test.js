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
// readTnSnapshotRow devuelve la fila previa del snapshot (null = ausente); se lee ANTES del
// bulk, no después — patchTnPrice ahora solo mantiene la foto al día, su valor de retorno
// ya no se usa para el historial (ver pricingService.js / conflictsService.js).
const patchState = { tnSnapshotRow: null, calls: [], readCalls: [] };
const auditState = { priceRows: [] };
// fase 4: listas importadas, ítems, catálogo de códigos y mapeos guardados (SKU y pack).
const listState = { saved: [], items: [], codes: [], map: [], packMap: [], removed: [], deletedLists: [] };
// packs del hub (para el mapeo por pack y para agrupar el preview).
const packState = { packs: [] };
// ajustes manuales de precio por SKU + canal (price_overrides).
const overrideState = { rows: [] };
// fase 5: lo que devuelve la API de comisiones de ML (o un error).
const feesState = { config: null, error: null };
// registro de lo guardado en Ajustes (savePricingSettings/saveMlFeeTiers).
const saveState = { settings: [], tiers: [] };
// foto del catálogo (getCatalogRows) y el índice SKU → canal que se puebla desde ella.
const catalogState = { mlRows: [], tnRows: [], calls: 0, resolutionCalls: 0 };
// ítem más reciente por código (getLatestPriceListItems), con los datos de su lista.
const latestState = { items: [] };
// proveedores + configs de descuento + asignaciones pack/producto ↔ proveedor.
const PC = 'punto_cero';
const freshSuppliers = () => [{ key: PC, name: 'Punto Cero', profiles: [{ id: 1, name: 'General', discount1: 0, discount2: 0, isDefault: true }] }];
const supplierState = { suppliers: freshSuppliers(), assignments: [], nextId: 10 };
const withSupplier = (rows) => rows.map((m) => ({ supplier: PC, ...m }));
const bySupplier = (sup) => (m) => sup == null || m.supplier === sup;

let svc;
before(async () => {
  mock.module('../src/db.js', {
    exports: {
      getPricingSettings: async () => dbState.settings,
      savePricingSettings: async (patch) => { saveState.settings.push(patch); return true; },
      saveMlFeeTiers: async (tiers) => { saveState.tiers.push(tiers); return true; },
      getAllProductCosts: async () => Object.values(dbState.costs),
      getProductCost: async (sku) => dbState.costs[sku] || null,
      upsertProductCost: async (sku, data) => {
        if (dbState.storeCosts) {
          const prev = dbState.costs[sku] || {};
          dbState.costs[sku] = { ...prev, ...data, sku, supplierKey: data.supplierKey !== undefined ? data.supplierKey : prev.supplierKey };
        }
        return true;
      },
      deleteProductCost: async () => true,
      enqueueMlTask: async (task) => { dbState.enqueued.push(task); return dbState.enqueued.length; },
      insertPriceAudit: async (row) => { auditState.priceRows.push(row); return true; },
      getPriceHistoryBySku: async () => ({ rows: [], total: 0 }),
      // fase 4: listas y mapeo
      savePriceList: async (list) => { listState.saved.push(list); return 1; },
      getPriceLists: async () => listState.saved.map((l, i) => ({ id: i + 1, ...l })),
      getPriceListItems: async () => listState.items,
      getSupplierCodes: async (sup) => withSupplier(listState.codes).filter(bySupplier(sup)),
      getSkuCodeMap: async (sup = PC) => withSupplier(listState.map).filter(bySupplier(sup)),
      upsertSkuCodeMap: async (sku, code, matchSource, supplier = PC) => {
        listState.map = withSupplier(listState.map).filter((m) => !(m.sku === sku && m.supplier === supplier)).concat({ sku, code, matchSource, supplier });
        return true;
      },
      deleteSkuCodeMap: async (sku) => { listState.map = listState.map.filter((m) => m.sku !== sku); return true; },
      getPackCodeMap: async (sup = PC) => withSupplier(listState.packMap).filter(bySupplier(sup)),
      upsertPackCodeMap: async (packId, code, matchSource, supplier = PC) => {
        listState.packMap = withSupplier(listState.packMap).filter((m) => !(m.packId === packId && m.supplier === supplier)).concat({ packId, code, matchSource, supplier });
        return true;
      },
      deletePackCodeMap: async (packId) => { listState.packMap = listState.packMap.filter((m) => m.packId !== packId); return true; },
      markSkuCodeRemoved: async (sku) => { listState.map = listState.map.filter((m) => m.sku !== sku); listState.removed.push(`sku:${sku}`); return true; },
      markPackCodeRemoved: async (packId) => { listState.packMap = listState.packMap.filter((m) => m.packId !== packId); listState.removed.push(`pack:${packId}`); return true; },
      getRemovedCodeMapKeys: async () => listState.removed,
      deletePriceList: async (id) => { listState.deletedLists.push(id); return id !== 404; },
      listPacks: async () => packState.packs,
      getPriceOverrides: async () => overrideState.rows,
      upsertPriceOverride: async (sku, channel, value) => {
        overrideState.rows = overrideState.rows.filter((r) => !(r.sku === sku && r.channel === channel)).concat({ sku, channel, value });
        return true;
      },
      getActiveMlTasks: async () => dbState.activeTasks || [],
      // Lo más reciente primero: las listas guardadas en el test (última primero) y después latestState.
      getLatestPriceListItems: async (codes, supplier = null) => {
        const fromSaved = listState.saved.slice().reverse().flatMap((l) => (l.items || []).map((i) => ({
          ...i, listLabel: l.label, supplier: l.supplier ?? PC, discount1: l.discount1 ?? 0, discount2: l.discount2 ?? 0,
        })));
        const seen = new Set();
        return [...fromSaved, ...withSupplier(latestState.items)]
          .filter((i) => !seen.has(`${i.supplier}|${i.code}`) && seen.add(`${i.supplier}|${i.code}`))
          .filter((i) => !codes || codes.includes(i.code))
          .filter(bySupplier(supplier));
      },
      listSuppliers: async () => supplierState.suppliers,
      createSupplier: async ({ key, name, discount1, discount2, profileName }) => {
        supplierState.suppliers.push({ key, name, profiles: [{ id: supplierState.nextId++, name: profileName, discount1, discount2, isDefault: true }] });
        return key;
      },
      renameSupplier: async (key, name) => {
        const s = supplierState.suppliers.find((x) => x.key === key);
        if (s) s.name = name;
        return !!s;
      },
      deleteSupplier: async (key) => {
        const n = supplierState.suppliers.length;
        supplierState.suppliers = supplierState.suppliers.filter((x) => x.key !== key);
        return supplierState.suppliers.length < n;
      },
      getSupplierUsage: async (key) => ({
        lists: listState.saved.filter((l) => (l.supplier ?? PC) === key).length,
        products: Object.values(dbState.costs).filter((c) => c.supplierKey === key).length,
      }),
      createDiscountProfile: async (supplierKey, { name, discount1, discount2 }) => {
        const id = supplierState.nextId++;
        supplierState.suppliers.find((x) => x.key === supplierKey).profiles.push({ id, name, discount1, discount2, isDefault: false });
        return id;
      },
      updateDiscountProfile: async (id, patch) => {
        const pr = supplierState.suppliers.flatMap((x) => x.profiles).find((x) => x.id === id);
        if (!pr) return false;
        for (const k of ['name', 'discount1', 'discount2']) if (patch[k] != null) pr[k] = patch[k];
        return true;
      },
      deleteDiscountProfile: async (id) => {
        for (const x of supplierState.suppliers) x.profiles = x.profiles.filter((pr) => pr.id !== id || pr.isDefault);
        supplierState.assignments = supplierState.assignments.map((a) => (a.profileId === id ? { ...a, profileId: null } : a));
        return true;
      },
      listProductSuppliers: async () => supplierState.assignments,
      upsertProductSuppliers: async (supplierKey, targets, profileId, { onlyIfMissing = false } = {}) => {
        for (const t of targets) {
          const cur = supplierState.assignments.find((a) => a.type === t.type && a.id === String(t.id) && a.supplierKey === supplierKey);
          if (!cur) supplierState.assignments.push({ type: t.type, id: String(t.id), supplierKey, profileId });
          else if (!onlyIfMissing || cur.profileId == null) cur.profileId = profileId;
        }
        return targets.length;
      },
      clearSkuProfiles: async (supplierKey, skus) => {
        for (const a of supplierState.assignments) if (a.supplierKey === supplierKey && a.type === 'sku' && skus.includes(a.id)) a.profileId = null;
        return true;
      },
      deleteProductSuppliers: async (supplierKey, targets) => {
        supplierState.assignments = supplierState.assignments.filter((a) => !(a.supplierKey === supplierKey && targets.some((t) => t.type === a.type && String(t.id) === a.id)));
        return true;
      },
      setCostSupplier: async (skus, supplierKey) => {
        for (const sku of skus) if (dbState.costs[sku]) dbState.costs[sku].supplierKey = supplierKey;
        return skus.length;
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
      },
      readTnSnapshotRow: async (...a) => {
        patchState.readCalls.push(a);
        return patchState.tnSnapshotRow;
      },
      getCatalogRows: async () => {
        catalogState.calls++;
        return { mlRows: catalogState.mlRows, tnRows: catalogState.tnRows };
      },
    },
  });
  mock.module('../src/store.js', {
    exports: {
      getMlItemBySku: (sku) => storeState.mlBySku[sku] || null,
      getTnVariantBySku: (sku) => storeState.tnBySku[sku] || null,
      getResolvedSkus: () => storeState.resolvedSkus,
      setResolutionFromAnalysis: (mlRows, tnRows) => {
        catalogState.resolutionCalls++;
        storeState.resolvedSkus = [...new Set([...mlRows, ...tnRows].map((r) => r.sku).filter(Boolean))];
        for (const r of mlRows) if (r.sku) storeState.mlBySku[r.sku] = { itemId: r.itemId };
        for (const r of tnRows) if (r.sku) storeState.tnBySku[r.sku] = { productId: r.productId, variantId: r.variantId };
      },
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
  svc?._resetAutoMapThrottle();
  dbState.settings = null;
  dbState.costs = {};
  dbState.enqueued = [];
  dbState.activeTasks = [];
  storeState.mlBySku = {};
  storeState.tnBySku = {};
  storeState.tiendanube = { access_token: 'tn-tok', store_id: '55' };
  storeState.access_token = undefined;
  tnState.bulkCalls = [];
  tnState.bulkError = null;
  patchState.tnSnapshotRow = null;
  patchState.readCalls = [];
  patchState.calls = [];
  auditState.priceRows = [];
  storeState.resolvedSkus = [];
  storeState.mlToken = 'ml-tok';
  listState.saved = [];
  listState.items = [];
  listState.codes = [];
  listState.map = [];
  listState.packMap = [];
  listState.removed = [];
  listState.deletedLists = [];
  packState.packs = [];
  overrideState.rows = [];
  feesState.config = null;
  feesState.error = null;
  saveState.settings = [];
  saveState.tiers = [];
  catalogState.mlRows = [];
  catalogState.tnRows = [];
  catalogState.calls = 0;
  catalogState.resolutionCalls = 0;
  latestState.items = [];
  supplierState.suppliers = freshSuppliers();
  supplierState.assignments = [];
  supplierState.nextId = 10;
  dbState.storeCosts = false;
  svc._resetCatalogCache();
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
  patchState.tnSnapshotRow = { price: 1500, sku: 'H1' };

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
  patchState.tnSnapshotRow = { price: expected, sku: 'H2' };

  await svc.enqueueApply(['H2'], { ml: false, tn: true });

  assert.equal(auditState.priceRows.length, 0);
});

test('enqueueApply: si el bulk de TN falla, no registra historial', async () => {
  dbState.costs['H3'] = { sku: 'H3', source: 'manual', unitCost: 1000 };
  storeState.tnBySku['H3'] = { productId: 1, variantId: 2 };
  patchState.tnSnapshotRow = { price: 999, sku: 'H3' };
  tnState.bulkError = new Error('422');

  await svc.enqueueApply(['H3'], { ml: false, tn: true });

  assert.equal(auditState.priceRows.length, 0);
  // El precio previo se lee ANTES del bulk (para no perderlo si el bulk aplica pero el proceso se
  // cae antes de leerlo), pero el snapshot solo se parcha DESPUÉS de que el bulk confirme — si
  // falla, no hay nada que confirmar y no se toca la foto.
  assert.equal(patchState.calls.length, 0);
});

/**
 * El mismo motivo que en ML (ver mlTaskQueue.test.js): la escritura dispara el webhook
 * `product/updated` de TN casi en el acto, que puede mover la foto al valor nuevo antes de que
 * este código llegue a leerla si se leyera DESPUÉS del bulk. readTnSnapshotRow tiene que leerse
 * antes de mandar el bulk.
 */
test('enqueueApply: lee el precio previo de TN ANTES del bulk, no después', async () => {
  dbState.costs['H4'] = { sku: 'H4', source: 'manual', unitCost: 1000 };
  storeState.tnBySku['H4'] = { productId: 9, variantId: 90 };
  patchState.tnSnapshotRow = { price: 1000, sku: 'H4' };

  await svc.enqueueApply(['H4'], { ml: false, tn: true });

  assert.equal(patchState.readCalls.length, 1, 'debe leer el snapshot antes de mandar el bulk');
  assert.equal(tnState.bulkCalls.length, 1, 'el bulk se manda una vez confirmado el valor previo');
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
  // 30700 matchea exacto y 30700-ROSA por base (CODIGO-variante): los dos solos. OTRA-MARCA no matchea.
  assert.equal(out.mapping.auto, 2);
  assert.equal(out.mapping.review.length, 0);
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

test('confirmImport: guarda la lista y aplica los mapeos que coinciden con un código (exacto y CODIGO-variante)', async () => {
  storeState.resolvedSkus = ['30700', '30700-ROSA'];
  const parsed = await svc.previewImport(PDF_SNIPPET);
  supplierState.suppliers[0].profiles.push({ id: 2, name: 'Agendas', discount1: 25, discount2: 5, isDefault: false });

  // La lista guarda los % de la config con la que se importó (para el historial de listas).
  const res = await svc.confirmImport({ label: 'Marzo 2026', profileId: 2, rows: parsed.rows });

  assert.equal(res.ok, true);
  assert.equal(listState.saved.length, 1);
  assert.equal(listState.saved[0].label, 'Marzo 2026');
  assert.equal(listState.saved[0].discount1, 25);
  assert.equal(listState.saved[0].items.length, 2);
  const bySku = Object.fromEntries(listState.map.map((m) => [m.sku, m]));
  assert.deepEqual(Object.keys(bySku).sort(), ['30700', '30700-ROSA']);
  assert.equal(bySku['30700'].matchSource, 'exact');
  assert.equal(bySku['30700-ROSA'].matchSource, 'base');
  assert.equal(bySku['30700-ROSA'].code, '30700');
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

  const { updated, changedSkus } = await svc.applyListCosts(null);

  assert.equal(updated, 1, 'solo el SKU con ítem en la lista se actualiza');
  assert.deepEqual(changedSkus, ['30700'], 'sin costo previo, cuenta como cambiado');
});

test('getMappingState: separa SKUs sin código y códigos sin SKU', async () => {
  storeState.resolvedSkus = ['30700', 'OTRA-MARCA'];
  listState.codes = [{ code: '30700' }, { code: '39001' }];
  latestState.items = [{ code: '30700' }, { code: '39001' }];
  listState.map = [{ sku: '30700', code: '30700' }];

  const state = await svc.getMappingState();

  assert.deepEqual(state.skusWithoutCode, ['OTRA-MARCA']);
  assert.deepEqual(state.codesWithoutSku.map((c) => c.code), ['39001']);
  assert.equal(state.totals.mapped, 1);
});

test('confirmMapping / removeMapping: se guarda una vez y se puede rehacer', async () => {
  const r = await svc.confirmMapping('30700-ROSA', '30700', 'base');
  assert.equal(r.ok, true);
  assert.deepEqual(listState.map, [{ sku: '30700-ROSA', code: '30700', matchSource: 'base', supplier: PC }]);

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

  const { updated, changedSkus } = await svc.applyListCosts(null);

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

  const { updated, changedSkus } = await svc.applyListCosts(null);

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
  assert.deepEqual(listState.packMap, [{ packId: 1, code: '39001', matchSource: 'manual', supplier: PC }]);

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

// ── índice SKU → canal vacío tras un deploy + resumen por lista + pestaña Mapeo ─────────────

const CATALOG = {
  mlRows: [{ sku: '30700', itemId: 'MLA1', title: 'Cuaderno removible', variationName: null }],
  tnRows: [
    { sku: '30700', productId: 1, variantId: 11, productName: 'Cuaderno', variantName: 'Rosa' },
    { sku: 'OTRA-MARCA', productId: 2, variantId: 21, productName: 'Lapicera', variantName: null },
  ],
};

test('buildSkuNames: prefiere el nombre de TN (producto · variante) y cae al de ML', () => {
  const names = svc.buildSkuNames(
    [{ sku: 'A', title: 'Título ML', variationName: 'Azul' }, { sku: 'B', title: 'Solo ML' }],
    [{ sku: 'A', productName: 'Cuaderno', variantName: 'Rosa' }],
  );
  assert.equal(names.get('A'), 'Cuaderno · Rosa');
  assert.equal(names.get('B'), 'Solo ML');
  // TN usa el SKU como nombre de una variante sin valores: no se repite.
  assert.equal(svc.buildSkuNames([], [{ sku: 'C-1', productName: 'Carpeta', variantName: 'C-1' }]).get('C-1'), 'Carpeta');
});

test('previewImport: con el índice vacío (backend recién deployado) lo puebla desde la foto y matchea', async () => {
  storeState.resolvedSkus = [];
  catalogState.mlRows = CATALOG.mlRows;
  catalogState.tnRows = CATALOG.tnRows;

  const out = await svc.previewImport(PDF_SNIPPET);

  assert.equal(catalogState.resolutionCalls, 1, 'pobló el índice desde la foto');
  assert.equal(out.mapping.auto, 1, '30700 matchea exacto aunque nadie haya abierto Conflictos');
  assert.equal(out.mapping.inListItems[0].name, 'Cuaderno · Rosa');
  assert.deepEqual(out.mapping.unmatchedItems.map((u) => u.sku), ['OTRA-MARCA']);
});

test('loadCatalogContext: con el índice poblado, la foto se lee una sola vez por minuto', async () => {
  storeState.resolvedSkus = ['30700'];
  await svc.loadCatalogContext();
  await svc.loadCatalogContext();
  assert.equal(catalogState.calls, 1);
  assert.equal(catalogState.resolutionCalls, 0, 'no pisa un índice que ya estaba poblado');
});

test('previewImport: un mapeo guardado de OTRA lista no cuenta como mapeo de esta', async () => {
  // La usuaria trabaja con varias listas: 30700 está en la que se importa; LAP-1 ya tiene código
  // de otra lista (LAP-01) que no viene en esta.
  storeState.resolvedSkus = ['30700', 'LAP-1'];
  listState.map = [{ sku: 'LAP-1', code: 'LAP-01' }];

  const out = await svc.previewImport(PDF_SNIPPET);

  assert.equal(out.mapping.auto, 1);
  assert.equal(out.mapping.inListItems[0].sku, '30700');
  assert.equal(out.mapping.otherLists, 1);
  // 39001 no quedó asignado a nada: es candidato a mapear a mano.
  assert.deepEqual(out.mapping.codesWithoutProduct.map((c) => c.code), ['39001']);
});

test('confirmImport: devuelve el resumen de qué tomó precio de esta lista y qué no', async () => {
  storeState.resolvedSkus = ['30700', '30700-ROSA', 'LAP-1'];
  listState.map = [{ sku: 'LAP-1', code: 'LAP-01' }];
  const parsed = await svc.previewImport(PDF_SNIPPET);
  // getPriceListItems devuelve lo guardado de esta lista.
  listState.items = parsed.rows.filter((r) => r.valid);

  const res = await svc.confirmImport({ label: 'Marzo', discount1: 0, discount2: 0, rows: parsed.rows });

  assert.equal(res.autoMapped, 2);
  assert.equal(res.newMappings, 2);
  assert.equal(res.costsUpdated, 2);
  assert.deepEqual(res.summary.inList.map((e) => [e.sku, e.code]).sort(), [['30700', '30700'], ['30700-ROSA', '30700']]);
  assert.equal(res.summary.otherLists, 1);
  assert.deepEqual(res.summary.unmatched, []);
  assert.deepEqual(res.summary.codesWithoutProduct.map((c) => c.code), ['39001']);
});

test('confirmMapping: toma en el momento el precio del código en la lista más reciente', async () => {
  latestState.items = [{ code: '39001', description: 'Repuesto', bulkQty: 8, bulkPrice: 5800, listLabel: 'Repuestos', discount1: 0, discount2: 0 }];

  const r = await svc.confirmMapping('REP-1', '39001');

  assert.equal(r.costsUpdated, 1);
  assert.deepEqual(r.changedSkus, ['REP-1']);
  assert.equal(r.listLabel, 'Repuestos');
});

test('confirmMapping: un código que no está en ninguna lista guarda el mapeo sin tocar costos', async () => {
  const r = await svc.confirmMapping('REP-1', 'NUEVO');
  assert.equal(r.ok, true);
  assert.equal(r.costsUpdated, 0);
  assert.deepEqual(listState.map, [{ sku: 'REP-1', code: 'NUEVO', matchSource: 'manual', supplier: PC }]);
});

test('confirmPackMapping: vuelca el precio a los modelos del pack, salvo los que tienen mapeo propio', async () => {
  packState.packs = [{ id: 1, name: 'Repuesto surtido', sku: '39001', unitCount: 8, mode: 'assorted', skus: ['REP-ROJO', 'REP-AZUL'] }];
  listState.map = [{ sku: 'REP-ROJO', code: 'ESPECIAL' }];
  latestState.items = [{ code: '39001', description: 'Repuesto', bulkQty: 8, bulkPrice: 5800, listLabel: 'Repuestos', discount1: 0, discount2: 0 }];

  const r = await svc.confirmPackMapping(1, '39001');

  assert.deepEqual(r.changedSkus, ['REP-AZUL']);
});

test('getMappingState: lista cada producto y pack con su código, la lista de origen y si tiene costo', async () => {
  storeState.resolvedSkus = ['30700', 'OTRA-MARCA', 'REP-ROJO', 'REP-AZUL'];
  storeState.tnBySku['30700'] = { productId: 1, variantId: 11 };
  catalogState.tnRows = CATALOG.tnRows;
  packState.packs = [{ id: 1, name: 'Repuesto surtido', sku: '39001', unitCount: 8, mode: 'assorted', skus: ['REP-ROJO', 'REP-AZUL'] }];
  listState.map = [{ sku: '30700', code: '30700', matchSource: 'exact' }];
  listState.codes = [{ code: '30700', description: 'Cuaderno' }, { code: '39001', description: 'Repuesto' }];
  latestState.items = [{ code: '30700', description: 'Cuaderno', bulkQty: 8, bulkPrice: 70400, listLabel: 'Cuadernos' }];
  dbState.costs['30700'] = { sku: '30700', source: 'list' };

  const state = await svc.getMappingState();

  const byKey = Object.fromEntries(state.products.map((p) => [p.key, p]));
  assert.deepEqual(Object.keys(byKey).sort(), ['pack:1', 'sku:30700', 'sku:OTRA-MARCA']);
  assert.equal(byKey['sku:30700'].code, '30700');
  assert.equal(byKey['sku:30700'].listLabel, 'Cuadernos');
  assert.equal(byKey['sku:30700'].name, 'Cuaderno · Rosa');
  assert.equal(byKey['sku:30700'].hasCost, true);
  assert.equal(byKey['sku:30700'].mappedTn, true);
  assert.equal(byKey['sku:OTRA-MARCA'].code, null);
  assert.equal(byKey['pack:1'].code, null);
  assert.deepEqual(byKey['pack:1'].memberSkus, ['REP-ROJO', 'REP-AZUL']);
  assert.deepEqual(byKey['pack:1'].members.map((m) => [m.sku, m.code]), [['REP-ROJO', null], ['REP-AZUL', null]]);
  // 39001 está en supplier_codes pero en ninguna lista importada: no da precio, no se ofrece.
  assert.deepEqual(state.codes.map((c) => [c.code, c.mapped]), [['30700', true]]);
});

// ── mapeo automático en cada lectura (autoMapFromLists) ───────────────────────────────────────

const PACK_39000 = { id: 7, name: 'A4 Inteligentes Rayados (Nuevos)', sku: '39000', unitCount: 8, mode: 'assorted', skus: ['39000-CORAZONES', '39000-LUNA'] };
const ITEM_39000 = { code: '39000', description: 'A4 T/Dx80hjs', bulkQty: 8, bulkPrice: 119200, listLabel: 'Punto Cero julio', discount1: 0, discount2: 0 };

test('getMappingState: un pack cuyo SKU está en una lista se mapea solo y le pasa el costo a sus modelos', async () => {
  packState.packs = [PACK_39000];
  storeState.resolvedSkus = ['39000-CORAZONES', '39000-LUNA'];
  latestState.items = [ITEM_39000];

  const state = await svc.getMappingState();

  assert.deepEqual(listState.packMap, [{ packId: 7, code: '39000', matchSource: 'exact', supplier: PC }]);
  assert.equal(listState.map.length, 0, 'los modelos toman el precio del pack, sin mapeo propio');
  const pack = state.products.find((p) => p.key === 'pack:7');
  assert.equal(pack.code, '39000');
  assert.equal(pack.listLabel, 'Punto Cero julio');
  assert.deepEqual(pack.members.map((m) => [m.sku, m.code, m.codeSource]), [
    ['39000-CORAZONES', '39000', 'pack'], ['39000-LUNA', '39000', 'pack'],
  ]);
  assert.equal(state.autoMapped.count, 1);
  assert.deepEqual(state.autoMapped.changedSkus.sort(), ['39000-CORAZONES', '39000-LUNA']);
});

test('autoMapFromLists: dos packs con el mismo SKU — el segundo también se mapea', async () => {
  packState.packs = [PACK_39000, { ...PACK_39000, id: 8, name: 'A4 (Viejos)', skus: ['39000-RUCHI'] }];
  listState.packMap = [{ packId: 7, code: '39000', matchSource: 'exact' }];
  latestState.items = [ITEM_39000];

  const r = await svc.autoMapFromLists();

  assert.equal(r.newMappings, 1);
  assert.deepEqual(listState.packMap.map((m) => m.packId).sort(), [7, 8]);
});

test('autoMapFromLists: un producto suelto CODIGO-variante toma el código base', async () => {
  storeState.resolvedSkus = ['39000-CORAZONES', 'OTRA-MARCA'];
  latestState.items = [ITEM_39000];

  await svc.autoMapFromLists();

  assert.deepEqual(listState.map, [{ sku: '39000-CORAZONES', code: '39000', matchSource: 'base', supplier: PC }]);
});

test('autoMapFromLists: nunca pisa un mapeo existente (tampoco uno a mano)', async () => {
  storeState.resolvedSkus = ['39000-CORAZONES'];
  listState.map = [{ sku: '39000-CORAZONES', code: 'OTRO', matchSource: 'manual' }];
  latestState.items = [ITEM_39000];

  const r = await svc.autoMapFromLists();

  assert.equal(r.newMappings, 0);
  assert.deepEqual(listState.map, [{ sku: '39000-CORAZONES', code: 'OTRO', matchSource: 'manual' }]);
});

test('autoMapFromLists: un código que no está en ninguna lista importada no mapea', async () => {
  packState.packs = [PACK_39000];
  listState.codes = [{ code: '39000' }]; // quedó en supplier_codes, pero su lista se borró
  latestState.items = [];

  const r = await svc.autoMapFromLists();

  assert.equal(r.newMappings, 0);
  assert.equal(listState.packMap.length, 0);
});

test('autoMapFromLists: si el pack con código no matchea, se prueba con cada modelo', async () => {
  packState.packs = [{ ...PACK_39000, sku: 'PACK-PROPIO' }];
  storeState.resolvedSkus = ['39000-CORAZONES', '39000-LUNA'];
  latestState.items = [ITEM_39000];

  await svc.autoMapFromLists();

  assert.equal(listState.packMap.length, 0);
  assert.deepEqual(listState.map.map((m) => m.sku).sort(), ['39000-CORAZONES', '39000-LUNA']);
});

test('getPreview: el mapeo automático no se repite en cada refresco (60 s)', async () => {
  storeState.resolvedSkus = ['39000-CORAZONES'];
  latestState.items = [ITEM_39000];
  await svc.getPreview();
  assert.equal(listState.map.length, 1);
  listState.map = [];
  await svc.getPreview();
  assert.equal(listState.map.length, 0, 'dentro de los 60 s no vuelve a correr');
});

test('getPreview: puebla el índice si está vacío y trae el nombre de la publicación', async () => {
  storeState.resolvedSkus = [];
  catalogState.mlRows = CATALOG.mlRows;
  catalogState.tnRows = CATALOG.tnRows;
  dbState.costs['30700'] = { sku: '30700', source: 'list', bulkPrice: 70400, bulkQty: 8, discount1: 0, discount2: 0, label: 'Descr. lista' };

  const rows = await svc.getPreview();

  assert.equal(rows[0].name, 'Cuaderno · Rosa');
  assert.ok(storeState.mlBySku['30700'], 'la ruta ya puede anotar mappedMl sin marcar "sin mapear"');
});

test('enqueueApply: con el índice vacío lo puebla antes de buscar el ítem de ML', async () => {
  storeState.resolvedSkus = [];
  catalogState.mlRows = CATALOG.mlRows;
  dbState.costs['30700'] = { sku: '30700', source: 'list', bulkPrice: 70400, bulkQty: 8, discount1: 0, discount2: 0 };

  const res = await svc.enqueueApply(['30700'], { ml: true, tn: false });

  assert.equal(res.enqueuedMl, 1);
});

// ── precio publicado y "pendiente de aplicar" ──────────────────────────────────────────────

test('buildSkuPrices: toma el precio de la publicación resuelta; 0 es desconocido', () => {
  const ml = [
    { sku: 'A', itemId: 'MLA1', variationId: '1', price: 5000 },
    { sku: 'A', itemId: 'MLA9', variationId: null, price: 9999 }, // SKU repetido en otra publicación
    { sku: 'B', itemId: 'MLA2', variationId: null, price: 0 },
  ];
  const tn = [{ sku: 'A', productId: 1, variantId: 11, price: 4500.5 }];
  const prices = svc.buildSkuPrices(ml, tn,
    (sku) => ({ A: { itemId: 'MLA1', variationId: '1' }, B: { itemId: 'MLA2' } })[sku] || null,
    (sku) => ({ A: { productId: 1, variantId: 11 } })[sku] || null);
  assert.deepEqual(prices.get('A'), { ml: 5000, tn: 4500.5 });
  assert.deepEqual(prices.get('B'), { ml: null, tn: null });
});

test('previewRow: pendiente solo si se conoce lo publicado y difiere del precio a aplicar', () => {
  const cost = { sku: 'X', source: 'manual', unitCost: 1000 };
  const calc = svc.previewRow(cost, DEFAULT_SETTINGS, null);
  assert.equal(calc.pendingMl, false, 'sin publicado no hay nada que comparar');
  const same = svc.previewRow(cost, DEFAULT_SETTINGS, null, { ml: calc.mlEffective, tn: calc.tn.effective + 0.2 });
  assert.equal(same.pendingMl, false);
  assert.equal(same.pendingTn, false, 'diferencias de centavos no cuentan');
  const diff = svc.previewRow(cost, DEFAULT_SETTINGS, null, { ml: calc.mlEffective - 100, tn: calc.tn.effective });
  assert.equal(diff.pendingMl, true);
  assert.equal(diff.pendingTn, false);
  // Con ajuste manual se compara contra el ajustado, no contra el calculado.
  const ov = svc.previewRow(cost, DEFAULT_SETTINGS, null, { tn: 7777 }, { tn: 7777 });
  assert.equal(ov.pendingTn, false);
});

test('getPreview: trae el publicado de la foto y marca pendiente / en cola', async () => {
  storeState.resolvedSkus = ['30700', 'OTRO'];
  storeState.mlBySku = { '30700': { itemId: 'MLA1' }, OTRO: { itemId: 'MLA2' } };
  storeState.tnBySku = { '30700': { productId: 1, variantId: 11 } };
  catalogState.mlRows = [
    { sku: '30700', itemId: 'MLA1', variationId: null, price: 100 },
    { sku: 'OTRO', itemId: 'MLA2', variationId: null, price: 100 },
  ];
  catalogState.tnRows = [{ sku: '30700', productId: 1, variantId: 11, price: 100 }];
  dbState.costs['30700'] = { sku: '30700', source: 'manual', unitCost: 1000 };
  dbState.costs.OTRO = { sku: 'OTRO', source: 'manual', unitCost: 1000 };
  dbState.activeTasks = [{ kind: 'price_ml', itemId: 'MLA2', variationId: null }];

  const rows = await svc.getPreview();
  const a = rows.find((r) => r.sku === '30700');
  const b = rows.find((r) => r.sku === 'OTRO');

  assert.equal(a.currentMl, 100);
  assert.equal(a.currentTn, 100);
  assert.equal(a.pendingMl, true);
  assert.equal(a.pendingTn, true);
  assert.equal(a.mlQueued, false);
  assert.equal(b.mlQueued, true, 'hay un price_ml encolado para su ítem');
});

test('enqueueApply: invalida la foto cacheada para que el preview vea lo recién publicado', async () => {
  storeState.resolvedSkus = ['30700'];
  await svc.loadCatalogContext();
  assert.equal(catalogState.calls, 1);
  dbState.costs['30700'] = { sku: '30700', source: 'manual', unitCost: 1000 };
  await svc.enqueueApply(['30700'], { ml: false, tn: false });
  await svc.loadCatalogContext();
  assert.equal(catalogState.calls, 2);
});

test('autoMapFromLists: lo que la usuaria sacó a mano no se vuelve a mapear solo', async () => {
  packState.packs = [PACK_39000];
  storeState.resolvedSkus = ['39000-SUELTO'];
  latestState.items = [ITEM_39000];
  await svc.autoMapFromLists();
  assert.equal(listState.packMap.length, 1);

  await svc.removePackMapping(7);
  await svc.removeMapping('39000-SUELTO');
  svc._resetAutoMapThrottle();
  const r = await svc.autoMapFromLists();

  assert.equal(r.newMappings, 0);
  assert.equal(listState.packMap.length, 0);
  assert.equal(listState.map.length, 0);
});

test('removeImportedList: borra la lista y avisa si no existía', async () => {
  assert.equal(await svc.removeImportedList(3), true);
  assert.equal(await svc.removeImportedList(404), false);
  assert.deepEqual(listState.deletedLists, [3, 404]);
});

// ── Proveedores y configuraciones de descuento ───────────────────────────────

const AGENDAS = { id: 2, name: 'Agendas', discount1: 30, discount2: 5, isDefault: false };
const AGENDA_PACK = { id: 7, name: 'Agendas 2027', sku: 'AG27', unitCount: 4, mode: 'assorted', skus: ['AG-ROSA', 'AG-AZUL'] };

test('getPreview: el descuento sale de la config (pack > default), con precio del bulto y por unidad', async () => {
  supplierState.suppliers[0].profiles[0] = { id: 1, name: 'General', discount1: 25, discount2: 5, isDefault: true };
  supplierState.suppliers[0].profiles.push({ ...AGENDAS });
  supplierState.assignments = [{ type: 'pack', id: '7', supplierKey: PC, profileId: 2 }];
  packState.packs = [AGENDA_PACK];
  dbState.costs['AG-ROSA'] = { sku: 'AG-ROSA', source: 'manual', bulkPrice: 40000, bulkQty: 4, supplierKey: PC };
  dbState.costs['CUAD'] = { sku: 'CUAD', source: 'manual', bulkPrice: 40000, bulkQty: 4, supplierKey: PC };

  const rows = await svc.getPreview();
  const agenda = rows.find((r) => r.sku === 'AG-ROSA');
  const cuaderno = rows.find((r) => r.sku === 'CUAD');

  assert.equal(agenda.bulkPrice, 40000);
  assert.equal(agenda.unitListPrice, 10000);
  assert.deepEqual(
    { name: agenda.discount.name, d1: agenda.discount.discount1, d2: agenda.discount.discount2, level: agenda.discount.level },
    { name: 'Agendas', d1: 30, d2: 5, level: 'pack' },
  );
  assert.equal(agenda.unitCost, 6650); // 10000 × 0,70 × 0,95
  assert.equal(cuaderno.discount.name, 'General');
  assert.equal(cuaderno.unitCost, 7125); // 10000 × 0,75 × 0,95
  assert.equal(agenda.supplierKey, PC);
  assert.deepEqual(agenda.suppliers, [PC]);
});

test('getPreview: editar una config mueve el costo de todo lo que la usa y lo marca pendiente', async () => {
  supplierState.suppliers[0].profiles.push({ ...AGENDAS });
  supplierState.assignments = [{ type: 'pack', id: '7', supplierKey: PC, profileId: 2 }];
  packState.packs = [AGENDA_PACK];
  dbState.costs['AG-ROSA'] = { sku: 'AG-ROSA', source: 'manual', bulkPrice: 40000, bulkQty: 4, supplierKey: PC };
  const before = (await svc.getPreview({ 'AG-ROSA': {} }))[0];

  await svc.editDiscountProfile(2, { discount1: 40 });
  const after = (await svc.getPreview({ 'AG-ROSA': { tn: before.tn.list } }))[0];

  assert.equal(after.unitCost, 5700); // 10000 × 0,60 × 0,95
  assert.ok(after.tn.list < before.tn.list);
  assert.equal(after.pendingTn, true);
});

test('getPreview: costo unitario directo no lleva descuento ni precio de bulto', async () => {
  dbState.costs['LAP'] = { sku: 'LAP', source: 'manual', unitCost: 300, supplierKey: PC };
  const [row] = await svc.getPreview();
  assert.equal(row.discount, null);
  assert.equal(row.bulkPrice, null);
  assert.equal(row.unitCost, 300);
});

test('assignDiscount: asignar a un pack entero saca la config propia de sus modelos', async () => {
  supplierState.suppliers[0].profiles.push({ ...AGENDAS }, { id: 3, name: 'Liquidación', discount1: 40, discount2: 0, isDefault: false });
  supplierState.assignments = [{ type: 'sku', id: 'AG-AZUL', supplierKey: PC, profileId: 3 }];
  packState.packs = [AGENDA_PACK];

  await svc.assignDiscount({ supplierKey: PC, targets: [{ type: 'pack', id: 7 }], profileId: 2 });

  assert.deepEqual(
    supplierState.assignments.map((a) => [a.type, a.id, a.profileId]).sort(),
    [['pack', '7', 2], ['sku', 'AG-AZUL', null]],
  );
});

test('assignDiscount: elegir la default guarda "sin config propia"; una config de otro proveedor es 400', async () => {
  await svc.assignDiscount({ supplierKey: PC, targets: [{ type: 'sku', id: 'CUAD' }], profileId: 1 });
  assert.deepEqual(supplierState.assignments, [{ type: 'sku', id: 'CUAD', supplierKey: PC, profileId: null }]);
  await assert.rejects(svc.assignDiscount({ supplierKey: PC, targets: [{ type: 'sku', id: 'CUAD' }], profileId: 99 }), { status: 400 });
});

test('confirmImport: la config elegida va solo a lo que no tiene config propia', async () => {
  supplierState.suppliers[0].profiles.push({ ...AGENDAS }, { id: 3, name: 'Especial', discount1: 10, discount2: 0, isDefault: false });
  storeState.resolvedSkus = ['30700', '39001'];
  supplierState.assignments = [{ type: 'sku', id: '39001', supplierKey: PC, profileId: 2 }];
  const parsed = await svc.previewImport(PDF_SNIPPET);

  const res = await svc.confirmImport({ label: 'Marzo', profileId: 3, rows: parsed.rows });

  const bySku = Object.fromEntries(supplierState.assignments.map((a) => [a.id, a.profileId]));
  assert.equal(bySku['30700'], 3); // no tenía config: toma la elegida
  assert.equal(bySku['39001'], 2); // ya tenía "Agendas": la conserva
  assert.equal(res.summary.profileName, 'Especial');
  assert.equal(res.summary.withChosenProfile, 1);
  assert.deepEqual(res.summary.withOwnProfile.map((e) => [e.sku, e.profileName]), [['39001', 'Agendas']]);
});

test('confirmImport: proveedor inexistente no guarda nada', async () => {
  const res = await svc.confirmImport({ label: 'X', supplierKey: 'nadie', rows: [{ code: '1', bulkQty: 1, bulkPrice: 1 }] });
  assert.equal(res.ok, false);
  assert.equal(listState.saved.length, 0);
});

test('applyListCosts: la lista de un proveedor no pisa a un SKU cuyo vigente es otro', async () => {
  dbState.storeCosts = true;
  supplierState.suppliers.push({ key: 'filgo', name: 'Filgo', profiles: [{ id: 5, name: 'General', discount1: 0, discount2: 0, isDefault: true }] });
  listState.items = [{ code: 'F1', bulkQty: 10, bulkPrice: 1000 }];
  listState.map = [
    { sku: 'LAP-AZUL', code: 'F1', matchSource: 'manual', supplier: 'filgo' },
    { sku: 'LAP-ROJO', code: 'F1', matchSource: 'manual', supplier: 'filgo' },
  ];
  dbState.costs['LAP-AZUL'] = { sku: 'LAP-AZUL', source: 'list', bulkPrice: 900, bulkQty: 10, supplierKey: PC };

  const { updated } = await svc.applyListCosts(null, 'filgo');

  assert.equal(updated, 1);
  assert.equal(dbState.costs['LAP-AZUL'].bulkPrice, 900); // sigue con Punto Cero (vigente)
  assert.equal(dbState.costs['LAP-ROJO'].supplierKey, 'filgo'); // no tenía vigente: queda Filgo
  assert.equal(dbState.costs['LAP-ROJO'].bulkPrice, 1000);
});

test('setVigenteSupplier: toma el costo de la última lista del nuevo proveedor; sin lista avisa', async () => {
  dbState.storeCosts = true;
  supplierState.suppliers.push({ key: 'filgo', name: 'Filgo', profiles: [{ id: 5, name: 'General', discount1: 0, discount2: 0, isDefault: true }] });
  latestState.items = [{ code: 'F1', bulkQty: 10, bulkPrice: 1100, supplier: 'filgo', description: 'Lapicera' }];
  listState.map = [{ sku: 'LAP-AZUL', code: 'F1', matchSource: 'manual', supplier: 'filgo' }];
  dbState.costs['LAP-AZUL'] = { sku: 'LAP-AZUL', source: 'list', bulkPrice: 900, bulkQty: 10, supplierKey: PC };
  dbState.costs['LAP-VERDE'] = { sku: 'LAP-VERDE', source: 'list', bulkPrice: 900, bulkQty: 10, supplierKey: PC };

  const res = await svc.setVigenteSupplier({ supplierKey: 'filgo', targets: [{ type: 'sku', id: 'LAP-AZUL' }, { type: 'sku', id: 'LAP-VERDE' }] });

  assert.equal(dbState.costs['LAP-AZUL'].supplierKey, 'filgo');
  assert.equal(dbState.costs['LAP-AZUL'].bulkPrice, 1100);
  assert.equal(dbState.costs['LAP-VERDE'].supplierKey, 'filgo');
  assert.equal(dbState.costs['LAP-VERDE'].bulkPrice, 900); // sin precio de Filgo: queda el costo
  assert.deepEqual(res.withoutPrice, ['LAP-VERDE']);
});

test('addSupplier / removeSupplier: clave desde el nombre sin repetir; no se borra uno en uso', async () => {
  const a = await svc.addSupplier({ name: 'Punto Cero' });
  assert.equal(a.key, 'punto_cero_2');
  const b = await svc.addSupplier({ name: 'Bic', discount1: 0 });
  assert.equal(b.key, 'bic');
  assert.equal(supplierState.suppliers.find((s) => s.key === 'bic').profiles[0].isDefault, true);
  await assert.rejects(svc.addSupplier({ name: '  ' }), { status: 400 });

  dbState.costs['X'] = { sku: 'X', supplierKey: 'bic' };
  await assert.rejects(svc.removeSupplier('bic'), { status: 409 });
  delete dbState.costs['X'];
  assert.deepEqual(await svc.removeSupplier('bic'), { ok: true });
});

test('removeDiscountProfile: la default no se borra', async () => {
  await assert.rejects(svc.removeDiscountProfile(1), { status: 409 });
  supplierState.suppliers[0].profiles.push({ ...AGENDAS });
  assert.deepEqual(await svc.removeDiscountProfile(2), { ok: true });
});

test('getConfig: proveedores con sus configs y cuántos productos usa cada una', async () => {
  supplierState.suppliers[0].profiles.push({ ...AGENDAS });
  supplierState.assignments = [{ type: 'pack', id: '7', supplierKey: PC, profileId: 2 }];
  packState.packs = [AGENDA_PACK];
  dbState.costs['AG-ROSA'] = { sku: 'AG-ROSA', bulkPrice: 1, bulkQty: 1, supplierKey: PC };
  dbState.costs['CUAD'] = { sku: 'CUAD', bulkPrice: 1, bulkQty: 1, supplierKey: PC };

  const { suppliers } = await svc.getConfig();

  assert.equal(suppliers[0].key, PC);
  assert.equal(suppliers[0].productCount, 3); // AG-ROSA, AG-AZUL (por el pack) y CUAD
  assert.deepEqual(suppliers[0].profiles.map((p) => [p.name, p.productCount]), [['General', 1], ['Agendas', 1]]);
});

/* ── Proveedor de un producto fuera de Precios (Crear/Editar producto, Productos) ── */

test('setProductSupplier: un producto que es pack entero se asigna al pack y guarda el costo en cada modelo', async () => {
  dbState.storeCosts = true;
  dbState.settings = { defaultMarginPct: 100 };
  supplierState.suppliers[0].profiles.push({ ...AGENDAS });
  packState.packs = [AGENDA_PACK];
  supplierState.assignments = [{ type: 'sku', id: 'AG-AZUL', supplierKey: PC, profileId: 1 }];

  const res = await svc.setProductSupplier({
    skus: ['AG-ROSA', 'AG-AZUL'], supplierKey: PC, profileId: 2,
    cost: { mode: 'bulk', bulkPrice: 12000, bulkQty: 12, marginPct: 100 },
  });

  assert.deepEqual(res.targets, [{ type: 'pack', id: '7' }]);
  assert.ok(supplierState.assignments.some((a) => a.type === 'pack' && a.id === '7' && a.profileId === 2));
  for (const sku of ['AG-ROSA', 'AG-AZUL']) {
    assert.equal(dbState.costs[sku].bulkPrice, 12000);
    assert.equal(dbState.costs[sku].supplierKey, PC);
    assert.equal(dbState.costs[sku].marginOverride, null); // igual al default de Ajustes
  }
  assert.deepEqual(res.changedSkus.sort(), ['AG-AZUL', 'AG-ROSA']);
});

test('setProductSupplier: SKUs sueltos van uno por uno; el pack explícito (nuevo de la alerta) gana', async () => {
  const sueltos = await svc.setProductSupplier({ skus: ['CUA-A', 'CUA-B'], supplierKey: PC, profileId: null });
  assert.deepEqual(sueltos.targets, [{ type: 'sku', id: 'CUA-A' }, { type: 'sku', id: 'CUA-B' }]);
  const conPack = await svc.setProductSupplier({ skus: ['CUA-A'], packId: 77, supplierKey: PC });
  assert.deepEqual(conPack.targets, [{ type: 'pack', id: '77' }]);
});

test('setProductSupplier bulk: una selección mezclada asigna el pack de los modelos y los sueltos por SKU', async () => {
  dbState.storeCosts = true;
  packState.packs = [AGENDA_PACK];
  supplierState.suppliers.push({ key: 'filgo', name: 'Filgo', profiles: [{ id: 5, name: 'General', discount1: 0, discount2: 0, isDefault: true }] });
  dbState.costs['LAP'] = { sku: 'LAP', source: 'list', bulkPrice: 900, bulkQty: 10, supplierKey: PC };

  const res = await svc.setProductSupplier({ skus: ['AG-ROSA', 'LAP'], supplierKey: 'filgo', bulk: true });

  assert.deepEqual(res.targets, [{ type: 'pack', id: '7' }, { type: 'sku', id: 'LAP' }]);
  assert.equal(dbState.costs['LAP'].supplierKey, 'filgo');
  assert.deepEqual(res.changedSkus, ['LAP']);
});

test('setProductSupplier: sin costo, un SKU con costo de otro proveedor pasa a este (vigente)', async () => {
  dbState.storeCosts = true;
  supplierState.suppliers.push({ key: 'filgo', name: 'Filgo', profiles: [{ id: 5, name: 'General', discount1: 0, discount2: 0, isDefault: true }] });
  dbState.costs['LAP'] = { sku: 'LAP', source: 'list', bulkPrice: 900, bulkQty: 10, supplierKey: PC };

  const res = await svc.setProductSupplier({ skus: ['LAP'], supplierKey: 'filgo' });

  assert.equal(dbState.costs['LAP'].supplierKey, 'filgo');
  assert.equal(dbState.costs['LAP'].bulkPrice, 900);
  assert.deepEqual(res.changedSkus, ['LAP']);
});

test('setProductSupplier: costo inválido no se guarda; sin productos es 400', async () => {
  dbState.storeCosts = true;
  await svc.setProductSupplier({ skus: ['X'], supplierKey: PC, cost: { mode: 'bulk', bulkPrice: 0, bulkQty: 10 } });
  assert.equal(dbState.costs['X'], undefined);
  await assert.rejects(svc.setProductSupplier({ skus: [], supplierKey: PC }), { status: 400 });
});

const FILGO = () => ({ key: 'filgo', name: 'Filgo', profiles: [{ id: 5, name: 'General', discount1: 0, discount2: 0, isDefault: true }, { id: 6, name: 'Bic', discount1: 10, discount2: 0, isDefault: false }] });

test('setProductSupplier con lista: suma proveedores con su config, cambia el vigente tomando su lista y saca los que no están', async () => {
  dbState.storeCosts = true;
  supplierState.suppliers.push(FILGO(), { key: 'bic', name: 'Bic', profiles: [{ id: 8, name: 'General', discount1: 0, discount2: 0, isDefault: true }] });
  supplierState.assignments = [
    { type: 'sku', id: 'LAP', supplierKey: PC, profileId: null },
    { type: 'sku', id: 'LAP', supplierKey: 'bic', profileId: null },
  ];
  listState.map = [{ sku: 'LAP', code: 'B-1', supplier: 'bic' }, { sku: 'LAP', code: 'F-9', supplier: 'filgo' }];
  latestState.items = [{ code: 'F-9', supplier: 'filgo', bulkPrice: 500, bulkQty: 10, description: 'Lapicera' }];
  dbState.costs['LAP'] = { sku: 'LAP', source: 'list', bulkPrice: 900, bulkQty: 10, supplierKey: PC };

  const res = await svc.setProductSupplier({
    skus: ['LAP'], supplierKey: 'filgo',
    suppliers: [{ supplierKey: PC, profileId: null }, { supplierKey: 'filgo', profileId: 6 }],
  });

  const of = (key) => supplierState.assignments.find((a) => a.id === 'LAP' && a.supplierKey === key);
  assert.ok(of(PC));
  assert.equal(of('filgo').profileId, 6);
  assert.equal(of('bic'), undefined, 'Bic ya no está en la lista: se saca');
  assert.ok(listState.removed.includes('sku:LAP'), 'y su código queda marcado como sacado');
  assert.equal(dbState.costs['LAP'].supplierKey, 'filgo');
  assert.equal(dbState.costs['LAP'].bulkPrice, 500, 'el vigente nuevo toma el precio de su lista');
  assert.deepEqual(res.changedSkus, ['LAP']);
  assert.deepEqual(res.withoutPrice, []);
});

test('setProductSupplier con lista: con proveedores pero sin vigente es 400; lista vacía saca todo', async () => {
  dbState.storeCosts = true;
  await assert.rejects(svc.setProductSupplier({ skus: ['LAP'], supplierKey: null, suppliers: [{ supplierKey: PC }] }), { status: 400 });
  supplierState.assignments = [{ type: 'sku', id: 'LAP', supplierKey: PC, profileId: null }];
  dbState.costs['LAP'] = { sku: 'LAP', source: 'manual', bulkPrice: 900, bulkQty: 10, supplierKey: PC };

  const res = await svc.setProductSupplier({ skus: ['LAP'], supplierKey: null, suppliers: [] });

  assert.deepEqual(supplierState.assignments, []);
  assert.equal(dbState.costs['LAP'].supplierKey, null);
  assert.equal(dbState.costs['LAP'].bulkPrice, 900, 'el costo no se toca');
  assert.deepEqual(res.changedSkus, ['LAP']);
});

test('setProductSupplier bulk con makeVigente false: suma el proveedor sin mover el costo', async () => {
  dbState.storeCosts = true;
  supplierState.suppliers.push(FILGO());
  dbState.costs['LAP'] = { sku: 'LAP', source: 'list', bulkPrice: 900, bulkQty: 10, supplierKey: PC };

  const res = await svc.setProductSupplier({ skus: ['LAP'], supplierKey: 'filgo', bulk: true, makeVigente: false });

  assert.ok(supplierState.assignments.some((a) => a.id === 'LAP' && a.supplierKey === 'filgo'));
  assert.equal(dbState.costs['LAP'].supplierKey, PC);
  assert.deepEqual(res.changedSkus, []);
});

test('removeProductSupplier: un pack saca la asignación del pack y de sus modelos, marca los códigos y avisa el vigente perdido', async () => {
  dbState.storeCosts = true;
  packState.packs = [AGENDA_PACK];
  supplierState.assignments = [
    { type: 'pack', id: '7', supplierKey: PC, profileId: null },
    { type: 'sku', id: 'AG-ROSA', supplierKey: PC, profileId: null },
    { type: 'pack', id: '7', supplierKey: 'filgo', profileId: null },
  ];
  dbState.costs['AG-ROSA'] = { sku: 'AG-ROSA', source: 'list', bulkPrice: 1, bulkQty: 1, supplierKey: PC };

  const res = await svc.removeProductSupplier({ skus: ['AG-ROSA', 'AG-AZUL'], packId: 7, supplierKey: PC });

  assert.deepEqual(supplierState.assignments, [{ type: 'pack', id: '7', supplierKey: 'filgo', profileId: null }]);
  assert.ok(listState.removed.includes('pack:7'));
  assert.ok(listState.removed.includes('sku:AG-AZUL'));
  assert.deepEqual(res.lostVigente, ['AG-ROSA']);
  assert.equal(dbState.costs['AG-ROSA'].supplierKey, null);
  await assert.rejects(svc.removeProductSupplier({ skus: ['X'] }), { status: 400 });
});

test('getProductSupplierOverview: la config de cada proveedor del producto', async () => {
  supplierState.suppliers.push(FILGO());
  supplierState.assignments = [
    { type: 'sku', id: 'LAP', supplierKey: PC, profileId: null },
    { type: 'sku', id: 'LAP', supplierKey: 'filgo', profileId: 6 },
  ];
  const ov = await svc.getProductSupplierOverview({ skus: ['LAP'] });
  assert.equal(ov.bySku['LAP'].discounts[PC].level, 'default');
  assert.equal(ov.bySku['LAP'].discounts['filgo'].profileId, 6);
});

test('getProductSupplierOverview: vigente, config que le toca y costo; sin costo usa el primer proveedor', async () => {
  supplierState.suppliers[0].profiles.push({ ...AGENDAS });
  packState.packs = [AGENDA_PACK];
  supplierState.assignments = [{ type: 'pack', id: '7', supplierKey: PC, profileId: 2 }];
  dbState.costs['AG-ROSA'] = { sku: 'AG-ROSA', source: 'manual', bulkPrice: 1000, bulkQty: 10, supplierKey: PC, marginOverride: 80 };

  const ov = await svc.getProductSupplierOverview();

  assert.equal(ov.bySku['AG-ROSA'].vigente, PC);
  assert.equal(ov.bySku['AG-ROSA'].discount.name, 'Agendas');
  assert.equal(ov.bySku['AG-ROSA'].discount.level, 'pack');
  assert.deepEqual(ov.bySku['AG-ROSA'].cost, { mode: 'bulk', bulkPrice: 1000, bulkQty: 10, unitCost: null, marginOverride: 80 });
  assert.equal(ov.bySku['AG-AZUL'].vigente, null); // sin costo todavía
  assert.equal(ov.bySku['AG-AZUL'].discount.name, 'Agendas');
  assert.deepEqual(ov.byPack['7'], [{ supplierKey: PC, profileId: 2 }]);
  const solo = await svc.getProductSupplierOverview({ skus: ['AG-ROSA'] });
  assert.deepEqual(Object.keys(solo.bySku), ['AG-ROSA']);
});
