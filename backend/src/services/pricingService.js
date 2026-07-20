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
} from '../db.js';
import { patchTnPrice } from './conflictsService.js';
import { getMlItemBySku, getTnVariantBySku } from '../store.js';
import { computePrices, DEFAULT_SETTINGS } from '../lib/pricing.js';
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
 */
export function previewRow(cost, settings, dbSettings, current = {}) {
  const out = computePrices(costToInput(cost, dbSettings), settings);
  return {
    sku: cost.sku,
    label: cost.label ?? null,
    source: cost.source,
    unitCost: round2(out.unitCost),
    valorFinal: out.valorFinal,
    tn: out.tn,
    ml: out.ml,
    mlNet: round2(out.mlNet),
    currentMl: current.ml ?? null,
    currentTn: current.tn ?? null,
    // ¿el precio de ML cae en la zona de envío gratis? (para el aviso de zona muerta)
    freeShipping: out.ml > settings.freeShippingThreshold,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
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
  const costs = await getAllProductCosts();
  return costs.map((cost) => previewRow(cost, settings, db, currentBySku[cost.sku] || {}));
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
  const results = [];
  const tnBatch = [];

  for (const sku of skus) {
    const cost = await getProductCost(sku);
    if (!cost) {
      results.push({ sku, ok: false, reason: 'sin costo cargado' });
      continue;
    }
    const prices = computePrices(costToInput(cost, db), settings);

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
          targetPrice: prices.ml,
          idempotencyKey: `price_ml:${mlItem.itemId}:${prices.ml}`,
          contextJson: JSON.stringify({ sku, source: 'bulk' }),
        });
        results.push({ sku, channel: 'ml', ok: true, taskId, price: prices.ml });
      }
    }

    // ── Tienda Nube: se publica el precio de lista, vía bulk ──
    if (channels.tn !== false) {
      const tnVariant = getTnVariantBySku(sku);
      if (!tnVariant) {
        results.push({ sku, channel: 'tn', ok: false, reason: 'sin variante de TN mapeada' });
      } else {
        tnBatch.push({
          productId: tnVariant.productId, variantId: tnVariant.variantId,
          price: prices.tn.list, sku, label: cost.label ?? null,
        });
        results.push({ sku, channel: 'tn', ok: true, price: prices.tn.list });
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
