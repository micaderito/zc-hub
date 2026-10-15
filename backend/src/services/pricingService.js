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
} from '../db.js';
import { patchTnPrice, readTnSnapshotRow, getCatalogRows } from './conflictsService.js';
import { rememberPriceWrite, forgetPriceWrite, tnPriceEchoKey } from '../lib/stockEcho.js';
import {
  getMlItemBySku, getTnVariantBySku, getResolvedSkus, getMlToken, setResolutionFromAnalysis,
} from '../store.js';
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
  const packBySku = buildSkuPackIndex(packs);
  const queuedItems = new Set(activeTasks.filter((t) => t.kind === 'price_ml').map((t) => String(t.itemId)));
  return costs.map((cost) => ({
    ...previewRow(
      cost, settings, db,
      (currentBySku ? currentBySku[cost.sku] : prices?.get(cost.sku)) || {},
      overridesBySku[cost.sku] || {},
    ),
    mlQueued: queuedItems.has(String(getMlItemBySku(cost.sku)?.itemId ?? '')),
    // Nombre de la publicación: en un pack todos los modelos traen la MISMA descripción de la
    // lista (`label`), así que sin esto no hay forma de distinguirlos.
    name: names.get(cost.sku) ?? null,
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
  if (getResolvedSkus().length === 0) await loadCatalogContext();
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

/** sku_code_map + pack_code_map fundidos en un solo `Record<entityKey, código>` (`pack:<id>` /
 *  `sku:<sku>`, la clave de las entidades de buildMatchEntities). Sirve para que
 *  buildMappingSuggestions reconozca lo ya confirmado sin volver a preguntar. */
async function buildSavedMap() {
  const [skuRows, packRows] = await Promise.all([getSkuCodeMap(), getPackCodeMap()]);
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
 * las sugerencias de mapeo contra los SKUs y los packs del hub. Es el preview del import.
 *
 * @param {string} text texto del PDF (ya extraído) o contenido de un CSV
 * @param {{ format?: 'pdf'|'csv' }} [opts]
 */
export async function previewImport(text, opts = {}) {
  const parsed = opts.format === 'csv' ? parseSupplierCsv(text) : parseSupplierList(text);
  const { names } = await loadCatalogContext();

  // Códigos que trae esta lista, para sugerir el mapeo de los SKUs/packs que todavía no lo tienen.
  const codes = parsed.valid.map((r) => ({ code: r.code, description: r.description }));
  const { entities } = await buildMatchEntities(names);
  const savedMap = await buildSavedMap();
  const mappedCodes = new Set([...(await getSkuCodeMap()).map((m) => m.code), ...Object.values(savedMap)]);
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

/**
 * Confirma la importación: guarda la lista + sus ítems + el catálogo de códigos, aplica los
 * mapeos automáticos (de SKU y de pack), y actualiza el costo de cada SKU/pack mapeado con el
 * precio de esta lista. Devuelve el resumen de qué tomó precio de esta lista y qué no.
 */
export async function confirmImport({ label, sourceFilename, discount1, discount2, rows, format }) {
  const items = (rows || []).filter((r) => r?.valid !== false && r?.code);
  const { names } = await loadCatalogContext();
  const listId = await savePriceList({ label, sourceFilename, discount1, discount2, items });
  if (!listId) return { ok: false, error: 'No se pudo guardar la lista' };

  // Mapeos que se aplican solos (código igual, o `CODIGO-variante`) contra TODAS las listas: la
  // recién guardada ya es la más reciente.
  const codes = items.map((r) => ({ code: r.code, description: r.description }));
  const { newMappings } = await autoMapFromLists(names);
  const { entities } = await buildMatchEntities(names);

  const { updated, changedSkus } = await applyListCosts(listId, { discount1, discount2 });

  // Resumen con los mapeos YA guardados (incluye lo que se confirmó a mano antes de este POST):
  // lo pendiente que no se confirmó queda como "sin código".
  const savedMap = await buildSavedMap();
  const after = buildMappingSuggestions(entities, codes, savedMap);
  const confirmed = {
    auto: after.auto.filter((e) => e.suggestion.matchSource === 'saved'),
    review: [],
    unmatched: [...after.unmatched, ...after.review, ...after.auto.filter((e) => e.suggestion.matchSource !== 'saved')],
  };
  const skuMapCodes = new Set((await getSkuCodeMap()).map((m) => m.code));
  const split = splitMappingByList(confirmed, codes, skuMapCodes);

  return {
    ok: true,
    listId,
    autoMapped: split.inList.length,
    newMappings,
    costsUpdated: updated,
    changedSkus,
    summary: {
      inList: split.inList,
      otherLists: split.otherLists.length,
      unmatched: split.unmatched,
      codesWithoutProduct: split.codesWithoutProduct,
    },
  };
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
 * Vuelca el precio de un ítem de lista al costo de un SKU.
 * @returns {Promise<{ ok: boolean, changed: boolean }>} `changed` = el costo unitario se movió
 */
async function applyItemCost(sku, item, { discount1 = 0, discount2 = 0 } = {}, label = null) {
  const prevUnit = unitCostOfSavedCost(await getProductCost(sku));
  const nextUnit = computeUnitCostFromBulk({ bulkPrice: item.bulkPrice, bulkQty: item.bulkQty, discount1, discount2 });
  const ok = await upsertCost(sku, {
    source: 'list', bulkPrice: item.bulkPrice, bulkQty: item.bulkQty, discount1, discount2, label,
  });
  if (!ok) return { ok: false, changed: false };
  return { ok: true, changed: prevUnit == null || Math.abs(prevUnit - nextUnit) > 0.01 };
}

const hasBulkPrice = (item) => !!item && item.bulkPrice > 0 && item.bulkQty > 0;

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
    const r = await applyItemCost(sku, item, { discount1, discount2 }, label);
    if (!r.ok) return;
    updated++;
    if (r.changed) changedSkus.push(sku);
  };

  const packMap = await getPackCodeMap();
  if (packMap.length > 0) {
    const packsById = new Map((await listPacks()).map((pk) => [pk.id, pk]));
    for (const { packId, code } of packMap) {
      const item = byCode.get(code);
      const pack = packsById.get(packId);
      if (!pack || !hasBulkPrice(item)) continue;
      for (const sku of pack.skus) await applyOne(sku, item, item.description || pack.name);
    }
  }

  const map = await getSkuCodeMap();
  for (const { sku, code } of map) {
    const item = byCode.get(code);
    if (!hasBulkPrice(item)) continue;
    await applyOne(sku, item, item.description);
  }
  return { updated, changedSkus };
}

/**
 * Vuelca a `skus` el precio del código en la lista MÁS RECIENTE que lo trae (con los descuentos
 * de esa lista). Es lo que hace que mapear un código a mano tome el precio en el momento, sin
 * tener que volver a importar la lista.
 */
async function applyLatestCostForCode(skus, code, labelFallback = null) {
  const [item] = await getLatestPriceListItems([code]);
  if (!hasBulkPrice(item)) return { costsUpdated: 0, changedSkus: [], listLabel: null };
  const changedSkus = [];
  let costsUpdated = 0;
  for (const sku of skus) {
    const r = await applyItemCost(sku, item, item, item.description || labelFallback);
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
  const none = { newMappings: 0, costsUpdated: 0, changedSkus: [], mapped: [] };
  if (throttle && Date.now() - lastAutoMapAt < AUTO_MAP_THROTTLE_MS) return none;
  lastAutoMapAt = Date.now();

  const latest = await getLatestPriceListItems(null);
  if (latest.length === 0) return none;
  const codes = latest.map((i) => ({ code: i.code, description: i.description }));

  const [{ entities: all, packs }, removedKeys] = await Promise.all([buildMatchEntities(names), getRemovedCodeMapKeys()]);
  // Lo que la usuaria sacó a mano no se vuelve a mapear solo.
  const removed = new Set(removedKeys);
  const entities = all.filter((e) => !removed.has(e.key));
  const savedMap = await buildSavedMap();
  const first = buildMappingSuggestions(entities, codes, savedMap);

  // Packs con código propio que no matchearon ni estaban mapeados: se prueba con sus modelos.
  const mappedPackIds = new Set(first.auto.filter((e) => e.isPack).map((e) => e.packId));
  const resolved = new Set(getResolvedSkus());
  const orphanMembers = packs
    .filter((pk) => pk.sku && !mappedPackIds.has(pk.id))
    .flatMap((pk) => pk.skus)
    .filter((sku, i, all) => resolved.has(sku) && all.indexOf(sku) === i)
    .map((sku) => skuEntity(sku, names))
    .filter((e) => !removed.has(e.key));
  const second = buildMappingSuggestions(orphanMembers, codes, savedMap);

  const fresh = [...first.auto, ...second.auto].filter((e) => e.suggestion.matchSource !== 'saved');
  if (fresh.length === 0) return none;

  const individual = new Set([
    ...Object.keys(savedMap).filter((k) => k.startsWith('sku:')).map((k) => k.slice(4)),
    ...fresh.filter((e) => !e.isPack).map((e) => e.sku),
  ]);
  const out = { ...none, mapped: [] };
  for (const e of fresh) {
    const { code, matchSource } = e.suggestion;
    const ok = e.isPack
      ? await upsertPackCodeMap(e.packId, code, matchSource)
      : await upsertSkuCodeMap(e.sku, code, matchSource);
    if (!ok) continue;
    out.newMappings++;
    out.mapped.push({ key: e.key, sku: e.sku, code, matchSource });
    // Igual que confirmPackMapping: el precio del pack no pisa a un modelo con mapeo propio.
    const skus = e.isPack ? e.memberSkus.filter((s) => !individual.has(s)) : [e.sku];
    const r = await applyLatestCostForCode(skus, code, e.isPack ? e.name : null);
    out.costsUpdated += r.costsUpdated;
    out.changedSkus.push(...r.changedSkus);
  }
  if (out.newMappings > 0) console.log(`[Pricing] mapeo automático: ${out.mapped.map((m) => `${m.sku}→${m.code}`).join(', ')}`);
  return out;
}

/** Olvida el throttle de autoMapFromLists (en los tests). */
export function _resetAutoMapThrottle() {
  lastAutoMapAt = 0;
}

/**
 * Estado del mapeo para la pestaña "Mapeo": TODOS los productos de la tienda (y los packs con
 * código propio) con el código del proveedor que tienen — o ninguno —, de qué lista sale su
 * precio y si ya tienen costo. Además los códigos del proveedor, para elegir uno a mano.
 *
 * Mantiene los campos viejos (mapped, packMapped, skusWithoutCode, …) por compatibilidad.
 */
export async function getMappingState() {
  const { names } = await loadCatalogContext();
  const auto = await autoMapFromLists(names);
  const [codes, map, packMap, packs, latest, costs] = await Promise.all([
    getSupplierCodes(), getSkuCodeMap(), getPackCodeMap(), listPacks(),
    getLatestPriceListItems(null), getAllProductCosts(),
  ]);
  const packsWithCode = packs.filter((pk) => pk.sku);
  const packsById = new Map(packs.map((pk) => [pk.id, pk]));
  const latestByCode = new Map(latest.map((i) => [i.code, i]));
  const costBySku = new Set(costs.map((c) => c.sku));
  const packBySku = buildSkuPackIndex(packs);

  const mapBySku = new Map(map.map((m) => [m.sku, m]));
  const packMapById = new Map(packMap.map((m) => [m.packId, m]));
  const mappedCodes = new Set([...map.map((m) => m.code), ...packMap.map((m) => m.code)]);
  const packMemberSkus = new Set(packsWithCode.flatMap((pk) => pk.skus));
  const skus = getResolvedSkus().filter((s) => !packMemberSkus.has(s));

  const codeInfo = (code) => {
    if (!code) return { code: null, codeDescription: null, listLabel: null };
    const it = latestByCode.get(code);
    return { code, codeDescription: it?.description ?? null, listLabel: it?.listLabel ?? null };
  };

  const products = [
    ...packsWithCode.map((pk) => {
      const m = packMapById.get(pk.id);
      return {
        key: `pack:${pk.id}`,
        kind: 'pack',
        sku: pk.sku,
        packId: pk.id,
        name: pk.name,
        memberSkus: pk.skus,
        packName: null,
        ...codeInfo(m?.code),
        matchSource: m?.matchSource ?? null,
        hasCost: pk.skus.length > 0 && pk.skus.every((s) => costBySku.has(s)),
        mappedMl: pk.skus.some((s) => !!getMlItemBySku(s)),
        mappedTn: pk.skus.some((s) => !!getTnVariantBySku(s)),
        // Los modelos del pack, con el código del que sale su precio: el propio si tienen mapeo
        // individual (pisa al del pack, ver applyListCosts), si no el del pack.
        members: pk.skus.map((sku) => {
          const own = mapBySku.get(sku);
          return {
            key: `sku:${sku}`,
            sku,
            name: names.get(sku) ?? null,
            ...codeInfo(own?.code ?? m?.code),
            codeSource: own ? 'own' : (m ? 'pack' : null),
            matchSource: own?.matchSource ?? null,
            hasCost: costBySku.has(sku),
            mappedMl: !!getMlItemBySku(sku),
            mappedTn: !!getTnVariantBySku(sku),
          };
        }),
      };
    }),
    ...skus.map((sku) => {
      const m = mapBySku.get(sku);
      return {
        key: `sku:${sku}`,
        kind: 'sku',
        sku,
        packId: null,
        name: names.get(sku) ?? null,
        memberSkus: [],
        // Pack SIN código propio al que pertenece (para agrupar en la UI): sus modelos se mapean de a uno.
        packName: packBySku.get(sku)?.name ?? null,
        ...codeInfo(m?.code),
        matchSource: m?.matchSource ?? null,
        hasCost: costBySku.has(sku),
        mappedMl: !!getMlItemBySku(sku),
        mappedTn: !!getTnVariantBySku(sku),
        members: [],
      };
    }),
  ];

  return {
    products,
    // Lo que se acaba de mapear solo en esta lectura (para avisarlo y resaltar los costos que cambiaron).
    autoMapped: { count: auto.newMappings, changedSkus: auto.changedSkus, items: auto.mapped },
    codes: codes.map((c) => ({
      code: c.code,
      description: c.description ?? latestByCode.get(c.code)?.description ?? null,
      listLabel: latestByCode.get(c.code)?.listLabel ?? null,
      mapped: mappedCodes.has(c.code),
    }))
      // Un código que ya no está en ninguna lista (lista borrada) no da precio: no se ofrece.
      .filter((c) => latestByCode.has(c.code) || c.mapped),
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
    codesWithoutSku: codes.filter((c) => !mappedCodes.has(c.code) && latestByCode.has(c.code)),
    totals: {
      codes: codes.length,
      skus: skus.length + packsWithCode.length,
      mapped: map.length + packMap.length,
    },
  };
}

/**
 * Confirma (o corrige) el mapeo de un SKU y le vuelca en el momento el precio de ese código en la
 * lista más reciente que lo trae.
 */
export async function confirmMapping(sku, code, matchSource = 'manual') {
  const ok = await upsertSkuCodeMap(sku, code, matchSource);
  if (!ok) return { ok: false, costsUpdated: 0, changedSkus: [], listLabel: null };
  return { ok: true, ...(await applyLatestCostForCode([sku], code)) };
}

/**
 * Saca el código de un SKU. Queda marcado como "sacado a mano" (no se borra la fila) para que el
 * mapeo automático no se lo vuelva a poner; en un modelo de pack, vuelve a tomar el código del pack.
 */
export async function removeMapping(sku) {
  return markSkuCodeRemoved(sku);
}

/**
 * Igual que confirmMapping pero para un pack: el precio va a todos sus modelos, salvo a los que
 * tienen un mapeo individual propio (que es más específico, mismo criterio que applyListCosts).
 */
export async function confirmPackMapping(packId, code, matchSource = 'manual') {
  const ok = await upsertPackCodeMap(packId, code, matchSource);
  if (!ok) return { ok: false, costsUpdated: 0, changedSkus: [], listLabel: null };
  const pack = (await listPacks()).find((pk) => pk.id === packId);
  if (!pack) return { ok: true, costsUpdated: 0, changedSkus: [], listLabel: null };
  const individual = new Set((await getSkuCodeMap()).map((m) => m.sku));
  const skus = pack.skus.filter((s) => !individual.has(s));
  return { ok: true, ...(await applyLatestCostForCode(skus, code, pack.name)) };
}

/** Igual que removeMapping, para un pack. */
export async function removePackMapping(packId) {
  return markPackCodeRemoved(packId);
}

export async function listImportedLists() {
  return getPriceLists();
}

/** Borra una lista importada (ver deletePriceList). Los costos ya volcados quedan. */
export async function removeImportedList(listId) {
  const ok = await deletePriceList(listId);
  if (ok) _resetAutoMapThrottle();
  return ok;
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
