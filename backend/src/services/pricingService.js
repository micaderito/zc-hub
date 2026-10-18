/**
 * Servicio de la sección de Precios (fase 2). Orquesta: valores fijos (pricing_settings + tiers) +
 * costos cargados (product_costs) → precios calculados con lib/pricing.js, y encola la aplicación
 * masiva en la cola durable de ML (price_ml) + el bulk de TN.
 *
 * La aritmética vive en lib/pricing.js (pura, testeada contra la planilla). Acá va solo el pegamento
 * con la DB y la resolución SKU → ítem de cada canal. Los helpers puros (buildSettings, costToInput,
 * previewRow) se exportan para testearlos sin base de datos.
 */

import {
  getPricingSettings, savePricingSettings, saveMlFeeTiers,
  getAllProductCosts, getProductCost, upsertProductCost, deleteProductCost,
  enqueueMlTask, insertPriceAudit, getPriceHistoryBySku,
  savePriceList, getPriceLists, getPriceListItems, getSupplierCodes,
  getSkuCodeMap, upsertSkuCodeMap, upsertProductCost as upsertCost,
  getPackCodeMap, upsertPackCodeMap, listPacks,
  getPriceOverrides, upsertPriceOverride, deletePriceOverride, getLatestPriceListItems,
  getActiveMlTasks, markSkuCodeRemoved, markPackCodeRemoved, getRemovedCodeMapKeys, deletePriceList,
  listSuppliers, createSupplier, renameSupplier, deleteSupplier, getSupplierUsage,
  createDiscountProfile, updateDiscountProfile, deleteDiscountProfile,
  listProductSuppliers, upsertProductSuppliers, clearSkuProfiles, deleteProductSuppliers, setCostSupplier,
} from '../db.js';
import { buildDiscountContext, resolveDiscount, suppliersOf, supplierKeyFromName, supplierTargets, bulkSupplierTargets } from '../lib/discountResolver.js';
import { patchTnPrice, readTnSnapshotRow, getCatalogRows } from './conflictsService.js';
import { rememberPriceWrite, forgetPriceWrite, tnPriceEchoKey } from '../lib/stockEcho.js';
import {
  getMlItemBySku, getTnVariantBySku, getResolvedSkus, getMlToken, setResolutionFromAnalysis,
} from '../store.js';
import { parseSupplierList, parseSupplierCsv } from '../lib/supplierListParser.js';
import { buildMappingSuggestions } from '../lib/skuMatcher.js';
import { buildSkuPackIndex } from '../lib/packIndex.js';
import { fetchFeeConfig } from '../lib/mlFees.js';
import { computePrices, mlNetReceived, DEFAULT_SETTINGS } from '../lib/pricing.js';
import * as tn from '../lib/tiendanube.js';
import { tokens } from '../store.js';

/**
 * Funde la config de la DB (o null si no hay DB) sobre DEFAULT_SETTINGS, quedándose con la forma
 * que espera lib/pricing.js. Puro y testeable.
 */
export function buildSettings(dbSettings) {
  if (!dbSettings) return { ...DEFAULT_SETTINGS };
  const merged = { ...DEFAULT_SETTINGS };
  for (const key of ['commissionPct', 'taxes', 'shippingCost', 'freeShippingThreshold', 'cardMultiplier', 'roundStep']) {
    if (dbSettings[key] != null) merged[key] = dbSettings[key];
  }
  if (Array.isArray(dbSettings.tiers) && dbSettings.tiers.length > 0) merged.tiers = dbSettings.tiers;
  return merged;
}

/**
 * Convierte una fila de product_costs en el input de computePrices, aplicando los defaults de la
 * config para la ganancia (si el producto no tiene override) y el descuento resuelto para el SKU.
 * Puro y testeable.
 */
export function costToInput(cost, dbSettings, discount = null) {
  const marginPct = cost.marginOverride != null
    ? cost.marginOverride
    : (dbSettings?.defaultMarginPct ?? 100);
  if (cost.source === 'list' || (cost.bulkPrice != null && cost.bulkQty != null)) {
    // `discount` = la config resuelta para el SKU (resolveDiscount); sin ella, la que trae el costo.
    return {
      bulkPrice: cost.bulkPrice,
      bulkQty: cost.bulkQty,
      discount1: discount ? discount.discount1 : (cost.discount1 ?? 0),
      discount2: discount ? discount.discount2 : (cost.discount2 ?? 0),
      marginPct,
    };
  }
  return { unitCost: cost.unitCost, marginPct };
}

/**
 * Calcula la fila de preview de un costo: precios nuevos + los actuales de cada canal (si se pasan)
 * para mostrar el delta. Puro y testeable.
 *
 * `overrides` es el ajuste manual del precio publicado, por canal (ver price_overrides): lo que
 * "debería" costar (la fórmula, en `tn.list`/`ml`) y lo que efectivamente se aplica (`tn.effective`/
 * `mlEffective`) pueden diferir a propósito — la usuaria a veces publica más, a veces menos. El
 * calculado NUNCA se pisa: sigue ahí como referencia aunque haya override.
 */
export function previewRow(cost, settings, dbSettings, current = {}, overrides = {}, discount = null) {
  const input = costToInput(cost, dbSettings, discount);
  const out = computePrices(input, settings);
  const byBulk = input.bulkQty > 0;
  const tnOverride = overrides.tn ?? null;
  const mlOverride = overrides.ml ?? null;
  const mlEffective = mlOverride ?? out.ml;
  return {
    sku: cost.sku,
    label: cost.label ?? null,
    source: cost.source,
    bulkQty: cost.bulkQty ?? null,
    // Precio del bulto tal cual la lista (bruto) y por unidad antes del descuento: "lo que dice la
    // lista", para ver al lado del costo unitario neto ("en cuánto me queda").
    bulkPrice: byBulk ? cost.bulkPrice ?? null : null,
    unitListPrice: byBulk && cost.bulkPrice != null ? round2(cost.bulkPrice / input.bulkQty) : null,
    // Solo tiene sentido con costo por bulto: un costo unitario directo ya es neto.
    discount: byBulk ? { ...(discount ?? { profileId: null, name: null, level: 'none' }), discount1: input.discount1, discount2: input.discount2 } : null,
    unitCost: round2(out.unitCost),
    valorFinal: out.valorFinal,
    tn: { ...out.tn, override: tnOverride, effective: tnOverride ?? out.tn.list },
    ml: out.ml,
    mlOverride,
    mlEffective,
    // "Te queda": neto de vender en ML al precio EFECTIVO (el ajustado a mano, si hay uno) — no
    // tiene sentido mostrar el neto de un precio que no es el que en realidad se va a publicar.
    mlNet: round2(mlNetReceived(mlEffective, settings)),
    currentMl: current.ml ?? null,
    currentTn: current.tn ?? null,
    // "Pendiente de aplicar": lo que se aplicaría no coincide con lo que hoy está publicado. Solo
    // si se conoce el publicado — sin publicación (o con precio desconocido) no hay nada que comparar.
    pendingMl: isPending(current.ml, mlEffective),
    pendingTn: isPending(current.tn, tnOverride ?? out.tn.list),
    // ¿el precio de ML cae en la zona de envío gratis? (para el aviso de zona muerta)
    freeShipping: out.ml > settings.freeShippingThreshold,
  };
}

/** Medio peso de tolerancia: TN guarda centavos y la fórmula redondea, ML no. */
function isPending(published, next) {
  return published != null && Math.abs(published - next) >= 0.5;
}

/**
 * sku → precio publicado hoy en cada canal, leído de la foto del catálogo. Toma la fila de la
 * publicación a la que el hub le aplicaría el precio (`resolveMl`/`resolveTn`, el índice de
 * store.js), no la primera que aparezca: con un SKU repetido, comparar contra otra publicación
 * marcaría pendiente algo que no lo está. Precio 0 en la foto = desconocido. Puro y testeable.
 *
 * @returns {Map<string, { ml: number|null, tn: number|null }>}
 */
export function buildSkuPrices(mlRows = [], tnRows = [], resolveMl = () => null, resolveTn = () => null) {
  const mlByKey = new Map(mlRows.map((r) => [`${r.itemId}:${r.variationId ?? ''}`, r]));
  const tnByKey = new Map(tnRows.map((r) => [`${r.productId}:${r.variantId}`, r]));
  const known = (v) => (Number(v) > 0 ? Number(v) : null);
  const skus = new Set([...mlRows, ...tnRows].map((r) => r.sku).filter(Boolean));
  const prices = new Map();
  for (const sku of skus) {
    const ml = resolveMl(sku);
    const tn = resolveTn(sku);
    const mlRow = ml ? mlByKey.get(`${ml.itemId}:${ml.variationId ?? ''}`) : null;
    const tnRow = tn ? tnByKey.get(`${tn.productId}:${tn.variantId}`) : null;
    prices.set(sku, { ml: known(mlRow?.price), tn: known(tnRow?.price) });
  }
  return prices;
}

/**
 * sku → nombre legible de la publicación: el de TN (producto · variante) si está, si no el de ML
 * (título · variación). Puro y testeable.
 */
export function buildSkuNames(mlRows = [], tnRows = []) {
  const names = new Map();
  // Una variante de TN sin valores propios trae el SKU como nombre: no se repite al lado del título.
  const join = (sku, ...parts) => parts.filter((p) => p && p !== sku).join(' · ') || null;
  for (const r of tnRows) {
    if (!r?.sku || names.has(r.sku)) continue;
    names.set(r.sku, join(r.sku, r.productName, r.variantName));
  }
  for (const r of mlRows) {
    if (!r?.sku || names.has(r.sku)) continue;
    names.set(r.sku, join(r.sku, r.title, r.variationName));
  }
  return names;
}

// Corto a propósito: los precios publicados salen de acá y, después de "Aplicar", la foto se
// parcha sola (patchTnPrice / patchMlPrice al terminar la tarea de la cola).
const CATALOG_TTL_MS = 15_000;
let catalogCache = null; // { at, names, prices }

/**
 * El índice SKU → publicación de ML/TN (store.js) vive solo en memoria y se llena al correr el
 * análisis de Conflictos / Precio y stock. Después de un deploy queda VACÍO hasta que alguien abre
 * esas pantallas, y Precios lo usa para todo: la tabla marcaba "sin mapear" cada fila, el import no
 * tenía productos contra los que matchear los códigos (0 costos actualizados) y "Aplicar" decía
 * "sin ítem de ML mapeado". Acá se lee la foto del catálogo (sin pegarle a ML/TN) y, si el índice
 * está vacío, se puebla — mismo criterio que ensureSkuResolved en syncService.js.
 *
 * De paso arma los nombres de cada SKU y su precio publicado hoy. Se cachea 15 s: la foto se lee
 * entera de Postgres y cuenta para el egress de Supabase, y la tabla se refresca después de cada
 * edición; "Aplicar" la invalida.
 */
export async function loadCatalogContext() {
  // Con la caché fresca alcanza, salvo que el índice se haya vaciado aunque la foto tenía SKUs.
  const indexLost = getResolvedSkus().length === 0 && catalogCache?.names.size > 0;
  if (catalogCache && !indexLost && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache;
  try {
    const { mlRows = [], tnRows = [] } = await getCatalogRows();
    if (getResolvedSkus().length === 0) setResolutionFromAnalysis(mlRows, tnRows);
    catalogCache = {
      at: Date.now(),
      names: buildSkuNames(mlRows, tnRows),
      prices: buildSkuPrices(mlRows, tnRows, getMlItemBySku, getTnVariantBySku),
    };
  } catch (e) {
    console.error('[Pricing] no se pudo leer el catálogo:', e.message);
    if (!catalogCache) return { at: 0, names: new Map(), prices: new Map() };
  }
  return catalogCache;
}

/** Olvida la caché de loadCatalogContext (después de aplicar, y en los tests). */
export function _resetCatalogCache() {
  catalogCache = null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** `Record<sku, { ml?, tn? }>` a partir de getPriceOverrides(), para lookup O(1) por SKU. */
async function buildOverridesBySku() {
  const rows = await getPriceOverrides();
  const bySku = {};
  for (const { sku, channel, value } of rows) {
    if (!bySku[sku]) bySku[sku] = {};
    bySku[sku][channel] = value;
  }
  return bySku;
}

/**
 * Arma de una vez (sin queries por fila) todo lo que hace falta para saber qué descuento lleva cada
 * SKU y a qué proveedores pertenece: proveedores + configs, asignaciones, packs, mapas de código de
 * todos los proveedores y el proveedor vigente de cada costo.
 */
export async function loadDiscountContext({ costs = null, packs = null } = {}) {
  const [suppliers, assignments, packRows, skuCodeMap, packCodeMap, costRows] = await Promise.all([
    listSuppliers(), listProductSuppliers(), packs ?? listPacks(), getSkuCodeMap(null), getPackCodeMap(null),
    costs ?? getAllProductCosts(),
  ]);
  return buildDiscountContext({ suppliers, assignments, packs: packRows, skuCodeMap, packCodeMap, costs: costRows });
}

/** Config completa para la UI (valores fijos + tramos), con fallback a los defaults. */
export async function getConfig() {
  const [db, suppliers] = await Promise.all([getPricingSettings(), getSuppliersWithUsage()]);
  const settings = buildSettings(db);
  return {
    settings: {
      commissionPct: settings.commissionPct,
      taxes: settings.taxes,
      shippingCost: settings.shippingCost,
      freeShippingThreshold: settings.freeShippingThreshold,
      cardMultiplier: settings.cardMultiplier,
      roundStep: settings.roundStep,
      defaultMarginPct: db?.defaultMarginPct ?? DEFAULT_SETTINGS.defaultMarginPct ?? 100,
      defaultDiscount1: db?.defaultDiscount1 ?? 25,
      defaultDiscount2: db?.defaultDiscount2 ?? 5,
    },
    tiers: settings.tiers.map((t) => ({
      maxPrice: Number.isFinite(t.maxPrice) ? t.maxPrice : null,
      fixedFee: t.fixedFee,
    })),
    updatedAt: db?.updatedAt ?? null,
    suppliers,
  };
}

/**
 * Proveedores con sus configs y cuántos productos usa cada una (entre los que tienen costo con ese
 * proveedor vigente), más cuántos productos tiene cada proveedor (vigente o no).
 */
async function getSuppliersWithUsage() {
  const costs = await getAllProductCosts();
  const ctx = await loadDiscountContext({ costs });
  const byProfile = new Map();
  const bySupplier = new Map();
  for (const sku of new Set([...ctx.suppliersBySku.keys(), ...costs.map((c) => c.sku)])) {
    for (const key of suppliersOf(sku, ctx)) bySupplier.set(key, (bySupplier.get(key) || 0) + 1);
  }
  for (const c of costs) {
    const d = resolveDiscount(c.sku, ctx);
    if (d.profileId != null) byProfile.set(d.profileId, (byProfile.get(d.profileId) || 0) + 1);
  }
  const suppliers = [];
  for (const key of ctx.supplierNames.keys()) {
    const profiles = [...ctx.profilesById.values()]
      .filter((pr) => pr.supplierKey === key)
      .map((pr) => ({ ...pr, productCount: byProfile.get(pr.id) || 0 }));
    suppliers.push({ key, name: ctx.supplierNames.get(key), productCount: bySupplier.get(key) || 0, profiles });
  }
  return suppliers;
}

export async function saveConfig(patch) {
  await savePricingSettings(patch);
  if (Array.isArray(patch?.tiers)) await saveMlFeeTiers(patch.tiers);
  return getConfig();
}

/**
 * Preview de TODOS los costos cargados: precios calculados + lo que hoy está publicado en cada
 * canal (de la foto del catálogo), para marcar qué falta aplicar. `currentBySku` (opcional) pisa
 * los publicados — lo usan los tests.
 *
 * `mlQueued`: hay un `price_ml` encolado para ese ítem (se aplicó pero la cola de ML todavía no lo
 * escribió). Sin esto, justo después de "Aplicar" la fila seguiría diciendo "pendiente".
 */
export async function getPreview(currentBySku = null) {
  const { names, prices } = await loadCatalogContext();
  // Lo que coincide con un código y todavía no está mapeado toma su costo antes de armar la planilla.
  await autoMapFromLists(names, { throttle: true });
  const db = await getPricingSettings();
  const settings = buildSettings(db);
  const [costs, packs, overridesBySku, activeTasks] = await Promise.all([
    getAllProductCosts(), listPacks(), buildOverridesBySku(), getActiveMlTasks(),
  ]);
  const ctx = await loadDiscountContext({ costs, packs });
  const packBySku = buildSkuPackIndex(packs);
  const queuedItems = new Set(activeTasks.filter((t) => t.kind === 'price_ml').map((t) => String(t.itemId)));
  return costs.map((cost) => ({
    ...previewRow(
      cost, settings, db,
      (currentBySku ? currentBySku[cost.sku] : prices?.get(cost.sku)) || {},
      overridesBySku[cost.sku] || {},
      resolveDiscount(cost.sku, ctx),
    ),
    // Proveedor vigente (el que manda el costo) y todos a los que se le compra, el vigente primero.
    supplierKey: cost.supplierKey ?? null,
    suppliers: suppliersOf(cost.sku, ctx),
    mlQueued: queuedItems.has(String(getMlItemBySku(cost.sku)?.itemId ?? '')),
    // Nombre de la publicación: en un pack todos los modelos traen la MISMA descripción de la
    // lista (`label`), así que sin esto no hay forma de distinguirlos.
    name: names.get(cost.sku) ?? null,
    pack: packBySku.get(cost.sku) || null,
  }));
}

/**
 * Productos que tienen proveedor (asignado en Productos / Crear producto, o con código mapeado) pero
 * todavía NO tienen costo: la planilla se arma solo con costos, así que sin esto la pestaña de un
 * proveedor nuevo decía "0" aunque ya tuviera productos. Se listan aparte para cargarles el costo.
 */
export async function getUncostedSupplierProducts() {
  const { names } = await loadCatalogContext();
  const [costs, packs] = await Promise.all([getAllProductCosts(), listPacks()]);
  const ctx = await loadDiscountContext({ costs, packs });
  const costed = new Set(costs.map((c) => c.sku));
  const packBySku = buildSkuPackIndex(packs);
  return [...ctx.suppliersBySku.keys()]
    .filter((sku) => !costed.has(sku))
    .map((sku) => ({ sku, name: names.get(sku) ?? null, suppliers: suppliersOf(sku, ctx), pack: packBySku.get(sku) || null }))
    .sort((a, b) => (a.name ?? a.sku).localeCompare(b.name ?? b.sku, 'es'));
}

/** Fija (o corrige) el precio publicado a mano de un SKU en un canal. `value: null` lo saca. */
export async function saveOverride(sku, channel, value) {
  if (value == null) return deletePriceOverride(sku, channel);
  return upsertPriceOverride(sku, channel, value);
}

/**
 * Alta/edición manual de un costo. `supplierKey` = proveedor vigente (`null` = sin proveedor: sin
 * descuento); `profileId` (si viene) asigna la config de descuento del SKU para ese proveedor
 * (`null` = la default / la del pack). Los % sueltos ya no se guardan: el descuento sale de la config.
 */
export async function saveCost(sku, data = {}) {
  const { profileId, ...rest } = data;
  await upsertProductCost(sku, { ...rest, discount1: 0, discount2: 0 });
  if (rest.supplierKey && profileId !== undefined) {
    await upsertProductSuppliers(rest.supplierKey, [{ type: 'sku', id: sku }], profileId ?? null);
  }
  return getProductCost(sku);
}

export async function removeCost(sku) {
  return deleteProductCost(sku);
}

/** Historial de precios de un SKU (ambos canales), para el modal de historial del producto. */
export async function getPriceHistory(sku, limit = 50, offset = 0) {
  return getPriceHistoryBySku(sku, limit, offset);
}

/**
 * Aplicación masiva. Para cada SKU: calcula el precio y lo ENCOLA (no aplica de una) —
 * un `price_ml` por SKU en la cola durable (sobrevive 429 y reinicios, ver mlTaskQueue.js) y el
 * bulk de TN. Devuelve el detalle por SKU (encolado / omitido y por qué).
 *
 * @param {string[]} skus SKUs a aplicar (deben tener costo cargado).
 * @param {{ ml?: boolean, tn?: boolean }} channels qué canales aplicar (default ambos).
 */
export async function enqueueApply(skus, channels = { ml: true, tn: true }) {
  if (getResolvedSkus().length === 0) await loadCatalogContext();
  const db = await getPricingSettings();
  const settings = buildSettings(db);
  const overridesBySku = await buildOverridesBySku();
  const ctx = await loadDiscountContext();
  const results = [];
  const tnBatch = [];

  for (const sku of skus) {
    const cost = await getProductCost(sku);
    if (!cost) {
      results.push({ sku, ok: false, reason: 'sin costo cargado' });
      continue;
    }
    const prices = computePrices(costToInput(cost, db, resolveDiscount(sku, ctx)), settings);
    // Lo que se aplica es el ajustado a mano si lo hay, no siempre el calculado (ver price_overrides).
    const overrides = overridesBySku[sku] || {};
    const mlPrice = overrides.ml ?? prices.ml;
    const tnPrice = overrides.tn ?? prices.tn.list;

    // ── Mercado Libre: encolar price_ml ──
    if (channels.ml !== false) {
      const mlItem = getMlItemBySku(sku);
      if (!mlItem) {
        results.push({ sku, channel: 'ml', ok: false, reason: 'sin ítem de ML mapeado' });
      } else {
        const taskId = await enqueueMlTask({
          kind: 'price_ml',
          itemId: mlItem.itemId,
          variationId: mlItem.variationId ?? null,
          targetPrice: mlPrice,
          idempotencyKey: `price_ml:${mlItem.itemId}:${mlPrice}`,
          contextJson: JSON.stringify({ sku, source: 'bulk' }),
        });
        results.push({ sku, channel: 'ml', ok: true, taskId, price: mlPrice });
      }
    }

    // ── Tienda Nube: se publica el precio de lista (o el ajustado), vía bulk ──
    if (channels.tn !== false) {
      const tnVariant = getTnVariantBySku(sku);
      if (!tnVariant) {
        results.push({ sku, channel: 'tn', ok: false, reason: 'sin variante de TN mapeada' });
      } else {
        tnBatch.push({
          productId: tnVariant.productId, variantId: tnVariant.variantId,
          price: tnPrice, sku, label: cost.label ?? null,
        });
        results.push({ sku, channel: 'tn', ok: true, price: tnPrice });
      }
    }
  }

  // El bulk de TN se manda de una (updateVariantsStockPrice ya parte en chunks de 50 y respeta
  // tnLimiter). Si falla, se marca el lote como fallido en el resultado.
  if (tnBatch.length > 0) {
    const { access_token, store_id } = tokens.tiendanube || {};
    if (!access_token) {
      for (const r of results) if (r.channel === 'tn' && r.ok) { r.ok = false; r.reason = 'sin token TN'; }
    } else {
      // El precio previo se lee de la foto ANTES del bulk, no después: la escritura dispara el
      // webhook `product/updated` de TN por cada variante casi en el acto, y ese refresh puede
      // mover la foto al valor nuevo antes de que este loop llegue a leerla (mismo motivo que en
      // ML — ver readTnSnapshotRow).
      const beforeByKey = new Map();
      for (const b of tnBatch) {
        const before = await readTnSnapshotRow(b.productId, b.variantId).catch((e) => {
          console.error('[Pricing] readTnSnapshotRow:', e.message);
          return null;
        });
        beforeByKey.set(`${b.productId}:${b.variantId}`, before);
        // Eco antes del bulk: el refresh por `product/updated` no tiene que registrar esta
        // escritura como "Cambio en TN" (ver stockEcho.js).
        rememberPriceWrite(tnPriceEchoKey(b.productId, b.variantId), b.price);
      }
      try {
        await tn.updateVariantsStockPrice(access_token, store_id, tnBatch.map((b) => ({
          productId: b.productId, variantId: b.variantId, price: b.price,
        })));
        // Aplicado en TN: parchamos el snapshot por variante para que quede al día. La foto ya
        // puede estar al día por el webhook; el historial usa el valor previo leído arriba, no lo
        // que devuelva este parche.
        for (const b of tnBatch) {
          await patchTnPrice(b.productId, b.variantId, b.price).catch((e) => console.error('[Pricing] patchTnPrice:', e.message));
          const before = beforeByKey.get(`${b.productId}:${b.variantId}`);
          if (before && before.price !== b.price) {
            await insertPriceAudit({
              sku: b.sku,
              channel: 'tiendanube',
              priceBefore: before.price,
              priceAfter: b.price,
              source: 'bulk',
              productLabel: b.label ?? null,
            }).catch((e) => console.error('[Pricing] insertPriceAudit:', e.message));
          } else if (!before) {
            // Sin fila en la foto no hay "antes", pero el SKU lo conocemos: el "a cuánto quedó"
            // ya es información útil (insertPriceAudit admite priceBefore null).
            await insertPriceAudit({
              sku: b.sku,
              channel: 'tiendanube',
              priceBefore: null,
              priceAfter: b.price,
              source: 'bulk',
              productLabel: b.label ?? null,
            }).catch((e) => console.error('[Pricing] insertPriceAudit:', e.message));
          }
        }
      } catch (e) {
        for (const b of tnBatch) forgetPriceWrite(tnPriceEchoKey(b.productId, b.variantId));
        for (const r of results) if (r.channel === 'tn' && r.ok) { r.ok = false; r.reason = `bulk TN falló: ${e.message}`; }
      }
    }
  }

  // Lo publicado cambió (TN ya, ML al terminar la cola): la próxima lectura no usa la foto cacheada.
  _resetCatalogCache();

  return {
    total: skus.length,
    enqueuedMl: results.filter((r) => r.channel === 'ml' && r.ok).length,
    appliedTn: results.filter((r) => r.channel === 'tn' && r.ok).length,
    failed: results.filter((r) => r.ok === false).length,
    results,
  };
}

// ── Importación de listas y mapeo (fase 4) ────────────────────────────────────

/** El proveedor de siempre: lo que llega sin proveedor (rutas viejas, tests) es de Punto Cero. */
export const DEFAULT_SUPPLIER = 'punto_cero';

/**
 * Entidades contra las que se intenta mapear cada código de la lista: los packs con SKU propio
 * (product_packs.sku) van PRIMERO y de forma exclusiva — si un pack tiene su propio código, sus
 * SKUs miembro se sacan de la lista de productos sueltos, porque el precio real es el del pack, no
 * el de cada modelo (un pack surtido puede juntar productos sin ninguna relación textual entre sí,
 * así que matchear por SKU individual no serviría). Un pack SIN código propio no cambia nada: sus
 * miembros se siguen mapeando uno por uno, como antes de esto — es el caso, por ejemplo, del pack
 * de repuestos que es el mismo SKU ×8: ahí el propio SKU del producto YA matchea directo.
 *
 * Los productos sueltos llevan `name` (el nombre de la publicación) solo para mostrarlo: NO va en
 * `label`, que es lo que usa el escalón "parecido por descripción" del matcher — con tres listas,
 * matchear por texto cada producto contra cada lista llenaría el import de sugerencias falsas.
 *
 * @param {Map<string, string|null>} [names] sku → nombre de la publicación (loadCatalogContext)
 * @returns {Promise<{ entities: Array, packMemberSkus: Set<string>, packs: Array }>} `entities` son
 *   objetos `{ sku, label?, name?, isPack, packId?, memberSkus? }` listos para buildMappingSuggestions.
 */
async function buildMatchEntities(names = new Map()) {
  const packs = await listPacks();
  const packsWithCode = packs.filter((pk) => pk.sku);
  const packMemberSkus = new Set(packsWithCode.flatMap((pk) => pk.skus));

  const packEntities = packsWithCode.map(packEntity);
  const productEntities = getResolvedSkus()
    .filter((sku) => !packMemberSkus.has(sku))
    .map((sku) => skuEntity(sku, names));

  return { entities: [...packEntities, ...productEntities], packMemberSkus, packs };
}

/** Entidad de matcheo de un pack con SKU propio. `key` la identifica: los packs NO tienen SKU único. */
function packEntity(pk) {
  return { key: `pack:${pk.id}`, sku: pk.sku, label: pk.name, name: pk.name, isPack: true, packId: pk.id, memberSkus: pk.skus };
}

function skuEntity(sku, names) {
  return { key: `sku:${sku}`, sku, name: names.get(sku) ?? null, isPack: false };
}

/** sku_code_map + pack_code_map DE UN PROVEEDOR fundidos en un solo `Record<entityKey, código>`
 *  (`pack:<id>` / `sku:<sku>`, la clave de las entidades de buildMatchEntities). Sirve para que
 *  buildMappingSuggestions reconozca lo ya confirmado sin volver a preguntar. */
async function buildSavedMap(supplierKey = DEFAULT_SUPPLIER) {
  const [skuRows, packRows] = await Promise.all([getSkuCodeMap(supplierKey), getPackCodeMap(supplierKey)]);
  return {
    ...Object.fromEntries(skuRows.map((r) => [`sku:${r.sku}`, r.code])),
    ...Object.fromEntries(packRows.map((r) => [`pack:${r.packId}`, r.code])),
  };
}

/** Versión corta de una entidad para listarla en la UI (resumen del import). */
function briefEntity(e, code = null) {
  return {
    sku: e.sku,
    name: e.name ?? e.label ?? null,
    isPack: !!e.isPack,
    packId: e.packId ?? null,
    memberCount: e.isPack ? (e.memberSkus || []).length : null,
    code,
  };
}

/**
 * Reparte el resultado del matcher según la lista que se está importando. Hace falta porque
 * `auto` del matcher incluye los mapeos YA guardados aunque su código sea de OTRA lista (la
 * usuaria trabaja con 3 listas): contarlos como "mapeos automáticos" de esta lista hacía que el
 * import dijera "34 mapeos" y "0 costos actualizados" a la vez. Puro y testeable.
 *
 *  - inList:       tiene código y ese código está en esta lista → toma el precio de acá
 *  - otherLists:   tiene código, pero de otra lista → esta lista no lo toca
 *  - review:       sugerencia a confirmar (base / grupo / texto)
 *  - unmatched:    sin código y sin sugerencia
 *  - codesWithoutProduct: códigos de esta lista que no quedaron asignados a nada (ni a un
 *    producto, ni a un pack, ni como sugerencia pendiente) — candidatos a mapear a mano
 *
 * @param {{ auto: Array, review: Array, unmatched: Array }} mapping de buildMappingSuggestions
 * @param {Array<{ code: string, description?: string }>} listCodes códigos de la lista
 * @param {Set<string>} [extraMappedCodes] códigos mapeados por fuera de las entidades (p. ej. el
 *   mapeo individual de un modelo que además está en un pack con código)
 */
export function splitMappingByList(mapping, listCodes, extraMappedCodes = new Set()) {
  const codeSet = new Set(listCodes.map((c) => c.code));
  const inList = [];
  const otherLists = [];
  for (const e of mapping.auto) {
    const code = e.suggestion?.code;
    if (code && codeSet.has(code)) inList.push(briefEntity(e, code));
    else otherLists.push(briefEntity(e, code ?? null));
  }
  const used = new Set([
    ...inList.map((e) => e.code),
    ...mapping.review.map((e) => e.suggestion?.code).filter(Boolean),
    ...extraMappedCodes,
  ]);
  const seen = new Set();
  const codesWithoutProduct = [];
  for (const c of listCodes) {
    if (used.has(c.code) || seen.has(c.code)) continue;
    seen.add(c.code);
    codesWithoutProduct.push({ code: c.code, description: c.description ?? null });
  }
  return {
    inList,
    otherLists,
    review: mapping.review,
    unmatched: mapping.unmatched.map((e) => briefEntity(e)),
    codesWithoutProduct,
  };
}

/**
 * Parsea el texto de una lista SIN guardar nada: devuelve las filas, las marcadas para revisión y
 * las sugerencias de mapeo contra los SKUs y los packs del hub, con los códigos de ESE proveedor.
 *
 * @param {string} text texto del PDF (ya extraído) o contenido de un CSV
 * @param {{ format?: 'pdf'|'csv', supplierKey?: string }} [opts]
 */
export async function previewImport(text, opts = {}) {
  const supplierKey = opts.supplierKey || DEFAULT_SUPPLIER;
  const parsed = opts.format === 'csv' ? parseSupplierCsv(text) : parseSupplierList(text);
  const { names } = await loadCatalogContext();

  // Códigos que trae esta lista, para sugerir el mapeo de los SKUs/packs que todavía no lo tienen.
  const codes = parsed.valid.map((r) => ({ code: r.code, description: r.description }));
  const { entities } = await buildMatchEntities(names);
  const savedMap = await buildSavedMap(supplierKey);
  const mappedCodes = new Set([...(await getSkuCodeMap(supplierKey)).map((m) => m.code), ...Object.values(savedMap)]);
  const split = splitMappingByList(buildMappingSuggestions(entities, codes, savedMap), codes, mappedCodes);

  return {
    stats: parsed.stats,
    rows: parsed.rows,
    flagged: parsed.flagged,
    mapping: {
      auto: split.inList.length,
      otherLists: split.otherLists.length,
      review: split.review,
      unmatched: split.unmatched.length,
      inListItems: split.inList,
      unmatchedItems: split.unmatched,
      codesWithoutProduct: split.codesWithoutProduct,
    },
  };
}

/** Target de product_suppliers de una entidad de matcheo / resumen. */
const targetOf = (e) => (e.isPack ? { type: 'pack', id: String(e.packId) } : { type: 'sku', id: e.sku });

/**
 * Confirma la importación: guarda la lista + sus ítems + el catálogo de códigos (todo del
 * proveedor elegido), aplica los mapeos automáticos, asigna la config de descuento elegida a lo de
 * esta lista que NO tiene config propia (lo que ya tiene una la conserva: los packs de agendas
 * siguen en "Agendas" aunque la lista venga con "General"), y actualiza el costo de cada SKU/pack
 * mapeado con el precio de esta lista. Devuelve el resumen de qué tomó precio de esta lista y qué no.
 *
 * @param {{ label, sourceFilename?, supplierKey?, profileId?: number|null, rows, format? }} input
 *   `profileId` ausente/null = la default del proveedor.
 */
export async function confirmImport({ label, sourceFilename, supplierKey = DEFAULT_SUPPLIER, profileId = null, rows, format }) {
  const items = (rows || []).filter((r) => r?.valid !== false && r?.code);
  const { names } = await loadCatalogContext();
  const supplier = (await listSuppliers()).find((s) => s.key === supplierKey);
  if (!supplier) return { ok: false, error: 'El proveedor no existe' };
  const profile = supplier.profiles.find((pr) => pr.id === profileId) ?? supplier.profiles.find((pr) => pr.isDefault) ?? null;
  // La lista guarda los % de la config con la que se importó, solo para el historial de listas.
  const listId = await savePriceList({
    supplier: supplierKey, label, sourceFilename, items,
    discount1: profile?.discount1 ?? 0, discount2: profile?.discount2 ?? 0,
  });
  if (!listId) return { ok: false, error: 'No se pudo guardar la lista' };

  // Mapeos que se aplican solos (código igual, o `CODIGO-variante`) contra TODAS las listas: la
  // recién guardada ya es la más reciente.
  const codes = items.map((r) => ({ code: r.code, description: r.description }));
  const { newMappings } = await autoMapFromLists(names);
  const { entities } = await buildMatchEntities(names);

  // Resumen con los mapeos YA guardados (incluye lo que se confirmó a mano antes de este POST):
  // lo pendiente que no se confirmó queda como "sin código".
  const savedMap = await buildSavedMap(supplierKey);
  const after = buildMappingSuggestions(entities, codes, savedMap);
  const confirmed = {
    auto: after.auto.filter((e) => e.suggestion.matchSource === 'saved'),
    review: [],
    unmatched: [...after.unmatched, ...after.review, ...after.auto.filter((e) => e.suggestion.matchSource !== 'saved')],
  };
  const skuMapCodes = new Set((await getSkuCodeMap(supplierKey)).map((m) => m.code));
  const split = splitMappingByList(confirmed, codes, skuMapCodes);

  // Config de descuento: la elegida va a lo que no tiene config propia para este proveedor; el
  // resto solo queda dado de alta en el proveedor (sin tocar su config).
  const ctx = await loadDiscountContext();
  const ownConfig = (e) => (e.isPack
    ? ctx.packProfile.has(`${supplierKey}|${e.packId}`)
    : ['sku', 'pack'].includes(resolveDiscount(e.sku, ctx, supplierKey).level));
  const free = split.inList.filter((e) => !ownConfig(e));
  const kept = split.inList.filter(ownConfig);
  const chosenId = profile && !profile.isDefault ? profile.id : null;
  await upsertProductSuppliers(supplierKey, free.map(targetOf), chosenId, { onlyIfMissing: true });
  await upsertProductSuppliers(supplierKey, kept.map(targetOf), null, { onlyIfMissing: true });

  const { updated, changedSkus } = await applyListCosts(listId, supplierKey);
  if (chosenId != null) {
    const packsById = new Map((await listPacks()).map((pk) => [pk.id, pk]));
    for (const e of free) changedSkus.push(...(e.isPack ? packsById.get(e.packId)?.skus ?? [] : [e.sku]));
  }

  return {
    ok: true,
    listId,
    autoMapped: split.inList.length,
    newMappings,
    costsUpdated: updated,
    changedSkus: [...new Set(changedSkus)],
    summary: {
      inList: split.inList,
      otherLists: split.otherLists.length,
      unmatched: split.unmatched,
      codesWithoutProduct: split.codesWithoutProduct,
      // Qué config de descuento le tocó a lo de esta lista.
      profileName: profile?.name ?? null,
      withChosenProfile: free.length,
      withOwnProfile: kept.map((e) => ({ ...e, profileName: e.isPack
        ? ctx.profilesById.get(ctx.packProfile.get(`${supplierKey}|${e.packId}`))?.name ?? null
        : resolveDiscount(e.sku, ctx, supplierKey).name })),
    },
  };
}

/**
 * Vuelca el precio de un ítem de lista de `supplierKey` al costo de un SKU. Solo si ese proveedor
 * es el vigente del SKU, o el SKU todavía no tiene ninguno (y pasa a serlo): con dos proveedores,
 * la lista del que no es vigente no pisa el costo (el vigente se elige a mano).
 * @returns {Promise<{ ok: boolean, changed: boolean, skipped?: boolean }>} `changed` = el costo se movió
 */
async function applyItemCost(sku, item, supplierKey, label = null) {
  const prev = await getProductCost(sku);
  if (prev?.supplierKey && prev.supplierKey !== supplierKey) return { ok: false, changed: false, skipped: true };
  const ok = await upsertCost(sku, {
    source: 'list', bulkPrice: item.bulkPrice, bulkQty: item.bulkQty, label, supplierKey,
    // Se conserva la ganancia propia del producto: la lista solo trae el costo.
    marginOverride: prev?.marginOverride ?? null,
  });
  if (!ok) return { ok: false, changed: false };
  const changed = !prev || prev.bulkPrice !== item.bulkPrice || prev.bulkQty !== item.bulkQty || prev.supplierKey !== supplierKey;
  return { ok: true, changed };
}

const hasBulkPrice = (item) => !!item && item.bulkPrice > 0 && item.bulkQty > 0;

/**
 * Vuelca los precios de una lista (de `supplierKey`) a `product_costs`, con los mapas de código
 * de ese proveedor. Primero los packs con código propio: el mismo costo se vuelca a TODOS sus SKUs
 * miembro (mismo precio, mismo cálculo — es "el mismo pedido al proveedor" aunque adentro tenga
 * modelos distintos). Después los SKUs sueltos — si uno de esos SKUs también quedó con un mapeo
 * individual guardado (de antes de tener pack, o a mano), ese mapeo pisa el costo que dejó el pack,
 * porque es más específico. El descuento NO se copia: sale de la config (resolveDiscount).
 *
 * También reporta `changedSkus`: los SKUs donde el costo que deja ESTA lista es distinto del que
 * tenían antes (o no tenían ninguno) — es lo que le permite al front resaltar, después de
 * importar, cuáles filas se movieron de verdad y cuáles quedaron iguales.
 *
 * @returns {{ updated: number, changedSkus: string[] }}
 */
export async function applyListCosts(listId = null, supplierKey = DEFAULT_SUPPLIER) {
  const items = await getPriceListItems(listId);
  if (items.length === 0) return { updated: 0, changedSkus: [] };
  const byCode = new Map(items.map((i) => [i.code, i]));

  let updated = 0;
  const changedSkus = [];
  const applyOne = async (sku, item, label) => {
    const r = await applyItemCost(sku, item, supplierKey, label);
    if (!r.ok) return;
    updated++;
    if (r.changed) changedSkus.push(sku);
  };

  const packMap = await getPackCodeMap(supplierKey);
  if (packMap.length > 0) {
    const packsById = new Map((await listPacks()).map((pk) => [pk.id, pk]));
    for (const { packId, code } of packMap) {
      const item = byCode.get(code);
      const pack = packsById.get(packId);
      if (!pack || !hasBulkPrice(item)) continue;
      for (const sku of pack.skus) await applyOne(sku, item, item.description || pack.name);
    }
  }

  const map = await getSkuCodeMap(supplierKey);
  for (const { sku, code } of map) {
    const item = byCode.get(code);
    if (!hasBulkPrice(item)) continue;
    await applyOne(sku, item, item.description);
  }
  return { updated, changedSkus };
}

/**
 * Vuelca a `skus` el precio del código en la lista MÁS RECIENTE de `supplierKey` que lo trae. Es lo
 * que hace que mapear un código a mano tome el precio en el momento, sin tener que volver a
 * importar la lista.
 */
async function applyLatestCostForCode(skus, code, supplierKey = DEFAULT_SUPPLIER, labelFallback = null) {
  const [item] = await getLatestPriceListItems([code], supplierKey);
  if (!hasBulkPrice(item)) return { costsUpdated: 0, changedSkus: [], listLabel: null };
  const changedSkus = [];
  let costsUpdated = 0;
  for (const sku of skus) {
    const r = await applyItemCost(sku, item, supplierKey, item.description || labelFallback);
    if (!r.ok) continue;
    costsUpdated++;
    if (r.changed) changedSkus.push(sku);
  }
  return { costsUpdated, changedSkus, listLabel: item.listLabel ?? null };
}

const AUTO_MAP_THROTTLE_MS = 60_000;
let lastAutoMapAt = 0;

/**
 * Mapea SOLO todo lo que coincide con un código de alguna lista importada y todavía no tiene
 * mapeo: el pack cuyo SKU es el código (`39000`), o el producto `CODIGO-variante`
 * (`39000-CORAZONES`). Le vuelca al momento el precio de la lista más reciente que trae ese código.
 * Corre por proveedor: cada uno tiene sus códigos y sus mapas.
 *
 * Hasta 2026-10-14 esto pasaba SOLO al importar una lista: si el pack tomaba su SKU después (o la
 * lista se había importado antes), quedaba "sin código" para siempre aunque el código estuviera tal
 * cual en la lista. Ahora se recalcula al leer el mapeo y la planilla — solo escribe lo nuevo y
 * nunca pisa un mapeo existente (tampoco uno hecho a mano).
 *
 * Se matchea contra los códigos de las listas (price_list_items), no contra supplier_codes: un
 * código que ya no está en ninguna lista (p. ej. de una lista borrada) no tiene precio que dar.
 *
 * Los modelos de un pack con código propio no se mapean de a uno (el precio es el del pack), salvo
 * que el pack no haya matcheado con nada: ahí se prueba con cada modelo, como si no tuviera código.
 *
 * @param {Map<string, string|null>} [names]
 * @param {{ throttle?: boolean }} [opts] `throttle`: no repetir si corrió hace menos de 60 s (para
 *   la planilla, que se refresca seguido)
 * @returns {Promise<{ newMappings: number, costsUpdated: number, changedSkus: string[], mapped: Array }>}
 */
export async function autoMapFromLists(names = new Map(), { throttle = false } = {}) {
  const out = { newMappings: 0, costsUpdated: 0, changedSkus: [], mapped: [] };
  if (throttle && Date.now() - lastAutoMapAt < AUTO_MAP_THROTTLE_MS) return out;
  lastAutoMapAt = Date.now();

  const latest = await getLatestPriceListItems(null);
  if (latest.length === 0) return out;
  const bySupplier = new Map();
  for (const i of latest) {
    const key = i.supplier || DEFAULT_SUPPLIER;
    if (!bySupplier.has(key)) bySupplier.set(key, []);
    bySupplier.get(key).push(i);
  }
  const entityInfo = await buildMatchEntities(names);
  for (const [supplierKey, supplierItems] of bySupplier) {
    const r = await autoMapSupplier(supplierKey, supplierItems, entityInfo, names);
    out.newMappings += r.newMappings;
    out.costsUpdated += r.costsUpdated;
    out.changedSkus.push(...r.changedSkus);
    out.mapped.push(...r.mapped);
  }
  return out;
}

async function autoMapSupplier(supplierKey, latest, { entities: all, packs }, names) {
  const none = { newMappings: 0, costsUpdated: 0, changedSkus: [], mapped: [] };
  const codes = latest.map((i) => ({ code: i.code, description: i.description }));
  // Lo que la usuaria sacó a mano no se vuelve a mapear solo.
  const removed = new Set(await getRemovedCodeMapKeys(supplierKey));
  const entities = all.filter((e) => !removed.has(e.key));
  const savedMap = await buildSavedMap(supplierKey);
  const first = buildMappingSuggestions(entities, codes, savedMap);

  // Packs con código propio que no matchearon ni estaban mapeados: se prueba con sus modelos.
  const mappedPackIds = new Set(first.auto.filter((e) => e.isPack).map((e) => e.packId));
  const resolved = new Set(getResolvedSkus());
  const orphanMembers = packs
    .filter((pk) => pk.sku && !mappedPackIds.has(pk.id))
    .flatMap((pk) => pk.skus)
    .filter((sku, i, arr) => resolved.has(sku) && arr.indexOf(sku) === i)
    .map((sku) => skuEntity(sku, names))
    .filter((e) => !removed.has(e.key));
  const second = buildMappingSuggestions(orphanMembers, codes, savedMap);

  const fresh = [...first.auto, ...second.auto].filter((e) => e.suggestion.matchSource !== 'saved');
  if (fresh.length === 0) return none;

  const individual = new Set([
    ...Object.keys(savedMap).filter((k) => k.startsWith('sku:')).map((k) => k.slice(4)),
    ...fresh.filter((e) => !e.isPack).map((e) => e.sku),
  ]);
  const out = { ...none, mapped: [], changedSkus: [] };
  for (const e of fresh) {
    const { code, matchSource } = e.suggestion;
    const ok = e.isPack
      ? await upsertPackCodeMap(e.packId, code, matchSource, supplierKey)
      : await upsertSkuCodeMap(e.sku, code, matchSource, supplierKey);
    if (!ok) continue;
    out.newMappings++;
    out.mapped.push({ key: e.key, sku: e.sku, code, matchSource, supplierKey });
    // Igual que confirmPackMapping: el precio del pack no pisa a un modelo con mapeo propio.
    const skus = e.isPack ? e.memberSkus.filter((s) => !individual.has(s)) : [e.sku];
    const r = await applyLatestCostForCode(skus, code, supplierKey, e.isPack ? e.name : null);
    out.costsUpdated += r.costsUpdated;
    out.changedSkus.push(...r.changedSkus);
  }
  if (out.newMappings > 0) console.log(`[Pricing] mapeo automático (${supplierKey}): ${out.mapped.map((m) => `${m.sku}→${m.code}`).join(', ')}`);
  return out;
}

/** Olvida el throttle de autoMapFromLists (en los tests). */
export function _resetAutoMapThrottle() {
  lastAutoMapAt = 0;
}

/**
 * Estado del mapeo para la pestaña "Mapeo": TODOS los productos de la tienda (y los packs con
 * código propio) con el código que tienen para `supplierKey` — o ninguno —, de qué lista sale su
 * precio y si ya tienen costo. Además los códigos de ese proveedor, para elegir uno a mano.
 *
 * Sin `supplierKey` (pestaña "Todos") es de solo lectura: cada producto muestra el código del
 * proveedor vigente y, en `codesBySupplier`, el de cada proveedor.
 *
 * Mantiene los campos viejos (mapped, packMapped, skusWithoutCode, …) por compatibilidad.
 */
export async function getMappingState(supplierKey = null) {
  const { names } = await loadCatalogContext();
  const auto = await autoMapFromLists(names);
  const [codes, allSkuMap, allPackMap, packs, latest, costs, suppliers] = await Promise.all([
    getSupplierCodes(supplierKey), getSkuCodeMap(null), getPackCodeMap(null), listPacks(),
    getLatestPriceListItems(null, supplierKey), getAllProductCosts(), listSuppliers(),
  ]);
  const supplierNames = new Map(suppliers.map((s) => [s.key, s.name]));
  const packsWithCode = packs.filter((pk) => pk.sku);
  const packsById = new Map(packs.map((pk) => [pk.id, pk]));
  const latestByCode = new Map(latest.map((i) => [`${i.supplier}|${i.code}`, i]));
  const costBySku = new Map(costs.map((c) => [c.sku, c]));
  const packBySku = buildSkuPackIndex(packs);
  // A qué proveedores se le compra cada producto (para filtrar "de este proveedor" en la UI).
  const ctx = await loadDiscountContext({ costs, packs });
  const suppliersOfSkus = (skuList) => [...new Set(skuList.flatMap((s) => suppliersOf(s, ctx)))];

  // Mapas por proveedor: `${supplier}|${sku}` / `${supplier}|${packId}`.
  const skuMapByKey = new Map(allSkuMap.map((m) => [`${m.supplier}|${m.sku}`, m]));
  const packMapByKey = new Map(allPackMap.map((m) => [`${m.supplier}|${m.packId}`, m]));
  const map = supplierKey ? allSkuMap.filter((m) => m.supplier === supplierKey) : allSkuMap;
  const packMap = supplierKey ? allPackMap.filter((m) => m.supplier === supplierKey) : allPackMap;
  const mapBySku = new Map(map.map((m) => [m.sku, m]));
  const packMapById = new Map(packMap.map((m) => [m.packId, m]));
  const mappedCodes = new Set([...map.map((m) => `${m.supplier}|${m.code}`), ...packMap.map((m) => `${m.supplier}|${m.code}`)]);
  const packMemberSkus = new Set(packsWithCode.flatMap((pk) => pk.skus));
  const skus = getResolvedSkus().filter((s) => !packMemberSkus.has(s));

  // Proveedor del que se muestra el código: el pedido, o (en "Todos") el vigente del producto —
  // si el vigente no tiene código para él (o no hay vigente), el primer proveedor que sí tenga.
  const vigenteOf = (skuList) => skuList.map((s) => costBySku.get(s)?.supplierKey).find(Boolean) ?? null;
  const codeInfo = (code, sup) => {
    if (!code) return { code: null, codeDescription: null, listLabel: null, codeSupplier: null };
    const it = latestByCode.get(`${sup}|${code}`);
    return { code, codeDescription: it?.description ?? null, listLabel: it?.listLabel ?? null, codeSupplier: sup };
  };
  const codesBySupplierFor = (kind, id) => suppliers
    .map((s) => ({ supplierKey: s.key, supplierName: s.name, code: (kind === 'pack' ? packMapByKey : skuMapByKey).get(`${s.key}|${id}`)?.code ?? null }))
    .filter((c) => c.code);
  const pickRow = (kind, id, preferred) => {
    const byKey = kind === 'pack' ? packMapByKey : skuMapByKey;
    if (supplierKey) return byKey.get(`${supplierKey}|${id}`) ?? null;
    return (preferred && byKey.get(`${preferred}|${id}`))
      ?? suppliers.map((s) => byKey.get(`${s.key}|${id}`)).find(Boolean)
      ?? (kind === 'pack' ? allPackMap.find((m) => m.packId === id) : allSkuMap.find((m) => m.sku === id))
      ?? null;
  };

  const products = [
    ...packsWithCode.map((pk) => {
      const m = pickRow('pack', pk.id, vigenteOf(pk.skus));
      const sup = m?.supplier ?? supplierKey;
      return {
        key: `pack:${pk.id}`,
        kind: 'pack',
        sku: pk.sku,
        packId: pk.id,
        name: pk.name,
        memberSkus: pk.skus,
        packName: null,
        ...codeInfo(m?.code, sup),
        matchSource: m?.matchSource ?? null,
        hasCost: pk.skus.length > 0 && pk.skus.every((s) => costBySku.has(s)),
        mappedMl: pk.skus.some((s) => !!getMlItemBySku(s)),
        mappedTn: pk.skus.some((s) => !!getTnVariantBySku(s)),
        vigente: vigenteOf(pk.skus),
        suppliers: suppliersOfSkus(pk.skus),
        codesBySupplier: codesBySupplierFor('pack', pk.id),
        // Los modelos del pack, con el código del que sale su precio: el propio si tienen mapeo
        // individual (pisa al del pack, ver applyListCosts), si no el del pack.
        members: pk.skus.map((sku) => {
          const own = supplierKey || !m ? pickRow('sku', sku, vigenteOf([sku])) : skuMapByKey.get(`${sup}|${sku}`) ?? null;
          return {
            key: `sku:${sku}`,
            sku,
            name: names.get(sku) ?? null,
            ...codeInfo(own?.code ?? m?.code, own?.supplier ?? sup),
            codeSource: own ? 'own' : (m ? 'pack' : null),
            matchSource: own?.matchSource ?? null,
            hasCost: costBySku.has(sku),
            mappedMl: !!getMlItemBySku(sku),
            mappedTn: !!getTnVariantBySku(sku),
            vigente: costBySku.get(sku)?.supplierKey ?? null,
            suppliers: suppliersOf(sku, ctx),
            codesBySupplier: codesBySupplierFor('sku', sku),
          };
        }),
      };
    }),
    ...skus.map((sku) => {
      const m = pickRow('sku', sku, vigenteOf([sku]));
      const sup = m?.supplier ?? supplierKey;
      return {
        key: `sku:${sku}`,
        kind: 'sku',
        sku,
        packId: null,
        name: names.get(sku) ?? null,
        memberSkus: [],
        // Pack SIN código propio al que pertenece (para agrupar en la UI): sus modelos se mapean de a uno.
        packName: packBySku.get(sku)?.name ?? null,
        ...codeInfo(m?.code, sup),
        matchSource: m?.matchSource ?? null,
        hasCost: costBySku.has(sku),
        mappedMl: !!getMlItemBySku(sku),
        mappedTn: !!getTnVariantBySku(sku),
        vigente: costBySku.get(sku)?.supplierKey ?? null,
        suppliers: suppliersOf(sku, ctx),
        codesBySupplier: codesBySupplierFor('sku', sku),
        members: [],
      };
    }),
  ];

  const supplierOfCode = (c) => c.supplier ?? supplierKey;
  return {
    supplierKey,
    supplierNames: Object.fromEntries(supplierNames),
    products,
    // Lo que se acaba de mapear solo en esta lectura (para avisarlo y resaltar los costos que cambiaron).
    autoMapped: { count: auto.newMappings, changedSkus: auto.changedSkus, items: auto.mapped },
    codes: codes.map((c) => {
      const it = latestByCode.get(`${supplierOfCode(c)}|${c.code}`);
      return {
        code: c.code,
        supplierKey: supplierOfCode(c),
        description: c.description ?? it?.description ?? null,
        listLabel: it?.listLabel ?? null,
        mapped: mappedCodes.has(`${supplierOfCode(c)}|${c.code}`),
        inList: !!it,
      };
    })
      // Un código que ya no está en ninguna lista (lista borrada) no da precio: no se ofrece.
      .filter((c) => c.inList || c.mapped)
      .map(({ inList, ...c }) => c),
    mapped: map,
    packMapped: packMap.map((m) => ({
      ...m,
      packName: packsById.get(m.packId)?.name ?? null,
      packSku: packsById.get(m.packId)?.sku ?? null,
      memberSkus: packsById.get(m.packId)?.skus ?? [],
    })),
    // Productos del hub sin código: son de otra marca (costo a mano) o falta confirmarlos.
    skusWithoutCode: skus.filter((s) => !mapBySku.has(s)),
    // Packs con código propio que todavía no se mapearon.
    packsWithoutCode: packsWithCode
      .filter((pk) => !packMapById.has(pk.id))
      .map((pk) => ({ id: pk.id, name: pk.name, sku: pk.sku })),
    // Códigos que el proveedor vende y el hub no tiene: candidatos a crear producto.
    codesWithoutSku: codes.filter((c) => !mappedCodes.has(`${supplierOfCode(c)}|${c.code}`) && latestByCode.has(`${supplierOfCode(c)}|${c.code}`)),
    totals: {
      codes: codes.length,
      skus: skus.length + packsWithCode.length,
      mapped: map.length + packMap.length,
    },
  };
}

/**
 * Confirma (o corrige) el mapeo de un SKU con un código de `supplierKey` y le vuelca en el momento
 * el precio de ese código en la lista más reciente de ese proveedor que lo trae.
 */
export async function confirmMapping(sku, code, matchSource = 'manual', supplierKey = DEFAULT_SUPPLIER) {
  const ok = await upsertSkuCodeMap(sku, code, matchSource, supplierKey);
  if (!ok) return { ok: false, costsUpdated: 0, changedSkus: [], listLabel: null };
  return { ok: true, ...(await applyLatestCostForCode([sku], code, supplierKey)) };
}

/**
 * Saca el código de un SKU. Queda marcado como "sacado a mano" (no se borra la fila) para que el
 * mapeo automático no se lo vuelva a poner; en un modelo de pack, vuelve a tomar el código del pack.
 */
export async function removeMapping(sku, supplierKey = DEFAULT_SUPPLIER) {
  return markSkuCodeRemoved(sku, supplierKey);
}

/**
 * Igual que confirmMapping pero para un pack: el precio va a todos sus modelos, salvo a los que
 * tienen un mapeo individual propio (que es más específico, mismo criterio que applyListCosts).
 */
export async function confirmPackMapping(packId, code, matchSource = 'manual', supplierKey = DEFAULT_SUPPLIER) {
  const ok = await upsertPackCodeMap(packId, code, matchSource, supplierKey);
  if (!ok) return { ok: false, costsUpdated: 0, changedSkus: [], listLabel: null };
  const pack = (await listPacks()).find((pk) => pk.id === packId);
  if (!pack) return { ok: true, costsUpdated: 0, changedSkus: [], listLabel: null };
  const individual = new Set((await getSkuCodeMap(supplierKey)).map((m) => m.sku));
  const skus = pack.skus.filter((s) => !individual.has(s));
  return { ok: true, ...(await applyLatestCostForCode(skus, code, supplierKey, pack.name)) };
}

/** Igual que removeMapping, para un pack. */
export async function removePackMapping(packId, supplierKey = DEFAULT_SUPPLIER) {
  return markPackCodeRemoved(packId, supplierKey);
}

export async function listImportedLists() {
  const [lists, suppliers] = await Promise.all([getPriceLists(), listSuppliers()]);
  const names = new Map(suppliers.map((s) => [s.key, s.name]));
  return lists.map((l) => ({ ...l, supplierName: names.get(l.supplier) ?? l.supplier }));
}

/** Borra una lista importada (ver deletePriceList). Los costos ya volcados quedan. */
export async function removeImportedList(listId) {
  const ok = await deletePriceList(listId);
  if (ok) _resetAutoMapThrottle();
  return ok;
}

// ── Proveedores, configs de descuento y asignaciones ─────────────────────────

/** Error con status HTTP, para que la ruta conteste 400/404/409 en vez de 500. */
function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

const pct = (v) => {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n) || n < 0 || n >= 100) throw httpError(400, 'El descuento tiene que ser un % entre 0 y 99');
  return n;
};

/** Alta de un proveedor con su config default. La clave sale del nombre ("Bic" → `bic`). */
export async function addSupplier({ name, discount1 = 0, discount2 = 0, profileName = 'General' } = {}) {
  const clean = String(name ?? '').trim();
  if (!clean) throw httpError(400, 'Falta el nombre del proveedor');
  const base = supplierKeyFromName(clean) || 'proveedor';
  const taken = new Set((await listSuppliers()).map((s) => s.key));
  let key = base;
  for (let i = 2; taken.has(key); i++) key = `${base}_${i}`;
  const created = await createSupplier({
    key, name: clean.slice(0, 128), discount1: pct(discount1), discount2: pct(discount2),
    profileName: String(profileName || 'General').trim().slice(0, 128) || 'General',
  });
  if (!created) throw httpError(500, 'No se pudo crear el proveedor');
  return { key };
}

export async function editSupplier(key, { name } = {}) {
  const clean = String(name ?? '').trim();
  if (!clean) throw httpError(400, 'Falta el nombre del proveedor');
  if (!(await renameSupplier(key, clean.slice(0, 128)))) throw httpError(404, 'El proveedor no existe');
  return { ok: true };
}

/** Borra un proveedor sin listas ni productos vigentes (si los tiene: 409, primero hay que moverlos). */
export async function removeSupplier(key) {
  const usage = await getSupplierUsage(key);
  if (usage.lists > 0 || usage.products > 0 || usage.orders > 0) {
    throw httpError(409, `No se puede borrar: tiene ${usage.lists} lista(s), ${usage.orders ?? 0} pedido(s) y es el proveedor vigente de ${usage.products} producto(s)`);
  }
  if (!(await deleteSupplier(key))) throw httpError(404, 'El proveedor no existe');
  return { ok: true };
}

export async function addDiscountProfile(supplierKey, { name, discount1 = 0, discount2 = 0 } = {}) {
  const clean = String(name ?? '').trim();
  if (!clean) throw httpError(400, 'Falta el nombre de la configuración');
  if (!(await listSuppliers()).some((s) => s.key === supplierKey)) throw httpError(404, 'El proveedor no existe');
  const id = await createDiscountProfile(supplierKey, { name: clean.slice(0, 128), discount1: pct(discount1), discount2: pct(discount2) });
  if (!id) throw httpError(500, 'No se pudo crear la configuración');
  return { id };
}

export async function editDiscountProfile(id, patch = {}) {
  const ok = await updateDiscountProfile(id, {
    name: patch.name,
    discount1: patch.discount1 != null ? pct(patch.discount1) : undefined,
    discount2: patch.discount2 != null ? pct(patch.discount2) : undefined,
    isDefault: patch.isDefault === true ? true : undefined,
  });
  if (!ok) throw httpError(404, 'La configuración no existe');
  return { ok: true };
}

/** Borra una config (no la default): lo que la usaba vuelve a la del pack o a la default. */
export async function removeDiscountProfile(id) {
  const all = (await listSuppliers()).flatMap((s) => s.profiles);
  const profile = all.find((pr) => pr.id === id);
  if (!profile) throw httpError(404, 'La configuración no existe');
  if (profile.isDefault) throw httpError(409, 'No se puede borrar la configuración default del proveedor');
  await deleteDiscountProfile(id);
  return { ok: true };
}

/** Normaliza los targets que manda la UI: `{ type: 'sku'|'pack', id }`. */
function cleanTargets(targets) {
  return (Array.isArray(targets) ? targets : [])
    .filter((t) => (t?.type === 'sku' || t?.type === 'pack') && t.id != null && String(t.id).trim())
    .map((t) => ({ type: t.type, id: String(t.id).trim() }));
}

/**
 * Asignación masiva de una config de descuento (`profileId`, `null` = la default) a packs/productos
 * de un proveedor, dándolos de alta en ese proveedor si no estaban. Asignar a un pack entero saca la
 * config propia de sus modelos para ese proveedor: si no, una fila suelta vieja taparía la del pack.
 */
export async function assignDiscount({ supplierKey, targets, profileId = null } = {}) {
  const list = cleanTargets(targets);
  if (!supplierKey || list.length === 0) throw httpError(400, 'Faltan el proveedor o los productos');
  const supplier = (await listSuppliers()).find((s) => s.key === supplierKey);
  if (!supplier) throw httpError(404, 'El proveedor no existe');
  let id = profileId == null ? null : Number(profileId);
  if (id != null) {
    const profile = supplier.profiles.find((pr) => pr.id === id);
    if (!profile) throw httpError(400, 'La configuración no es de este proveedor');
    if (profile.isDefault) id = null;
  }
  await upsertProductSuppliers(supplierKey, list, id);
  const packIds = list.filter((t) => t.type === 'pack').map((t) => Number(t.id));
  if (packIds.length > 0) {
    const members = (await listPacks()).filter((pk) => packIds.includes(pk.id)).flatMap((pk) => pk.skus);
    await clearSkuProfiles(supplierKey, members);
  }
  return { ok: true, assigned: list.length };
}

/**
 * Deja de comprarle a `supplierKey` estos packs/productos: borra la asignación (también la de los
 * modelos de un pack) y saca su código de ese proveedor dejando la marca de "sacado a mano" — si no,
 * el código mapeado lo seguiría contando como proveedor y el mapeo automático lo volvería a poner
 * con la próxima lista. Lo que tenía a ese proveedor de vigente queda sin vigente (el costo no se
 * toca, pero ya no lleva su descuento): vuelve en `lostVigente` para avisar.
 */
async function detachSupplier(supplierKey, targets, packs) {
  const skus = new Set();
  for (const t of targets) {
    if (t.type === 'sku') skus.add(t.id);
    else for (const s of packs.find((pk) => String(pk.id) === t.id)?.skus ?? []) skus.add(s);
  }
  const skuTargets = [...skus].map((id) => ({ type: 'sku', id }));
  await deleteProductSuppliers(supplierKey, [...targets.filter((t) => t.type === 'pack'), ...skuTargets]);
  for (const t of targets) if (t.type === 'pack') await markPackCodeRemoved(Number(t.id), supplierKey);
  for (const sku of skus) await markSkuCodeRemoved(sku, supplierKey);
  const lostVigente = [];
  for (const sku of skus) if ((await getProductCost(sku))?.supplierKey === supplierKey) lostVigente.push(sku);
  if (lostVigente.length) await setCostSupplier(lostVigente, null);
  return { lostVigente };
}

/** Saca packs/productos de un proveedor (Precios → "Quitar de este proveedor"). */
export async function unassignSupplier({ supplierKey, targets } = {}) {
  const list = cleanTargets(targets);
  if (!supplierKey || list.length === 0) throw httpError(400, 'Faltan el proveedor o los productos');
  const { lostVigente } = await detachSupplier(supplierKey, list, await listPacks());
  return { ok: true, lostVigente, changedSkus: lostVigente };
}

/** Costo de un SKU tal como lo muestra el form de un producto (sin descuentos: salen de la config). */
function costSummary(c) {
  if (!c) return null;
  const unit = c.unitCost != null && !(c.bulkPrice > 0);
  return {
    mode: unit ? 'unit' : 'bulk',
    bulkPrice: c.bulkPrice ?? null, bulkQty: c.bulkQty ?? null, unitCost: c.unitCost ?? null,
    marginOverride: c.marginOverride ?? null,
  };
}

/**
 * Proveedor de cada producto para mostrar/editar fuera de Precios (Productos, Crear/Editar): su
 * vigente, todos a los que se le compra, la config de descuento que le toca (para el vigente o, sin
 * costo todavía, para el primero) y su costo. `byPack` = asignaciones a nivel pack. Sin `skus`
 * devuelve todos los SKUs que tienen proveedor o costo. No le pega a ML/TN.
 */
export async function getProductSupplierOverview({ skus = null } = {}) {
  const [costs, packs, suppliers, assignments] = await Promise.all([
    getAllProductCosts(), listPacks(), listSuppliers(), listProductSuppliers(),
  ]);
  const ctx = await loadDiscountContext({ costs, packs });
  const costBySku = new Map(costs.map((c) => [c.sku, c]));
  const wanted = skus?.length
    ? [...new Set(skus.map((s) => String(s).trim()).filter(Boolean))]
    : [...new Set([...ctx.suppliersBySku.keys(), ...costs.map((c) => c.sku)])];
  const bySku = {};
  for (const sku of wanted) {
    const all = suppliersOf(sku, ctx);
    const vigente = ctx.vigenteBySku.get(sku) ?? null;
    bySku[sku] = {
      vigente,
      suppliers: all,
      discount: resolveDiscount(sku, ctx, vigente ?? all[0] ?? null),
      // La config que le toca con CADA proveedor (para editarlas todas en el diálogo de Productos).
      discounts: Object.fromEntries(all.map((k) => [k, resolveDiscount(sku, ctx, k)])),
      cost: costSummary(costBySku.get(sku)),
    };
  }
  const byPack = {};
  for (const a of assignments) {
    if (a.type !== 'pack') continue;
    (byPack[a.id] ||= []).push({ supplierKey: a.supplierKey, profileId: a.profileId ?? null });
  }
  return {
    suppliers: suppliers.map((s) => ({ key: s.key, name: s.name, profiles: s.profiles })),
    bySku,
    byPack,
  };
}

/**
 * Para filtrar Productos por proveedor y por pack (`GET /api/conflicts?supplier=&pack=`): a qué
 * proveedores se le compra cada SKU (mismo criterio que el chip: asignación, código mapeado o
 * vigente) y qué SKUs son modelo de algún pack del hub (Productos → Packs). Antes el filtro miraba
 * las unidades del bulto de Precios (`bulk_qty`), y un modelo de pack sin bulto cargado salía como
 * "sin". No le pega a ML/TN.
 */
export async function getSkuFilterFacets() {
  const [costs, packs] = await Promise.all([getAllProductCosts(), listPacks()]);
  const ctx = await loadDiscountContext({ costs, packs });
  return {
    suppliersOf: (sku) => suppliersOf(sku, ctx),
    packSkus: new Set(packs.flatMap((pk) => pk.skus)),
  };
}

const positive = (v) => v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) > 0;

/**
 * Proveedor (+ config de descuento y, opcional, costo) de UN producto, desde Crear/Editar producto o
 * Productos. Se asigna al pack si el producto es un pack (o todos sus SKUs son de uno), si no a cada
 * SKU (`supplierTargets`). Con `cost` válido lo guarda en cada SKU con ese proveedor como vigente;
 * sin costo, si un SKU ya tenía costo de otro proveedor, pasa a este (el vigente). `supplierKey: null`
 * = "sin proveedor": solo deja el costo sin vigente (sin descuento). Idempotente: todo es upsert.
 * `bulk: true` = varios productos a la vez (selección de Productos): cada SKU de un pack asigna su
 * pack y los sueltos van por SKU (`bulkSupplierTargets`), en vez de tratar la lista como UN producto.
 * Ahí `makeVigente: false` lo suma como un proveedor más sin cambiar de dónde sale el costo, y
 * `keepProfile: true` no toca la config de lo que ya lo tenía (lo nuevo entra con la default).
 *
 * `suppliers` = la lista COMPLETA de proveedores de UN producto (diálogo de Productos, Crear/Editar),
 * cada uno con su config; `supplierKey` es el vigente (tiene que estar en la lista). Los que tenía y
 * ya no están se sacan (`detachSupplier`), y si el vigente cambia sin costo cargado, toma el precio
 * de la última lista del nuevo (`setVigenteSupplier`, igual que "Proveedor vigente…" en Precios).
 *
 * @param {{ skus: string[], packId?: number|null, supplierKey: string|null, profileId?: number|null,
 *   cost?: { mode: 'bulk'|'unit', bulkPrice?, bulkQty?, unitCost?, marginPct? } | null, label?: string|null,
 *   bulk?: boolean, makeVigente?: boolean, keepProfile?: boolean,
 *   suppliers?: Array<{ supplierKey: string, profileId?: number|null }> }} input
 * @returns {Promise<{ ok: true, targets, changedSkus: string[], withoutPrice?: string[] }>}
 */
export async function setProductSupplier({
  skus, packId = null, supplierKey = null, profileId = null, cost = null, label = null, bulk = false,
  makeVigente = true, suppliers = null, keepProfile = false,
} = {}) {
  const packs = await listPacks();
  let list = [...new Set((Array.isArray(skus) ? skus : []).map((s) => String(s ?? '').trim()).filter(Boolean))];
  if (packId != null && list.length === 0) list = packs.find((pk) => String(pk.id) === String(packId))?.skus ?? [];
  if (list.length === 0) throw httpError(400, 'Faltan los productos');
  const targets = bulk && packId == null ? bulkSupplierTargets(list, packs) : supplierTargets(list, packs, packId);
  if (Array.isArray(suppliers)) return setProductSupplierSet({ list, targets, packs, supplierKey, suppliers, cost, label });
  if (supplierKey && keepProfile) {
    if (!(await listSuppliers()).some((s) => s.key === supplierKey)) throw httpError(404, 'El proveedor no existe');
    await upsertProductSuppliers(supplierKey, targets, null, { onlyIfMissing: true });
  } else if (supplierKey) await assignDiscount({ supplierKey, targets, profileId });
  if (!makeVigente) return { ok: true, targets, changedSkus: [] };

  const changedSkus = [];
  if (isValidCost(cost)) {
    await saveManualCost(list, cost, supplierKey, label);
    changedSkus.push(...list);
  } else {
    const moved = [];
    for (const sku of list) {
      const prev = await getProductCost(sku);
      if (prev && (prev.supplierKey ?? null) !== (supplierKey ?? null)) moved.push(sku);
    }
    if (moved.length) { await setCostSupplier(moved, supplierKey ?? null); changedSkus.push(...moved); }
  }
  // Cambiar la config mueve el precio de todo lo que tiene costo con ese proveedor.
  if (supplierKey) {
    for (const sku of list) if (!changedSkus.includes(sku) && (await getProductCost(sku))?.supplierKey === supplierKey) changedSkus.push(sku);
  }
  return { ok: true, targets, changedSkus };
}

/** Costo cargado a mano en Crear/Editar producto o Productos, con `supplierKey` como vigente. */
async function saveManualCost(list, cost, supplierKey, label) {
  const db = await getPricingSettings();
  const defaultMargin = db?.defaultMarginPct ?? DEFAULT_SETTINGS.defaultMarginPct ?? 100;
  const margin = cost.marginPct == null || cost.marginPct === '' || !Number.isFinite(Number(cost.marginPct)) ? null : Number(cost.marginPct);
  for (const sku of list) {
    const prev = await getProductCost(sku);
    await upsertCost(sku, {
      source: 'manual',
      bulkPrice: cost.mode === 'unit' ? null : Number(cost.bulkPrice),
      bulkQty: cost.mode === 'unit' ? null : Number(cost.bulkQty),
      unitCost: cost.mode === 'unit' ? Number(cost.unitCost) : null,
      marginOverride: margin != null && margin !== defaultMargin ? margin : null,
      label: prev?.label ?? label ?? null,
      supplierKey: supplierKey ?? null,
    });
  }
}

const isValidCost = (cost) => !!cost && (cost.mode === 'unit'
  ? positive(cost.unitCost)
  : positive(cost.bulkPrice) && positive(cost.bulkQty));

/** `setProductSupplier` con la lista completa de proveedores de un producto (ver arriba). */
async function setProductSupplierSet({ list, targets, packs, supplierKey, suppliers, cost, label }) {
  const known = new Set((await listSuppliers()).map((s) => s.key));
  const wanted = new Map();
  for (const s of suppliers) {
    const key = s?.supplierKey ? String(s.supplierKey) : null;
    if (!key) continue;
    if (!known.has(key)) throw httpError(404, 'El proveedor no existe');
    if (!wanted.has(key)) wanted.set(key, s.profileId == null ? null : Number(s.profileId));
  }
  const vigente = supplierKey ? String(supplierKey) : null;
  if (vigente && !wanted.has(vigente)) wanted.set(vigente, null);
  if (!vigente && wanted.size > 0) throw httpError(400, 'Elegí cuál es el proveedor vigente');

  const ctx = await loadDiscountContext({ packs });
  const current = new Set(list.flatMap((sku) => suppliersOf(sku, ctx)));
  for (const [key, profileId] of wanted) await assignDiscount({ supplierKey: key, targets, profileId });

  const changed = new Set();
  let withoutPrice = [];
  if (isValidCost(cost)) {
    await saveManualCost(list, cost, vigente, label);
    list.forEach((s) => changed.add(s));
  } else if (vigente) {
    const toMove = list.filter((sku) => ctx.vigenteBySku.get(sku) !== vigente);
    if (toMove.length) {
      const hadCost = new Set();
      for (const sku of toMove) if (await getProductCost(sku)) hadCost.add(sku);
      const res = await setVigenteSupplier({ supplierKey: vigente, targets: toMove.map((id) => ({ type: 'sku', id })) });
      res.changedSkus.forEach((s) => changed.add(s));
      withoutPrice = res.withoutPrice.filter((s) => hadCost.has(s));
    }
  }
  for (const key of current) {
    if (wanted.has(key)) continue;
    const { lostVigente } = await detachSupplier(key, targets, packs);
    lostVigente.forEach((s) => changed.add(s));
  }
  // Cambiar una config mueve el precio de lo que tiene costo con ese proveedor (el vigente).
  if (vigente) for (const sku of list) if ((await getProductCost(sku))?.supplierKey === vigente) changed.add(sku);
  return { ok: true, targets, changedSkus: [...changed], withoutPrice };
}

/**
 * Deja de comprarle `supplierKey` a uno o varios productos (Productos → "Quitar proveedor"). Mismos
 * targets que `setProductSupplier`: un pack entero, o con `bulk` el pack de cada modelo.
 */
export async function removeProductSupplier({ skus, packId = null, supplierKey = null, bulk = false } = {}) {
  if (!supplierKey) throw httpError(400, 'Falta el proveedor');
  const packs = await listPacks();
  let list = [...new Set((Array.isArray(skus) ? skus : []).map((s) => String(s ?? '').trim()).filter(Boolean))];
  if (packId != null && list.length === 0) list = packs.find((pk) => String(pk.id) === String(packId))?.skus ?? [];
  if (list.length === 0) throw httpError(400, 'Faltan los productos');
  const targets = bulk && packId == null ? bulkSupplierTargets(list, packs) : supplierTargets(list, packs, packId);
  const { lostVigente } = await detachSupplier(String(supplierKey), targets, packs);
  return { ok: true, targets, lostVigente, changedSkus: lostVigente };
}

/**
 * Cambia el proveedor VIGENTE (el que manda el costo) de packs/productos. Cada SKU toma el precio
 * del código que tiene para ese proveedor (el propio, si no el del pack) en la lista más reciente
 * de ese proveedor; si no hay precio de lista, el costo queda como está y el SKU vuelve en
 * `withoutPrice` para que la UI pida cargarlo. Un SKU sin costo y sin precio de lista no cambia.
 */
export async function setVigenteSupplier({ supplierKey, targets } = {}) {
  const list = cleanTargets(targets);
  if (!supplierKey || list.length === 0) throw httpError(400, 'Faltan el proveedor o los productos');
  if (!(await listSuppliers()).some((s) => s.key === supplierKey)) throw httpError(404, 'El proveedor no existe');
  const packs = await listPacks();
  const packIdBySku = new Map(packs.flatMap((pk) => pk.skus.map((s) => [s, pk.id])));
  const skus = new Set();
  for (const t of list) {
    if (t.type === 'sku') skus.add(t.id);
    else for (const s of packs.find((pk) => String(pk.id) === t.id)?.skus ?? []) skus.add(s);
  }
  await upsertProductSuppliers(supplierKey, list, null, { onlyIfMissing: true });
  const [skuMap, packMap] = await Promise.all([getSkuCodeMap(supplierKey), getPackCodeMap(supplierKey)]);
  const codeBySku = new Map(skuMap.map((m) => [m.sku, m.code]));
  const codeByPack = new Map(packMap.map((m) => [m.packId, m.code]));
  const codeOf = (sku) => codeBySku.get(sku) ?? codeByPack.get(packIdBySku.get(sku)) ?? null;
  const codes = [...new Set([...skus].map(codeOf).filter(Boolean))];
  const latest = new Map((await getLatestPriceListItems(codes, supplierKey)).map((i) => [i.code, i]));

  const withoutPrice = [];
  const changedSkus = [];
  for (const sku of skus) {
    const item = latest.get(codeOf(sku));
    const prev = await getProductCost(sku);
    if (hasBulkPrice(item)) {
      await upsertCost(sku, {
        source: 'list', bulkPrice: item.bulkPrice, bulkQty: item.bulkQty, supplierKey,
        label: item.description ?? prev?.label ?? null, marginOverride: prev?.marginOverride ?? null,
      });
      changedSkus.push(sku);
    } else {
      if (prev) { await setCostSupplier([sku], supplierKey); changedSkus.push(sku); }
      withoutPrice.push(sku);
    }
  }
  return { ok: true, changedSkus, withoutPrice };
}

// ── Sincronización de comisiones desde la API de ML (fase 5) ──────────────────

/**
 * Trae los costos de venta reales desde la API de ML y (opcionalmente) los guarda en Ajustes,
 * reemplazando la comisión % y los tramos que hoy están cargados a mano.
 *
 * No es destructivo por default: `apply=false` solo devuelve lo que la API dice, para que la UI
 * muestre "esto tenés cargado vs. esto dice ML" y vos decidas. Si la API no está disponible (sin
 * token, WAF, 403), propaga el error y los valores a mano quedan intactos.
 *
 * @param {{ apply?: boolean, listingTypeId?: string, categoryId?: string, extraParams?: object, force?: boolean }} [opts]
 */
export async function syncMlFees(opts = {}) {
  const token = await getMlToken();
  const remote = await fetchFeeConfig(token, {
    listingTypeId: opts.listingTypeId,
    categoryId: opts.categoryId,
    extraParams: opts.extraParams,
    force: opts.force,
  });

  const current = await getConfig();
  const result = {
    remote: { commissionPct: remote.commissionPct, tiers: remote.tiers, probes: remote.probes, fetchedAt: remote.fetchedAt },
    current: { commissionPct: current.settings.commissionPct, tiers: current.tiers },
    applied: false,
  };

  if (opts.apply) {
    const patch = {};
    if (remote.commissionPct != null) patch.commissionPct = remote.commissionPct;
    if (Array.isArray(remote.tiers) && remote.tiers.length > 0) patch.tiers = remote.tiers;
    await saveConfig(patch);
    result.applied = true;
    result.config = await getConfig();
  }

  return result;
}
