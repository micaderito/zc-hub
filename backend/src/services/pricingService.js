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
  getSkuCodeMap, upsertSkuCodeMap, deleteSkuCodeMap, upsertProductCost as upsertCost,
  getPackCodeMap, upsertPackCodeMap, deletePackCodeMap, listPacks,
  getPriceOverrides, upsertPriceOverride, deletePriceOverride,
} from '../db.js';
import { patchTnPrice } from './conflictsService.js';
import { getMlItemBySku, getTnVariantBySku, getResolvedSkus, getMlToken } from '../store.js';
import { parseSupplierList, parseSupplierCsv } from '../lib/supplierListParser.js';
import { buildMappingSuggestions } from '../lib/skuMatcher.js';
import { buildSkuPackIndex } from '../lib/packIndex.js';
import { fetchFeeConfig } from '../lib/mlFees.js';
import { computePrices, mlNetReceived, computeUnitCostFromBulk, DEFAULT_SETTINGS } from '../lib/pricing.js';
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
 * config para la ganancia (si el producto no tiene override). Puro y testeable.
 */
export function costToInput(cost, dbSettings) {
  const marginPct = cost.marginOverride != null
    ? cost.marginOverride
    : (dbSettings?.defaultMarginPct ?? 100);
  if (cost.source === 'list' || (cost.bulkPrice != null && cost.bulkQty != null)) {
    return {
      bulkPrice: cost.bulkPrice,
      bulkQty: cost.bulkQty,
      discount1: cost.discount1 ?? 0,
      discount2: cost.discount2 ?? 0,
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
export function previewRow(cost, settings, dbSettings, current = {}, overrides = {}) {
  const out = computePrices(costToInput(cost, dbSettings), settings);
  const tnOverride = overrides.tn ?? null;
  const mlOverride = overrides.ml ?? null;
  const mlEffective = mlOverride ?? out.ml;
  return {
    sku: cost.sku,
    label: cost.label ?? null,
    source: cost.source,
    bulkQty: cost.bulkQty ?? null,
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
    // ¿el precio de ML cae en la zona de envío gratis? (para el aviso de zona muerta)
    freeShipping: out.ml > settings.freeShippingThreshold,
  };
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

/** Config completa para la UI (valores fijos + tramos), con fallback a los defaults. */
export async function getConfig() {
  const db = await getPricingSettings();
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
  };
}

export async function saveConfig(patch) {
  await savePricingSettings(patch);
  if (Array.isArray(patch?.tiers)) await saveMlFeeTiers(patch.tiers);
  return getConfig();
}

/**
 * Preview de TODOS los costos cargados: precios calculados + delta contra lo que hoy está publicado.
 * `currentBySku` (opcional) mapea sku → { ml, tn } con los precios actuales del snapshot.
 */
export async function getPreview(currentBySku = {}) {
  const db = await getPricingSettings();
  const settings = buildSettings(db);
  const [costs, packs, overridesBySku] = await Promise.all([
    getAllProductCosts(), listPacks(), buildOverridesBySku(),
  ]);
  const packBySku = buildSkuPackIndex(packs);
  return costs.map((cost) => ({
    ...previewRow(cost, settings, db, currentBySku[cost.sku] || {}, overridesBySku[cost.sku] || {}),
    pack: packBySku.get(cost.sku) || null,
  }));
}

/** Fija (o corrige) el precio publicado a mano de un SKU en un canal. `value: null` lo saca. */
export async function saveOverride(sku, channel, value) {
  if (value == null) return deletePriceOverride(sku, channel);
  return upsertPriceOverride(sku, channel, value);
}

export async function saveCost(sku, data) {
  await upsertProductCost(sku, data);
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
  const db = await getPricingSettings();
  const settings = buildSettings(db);
  const overridesBySku = await buildOverridesBySku();
  const results = [];
  const tnBatch = [];

  for (const sku of skus) {
    const cost = await getProductCost(sku);
    if (!cost) {
      results.push({ sku, ok: false, reason: 'sin costo cargado' });
      continue;
    }
    const prices = computePrices(costToInput(cost, db), settings);
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
      try {
        await tn.updateVariantsStockPrice(access_token, store_id, tnBatch.map((b) => ({
          productId: b.productId, variantId: b.variantId, price: b.price,
        })));
        // Aplicado en TN: parchamos el snapshot y registramos el historial por variante. El
        // parche devuelve el precio previo (igual que en ML), así el historial cuenta el cambio
        // sin gastar un GET extra. Solo se registra si el precio efectivamente se movió.
        for (const b of tnBatch) {
          const before = await patchTnPrice(b.productId, b.variantId, b.price).catch((e) => {
            console.error('[Pricing] patchTnPrice:', e.message);
            return null;
          });
          if (before && before.priceBefore !== b.price) {
            await insertPriceAudit({
              sku: b.sku,
              channel: 'tiendanube',
              priceBefore: before.priceBefore,
              priceAfter: b.price,
              source: 'bulk',
              productLabel: b.label ?? null,
            }).catch((e) => console.error('[Pricing] insertPriceAudit:', e.message));
          }
        }
      } catch (e) {
        for (const r of results) if (r.channel === 'tn' && r.ok) { r.ok = false; r.reason = `bulk TN falló: ${e.message}`; }
      }
    }
  }

  return {
    total: skus.length,
    enqueuedMl: results.filter((r) => r.channel === 'ml' && r.ok).length,
    appliedTn: results.filter((r) => r.channel === 'tn' && r.ok).length,
    failed: results.filter((r) => r.ok === false).length,
    results,
  };
}

// ── Importación de listas y mapeo (fase 4) ────────────────────────────────────

/**
 * Entidades contra las que se intenta mapear cada código de la lista: los packs con SKU propio
 * (product_packs.sku) van PRIMERO y de forma exclusiva — si un pack tiene su propio código, sus
 * SKUs miembro se sacan de la lista de productos sueltos, porque el precio real es el del pack, no
 * el de cada modelo (un pack surtido puede juntar productos sin ninguna relación textual entre sí,
 * así que matchear por SKU individual no serviría). Un pack SIN código propio no cambia nada: sus
 * miembros se siguen mapeando uno por uno, como antes de esto — es el caso, por ejemplo, del pack
 * de repuestos que es el mismo SKU ×8: ahí el propio SKU del producto YA matchea directo.
 *
 * @returns {{ entities: Array, packMemberSkus: Set<string> }} `entities` son objetos
 *   `{ sku, label?, isPack, packId?, memberSkus? }` listos para pasarle a buildMappingSuggestions.
 */
async function buildMatchEntities() {
  const packs = await listPacks();
  const packsWithCode = packs.filter((pk) => pk.sku);
  const packMemberSkus = new Set(packsWithCode.flatMap((pk) => pk.skus));

  const packEntities = packsWithCode.map((pk) => ({
    sku: pk.sku, label: pk.name, isPack: true, packId: pk.id, memberSkus: pk.skus,
  }));
  const productEntities = getResolvedSkus()
    .filter((sku) => !packMemberSkus.has(sku))
    .map((sku) => ({ sku, isPack: false }));

  return { entities: [...packEntities, ...productEntities], packMemberSkus };
}

/** sku_code_map + pack_code_map fundidos en un solo `Record<identidad, código>`, con la MISMA
 *  clave que usan las entidades de buildMatchEntities (el sku del producto, o el sku propio del
 *  pack). Sirve para que buildMappingSuggestions reconozca lo ya confirmado sin volver a preguntar. */
async function buildSavedMap(packEntities) {
  const savedSkuRows = await getSkuCodeMap();
  const savedMap = Object.fromEntries(savedSkuRows.map((r) => [r.sku, r.code]));
  const savedPackRows = await getPackCodeMap();
  const savedPackByPackId = Object.fromEntries(savedPackRows.map((r) => [r.packId, r.code]));
  for (const p of packEntities) {
    if (savedPackByPackId[p.packId] != null) savedMap[p.sku] = savedPackByPackId[p.packId];
  }
  return savedMap;
}

/**
 * Parsea el texto de una lista SIN guardar nada: devuelve las filas, las marcadas para revisión y
 * las sugerencias de mapeo contra los SKUs y los packs del hub. Es el preview del import.
 *
 * @param {string} text texto del PDF (ya extraído) o contenido de un CSV
 * @param {{ format?: 'pdf'|'csv' }} [opts]
 */
export async function previewImport(text, opts = {}) {
  const parsed = opts.format === 'csv' ? parseSupplierCsv(text) : parseSupplierList(text);

  // Códigos que trae esta lista, para sugerir el mapeo de los SKUs/packs que todavía no lo tienen.
  const codes = parsed.valid.map((r) => ({ code: r.code, description: r.description }));
  const { entities } = await buildMatchEntities();
  const savedMap = await buildSavedMap(entities.filter((e) => e.isPack));
  const mapping = buildMappingSuggestions(entities, codes, savedMap);

  return {
    stats: parsed.stats,
    rows: parsed.rows,
    flagged: parsed.flagged,
    mapping: {
      auto: mapping.auto.length,
      review: mapping.review,
      unmatched: mapping.unmatched.length,
    },
  };
}

/**
 * Confirma la importación: guarda la lista + sus ítems + el catálogo de códigos, aplica los
 * mapeos automáticos (de SKU y de pack), y actualiza el costo de cada SKU/pack mapeado con el
 * precio de esta lista.
 */
export async function confirmImport({ label, sourceFilename, discount1, discount2, rows, format }) {
  const items = (rows || []).filter((r) => r?.valid !== false && r?.code);
  const listId = await savePriceList({ label, sourceFilename, discount1, discount2, items });
  if (!listId) return { ok: false, error: 'No se pudo guardar la lista' };

  // Mapeos que se aplican solos (exactos y ya confirmados).
  const codes = items.map((r) => ({ code: r.code, description: r.description }));
  const { entities } = await buildMatchEntities();
  const savedMap = await buildSavedMap(entities.filter((e) => e.isPack));
  const { auto } = buildMappingSuggestions(entities, codes, savedMap);

  for (const p of auto) {
    if (p.suggestion.matchSource !== 'exact') continue;
    if (p.isPack) await upsertPackCodeMap(p.packId, p.suggestion.code, 'exact');
    else await upsertSkuCodeMap(p.sku, p.suggestion.code, 'exact');
  }

  const { updated, changedSkus } = await applyListCosts(listId, { discount1, discount2 });
  return { ok: true, listId, autoMapped: auto.length, costsUpdated: updated, changedSkus };
}

/** Costo unitario de una fila de product_costs, sea por bulto o directo. `null` si no hay costo previo. */
function unitCostOfSavedCost(cost) {
  if (!cost) return null;
  if (cost.bulkQty > 0) {
    return computeUnitCostFromBulk({
      bulkPrice: cost.bulkPrice, bulkQty: cost.bulkQty,
      discount1: cost.discount1 ?? 0, discount2: cost.discount2 ?? 0,
    });
  }
  return cost.unitCost ?? null;
}

/**
 * Vuelca los precios de una lista a `product_costs`. Primero los packs con código propio: el
 * mismo costo se vuelca a TODOS sus SKUs miembro (mismo precio, mismo cálculo — es "el mismo
 * pedido al proveedor" aunque adentro tenga modelos distintos). Después los SKUs sueltos —si uno
 * de esos SKUs también quedó con un mapeo individual guardado (de antes de tener pack, o a mano),
 * ese mapeo pisa el costo que dejó el pack, porque es más específico.
 *
 * También reporta `changedSkus`: los SKUs donde el costo unitario que deja ESTA lista es distinto
 * del que tenían antes (o no tenían ninguno) — es lo que le permite al front resaltar, después de
 * importar, cuáles filas se movieron de verdad y cuáles quedaron iguales.
 *
 * @returns {{ updated: number, changedSkus: string[] }}
 */
export async function applyListCosts(listId = null, { discount1 = 0, discount2 = 0 } = {}) {
  const items = await getPriceListItems(listId);
  if (items.length === 0) return { updated: 0, changedSkus: [] };
  const byCode = new Map(items.map((i) => [i.code, i]));

  let updated = 0;
  const changedSkus = [];

  const applyOne = async (sku, item, label) => {
    const prevUnit = unitCostOfSavedCost(await getProductCost(sku));
    const nextUnit = computeUnitCostFromBulk({ bulkPrice: item.bulkPrice, bulkQty: item.bulkQty, discount1, discount2 });
    const ok = await upsertCost(sku, {
      source: 'list', bulkPrice: item.bulkPrice, bulkQty: item.bulkQty, discount1, discount2, label,
    });
    if (!ok) return;
    updated++;
    if (prevUnit == null || Math.abs(prevUnit - nextUnit) > 0.01) changedSkus.push(sku);
  };

  const packMap = await getPackCodeMap();
  if (packMap.length > 0) {
    const packsById = new Map((await listPacks()).map((pk) => [pk.id, pk]));
    for (const { packId, code } of packMap) {
      const item = byCode.get(code);
      const pack = packsById.get(packId);
      if (!item || !pack || !(item.bulkPrice > 0) || !(item.bulkQty > 0)) continue;
      for (const sku of pack.skus) await applyOne(sku, item, item.description || pack.name);
    }
  }

  const map = await getSkuCodeMap();
  for (const { sku, code } of map) {
    const item = byCode.get(code);
    if (!item || !(item.bulkPrice > 0) || !(item.bulkQty > 0)) continue;
    await applyOne(sku, item, item.description);
  }
  return { updated, changedSkus };
}

/** Estado del mapeo: qué SKUs/packs tienen código, cuáles no, y qué códigos no tienen SKU/pack. */
export async function getMappingState() {
  const codes = await getSupplierCodes();
  const map = await getSkuCodeMap();
  const packMap = await getPackCodeMap();
  const packs = await listPacks();
  const packsWithCode = packs.filter((pk) => pk.sku);
  const packsById = new Map(packs.map((pk) => [pk.id, pk]));

  const mappedSkus = new Set(map.map((m) => m.sku));
  const mappedPackIds = new Set(packMap.map((m) => m.packId));
  const mappedCodes = new Set([...map.map((m) => m.code), ...packMap.map((m) => m.code)]);
  const packMemberSkus = new Set(packsWithCode.flatMap((pk) => pk.skus));
  const skus = getResolvedSkus().filter((s) => !packMemberSkus.has(s));

  return {
    mapped: map,
    packMapped: packMap.map((m) => ({
      ...m,
      packName: packsById.get(m.packId)?.name ?? null,
      packSku: packsById.get(m.packId)?.sku ?? null,
      memberSkus: packsById.get(m.packId)?.skus ?? [],
    })),
    // Productos del hub sin código: son de otra marca (costo a mano) o falta confirmarlos.
    skusWithoutCode: skus.filter((s) => !mappedSkus.has(s)),
    // Packs con código propio que todavía no se mapearon.
    packsWithoutCode: packsWithCode
      .filter((pk) => !mappedPackIds.has(pk.id))
      .map((pk) => ({ id: pk.id, name: pk.name, sku: pk.sku })),
    // Códigos que el proveedor vende y el hub no tiene: candidatos a crear producto.
    codesWithoutSku: codes.filter((c) => !mappedCodes.has(c.code)),
    totals: {
      codes: codes.length,
      skus: skus.length + packsWithCode.length,
      mapped: map.length + packMap.length,
    },
  };
}

export async function confirmMapping(sku, code, matchSource = 'manual') {
  return upsertSkuCodeMap(sku, code, matchSource);
}

export async function removeMapping(sku) {
  return deleteSkuCodeMap(sku);
}

export async function confirmPackMapping(packId, code, matchSource = 'manual') {
  return upsertPackCodeMap(packId, code, matchSource);
}

export async function removePackMapping(packId) {
  return deletePackCodeMap(packId);
}

export async function listImportedLists() {
  return getPriceLists();
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
