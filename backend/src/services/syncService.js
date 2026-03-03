/**
 * Lógica de sincronización: al descontar stock en un canal, actualizar el otro.
 * Si la sincronización está activada, se registra cada cambio en la auditoría (Postgres).
 */

import { tokens, getMlToken } from '../store.js';
import { getSkuByMlItem, getSkuByTnVariant, getMlItemBySku, getTnVariantBySku } from '../store.js';
import * as ml from '../lib/mercadolibre.js';
import * as tn from '../lib/tiendanube.js';
import { getSyncEnabled, insertAuditLog, getPendingReturnById, setReturnApproved } from '../db.js';

/** Arma "descripción | variante" desde el ítem de una orden ML (item.title + variation_attributes). */
function mlOrderItemDisplay(oi) {
  const title = oi?.item?.title ?? '';
  const attrs = oi?.item?.variation_attributes ?? [];
  const variantPart = attrs.map(a => `${a.name || a.id || ''}: ${a.value_name || a.value || ''}`).filter(Boolean).join(', ');
  if (!title && !variantPart) return null;
  return variantPart ? `${title} | ${variantPart}` : title;
}

/** Arma "descripción · variante" desde el ítem de una orden TN. */
function tnOrderItemDisplay(item) {
  const name = item?.name || item?.title || '';
  const variant = item?.variant_name || item?.variant || item?.option || '';
  if (!name && !variant) return null;
  return variant ? `${name} · ${variant}` : name;
}

/**
 * Escribe el SKU en Mercado Libre y Tienda Nube para un mapeo.
 * Devuelve { ml: boolean, tn: boolean, mlError?: string } según si se pudo actualizar cada uno.
 * Si ML falla, se captura el mensaje en mlError y se intenta igual actualizar TN.
 */
export async function persistSkuToChannels(entry) {
  const sku = (entry.sku || '').trim();
  if (!sku) return { ml: false, tn: false };
  let mlOk = false;
  let tnOk = false;
  let mlError = null;
  const accessToken = await getMlToken();
  if (entry.mercadolibre?.itemId && accessToken) {
    try {
      mlOk = entry.mercadolibre.variationId
        ? await ml.updateVariationSku(accessToken, entry.mercadolibre.itemId, entry.mercadolibre.variationId, sku)
        : await ml.updateItemSku(accessToken, entry.mercadolibre.itemId, sku);
    } catch (e) {
      mlError = e?.message || 'Error al actualizar SKU en Mercado Libre';
    }
  }
  if (entry.tiendanube?.productId != null && entry.tiendanube?.variantId != null && tokens.tiendanube?.access_token) {
    tnOk = await tn.updateVariantSku(
      tokens.tiendanube.access_token,
      tokens.tiendanube.store_id,
      entry.tiendanube.productId,
      entry.tiendanube.variantId,
      sku
    );
  }
  return { ml: mlOk, tn: tnOk, mlError: mlError || undefined };
}

/** Descontar stock en Tienda Nube para el SKU dado. Devuelve { ok, stockBefore, stockAfter }. */
export async function deductStockTiendaNube(sku, quantity) {
  const tnVariant = getTnVariantBySku(sku);
  if (!tnVariant?.productId || !tokens.tiendanube?.access_token) return { ok: false };
  const { productId, variantId } = tnVariant;
  const storeId = tokens.tiendanube.store_id;
  const orderRes = await fetch(
    `https://api.tiendanube.com/v1/${storeId}/products/${productId}/variants/${variantId}`,
    {
      headers: {
        Authentication: `bearer ${tokens.tiendanube.access_token}`,
        'User-Agent': 'ZonacuadernoSync/1.0'
      }
    }
  );
  if (!orderRes.ok) return { ok: false };
  const variant = await orderRes.json();
  const stockBefore = variant.stock ?? variant.inventory_levels?.[0]?.stock ?? 0;
  const newStock = Math.max(0, stockBefore - quantity);
  const ok = await tn.updateVariantStock(
    tokens.tiendanube.access_token,
    storeId,
    productId,
    variantId,
    newStock
  );
  return { ok, stockBefore, stockAfter: newStock };
}

/** Descontar stock en Mercado Libre para el SKU dado. Devuelve { ok, stockBefore, stockAfter }. */
export async function deductStockMercadoLibre(sku, quantity) {
  const mlItem = getMlItemBySku(sku);
  if (!mlItem?.itemId) return { ok: false };
  const accessToken = await getMlToken();
  if (!accessToken) return { ok: false };
  const item = await ml.getItem(accessToken, mlItem.itemId);
  if (!item) return { ok: false };
  const variationId = mlItem.variationId != null && mlItem.variationId !== '' ? mlItem.variationId : undefined;
  let stockBefore;
  if (variationId && item.variations?.length) {
    const variation = item.variations.find((v) => String(v.id ?? v.id_plain) === String(variationId));
    stockBefore = variation?.available_quantity ?? 0;
  } else {
    stockBefore = item.available_quantity ?? 0;
  }
  const newQty = Math.max(0, stockBefore - quantity);
  const ok = await ml.updateItemOrVariationStock(accessToken, mlItem.itemId, variationId, newQty);
  return { ok, stockBefore, stockAfter: newQty };
}

/** Restaurar stock en Tienda Nube (sumar cantidad). Devuelve { ok, stockBefore, stockAfter }. */
export async function restoreStockTiendaNube(sku, quantity) {
  const tnVariant = getTnVariantBySku(sku);
  if (!tnVariant?.productId || !tokens.tiendanube?.access_token) return { ok: false };
  const { productId, variantId } = tnVariant;
  const storeId = tokens.tiendanube.store_id;
  const orderRes = await fetch(
    `https://api.tiendanube.com/v1/${storeId}/products/${productId}/variants/${variantId}`,
    {
      headers: {
        Authentication: `bearer ${tokens.tiendanube.access_token}`,
        'User-Agent': 'ZonacuadernoSync/1.0'
      }
    }
  );
  if (!orderRes.ok) return { ok: false };
  const variant = await orderRes.json();
  const stockBefore = variant.stock ?? variant.inventory_levels?.[0]?.stock ?? 0;
  const newStock = stockBefore + Math.max(0, Math.floor(quantity));
  const ok = await tn.updateVariantStock(
    tokens.tiendanube.access_token,
    storeId,
    productId,
    variantId,
    newStock
  );
  return { ok, stockBefore, stockAfter: newStock };
}

/** Restaurar stock en Mercado Libre (sumar cantidad). Devuelve { ok, stockBefore, stockAfter }. */
export async function restoreStockMercadoLibre(sku, quantity) {
  const mlItem = getMlItemBySku(sku);
  if (!mlItem?.itemId) return { ok: false };
  const accessToken = await getMlToken();
  if (!accessToken) return { ok: false };
  const item = await ml.getItem(accessToken, mlItem.itemId);
  if (!item) return { ok: false };
  const variationId = mlItem.variationId != null && mlItem.variationId !== '' ? mlItem.variationId : undefined;
  let stockBefore;
  if (variationId && item.variations?.length) {
    const variation = item.variations.find((v) => String(v.id ?? v.id_plain) === String(variationId));
    stockBefore = variation?.available_quantity ?? 0;
  } else {
    stockBefore = item.available_quantity ?? 0;
  }
  const addQty = Math.max(0, Math.floor(quantity));
  const newQty = stockBefore + addQty;
  const ok = await ml.updateItemOrVariationStock(accessToken, mlItem.itemId, variationId, newQty);
  return { ok, stockBefore, stockAfter: newQty };
}

/**
 * Revierte un registro del historial: suma de nuevo la cantidad en el canal que se había descontado.
 * @param {{ sku: string, quantity: number, updatedChannel: string }} row - fila del audit
 * @returns {{ ok: boolean, error?: string }}
 */
export async function revertSyncAudit(row) {
  const sku = (row.sku || '').trim();
  const quantity = Math.max(0, Number(row.quantity) || 0);
  const channel = (row.updatedChannel || '').toLowerCase();
  if (!sku || quantity <= 0) return { ok: false, error: 'SKU o cantidad inválidos' };
  if (channel === 'tiendanube') {
    const out = await restoreStockTiendaNube(sku, quantity);
    return { ok: out.ok, error: out.ok ? undefined : 'No se pudo restaurar stock en Tienda Nube (revisá que el SKU siga vinculado)' };
  }
  if (channel === 'mercadolibre') {
    const out = await restoreStockMercadoLibre(sku, quantity);
    return { ok: out.ok, error: out.ok ? undefined : 'No se pudo restaurar stock en Mercado Libre (revisá que el SKU siga vinculado)' };
  }
  return { ok: false, error: 'Canal no reconocido' };
}

/** Dado un item_id (y opcional variation_id) de ML, encontrar SKU y descontar en TN. Solo si sync está activada. orderPayload = respuesta getOrder ML (opcional, para guardar en audit). */
export async function onMercadoLibreOrderPaid(orderItems, orderId = '', orderPayload = null) {
  const enabled = await getSyncEnabled();
  if (!enabled) return [];
  const results = [];
  for (const oi of orderItems) {
    const itemId = oi?.item?.id;
    const variationId = oi?.item?.variation_id ?? oi?.variation_id;
    const quantity = oi?.quantity ?? 1;
    if (!itemId) continue;
    let sku = getSkuByMlItem(itemId, variationId);
    if (!sku) {
      const accessToken = await getMlToken();
      if (accessToken) {
        const item = await ml.getItem(accessToken, itemId);
        sku = item ? ml.extractSkuFromItem(item) : null;
        if (item?.variations?.length && variationId) {
          const v = item.variations.find(vr => String(vr.id) === String(variationId));
          if (v?.seller_sku) sku = v.seller_sku;
        }
      }
    }
    if (sku) {
      const out = await deductStockTiendaNube(sku, quantity);
      results.push({ itemId, variationId, sku, quantity, ...out });
      if (out.ok && out.stockBefore !== undefined) {
        const saleItemId = orderItems.length > 1 && oi.id != null && oi.id !== ''
          ? String(oi.id)
          : null;
        await insertAuditLog({
          channelSale: 'mercadolibre',
          orderId: String(orderId),
          saleItemId,
          sku,
          productLabel: 'Venta ML',
          productDisplay: mlOrderItemDisplay(oi),
          quantity,
          updatedChannel: 'tiendanube',
          stockBefore: out.stockBefore,
          stockAfter: out.stockAfter ?? out.stockBefore - quantity,
          notificationPayload: orderPayload
        });
      }
    }
  }
  return results;
}

/** Dado variant_id de TN, encontrar SKU y descontar en ML. Solo si sync está activada. orderPayload = respuesta getOrder TN (opcional, para guardar en audit). */
export async function onTiendaNubeOrderPaid(orderItems, orderId = '', orderPayload = null) {
  const enabled = await getSyncEnabled();
  if (!enabled) {
    console.warn('[Sync] TN orden %s: sincronización desactivada, no se descuenta stock en ML.', orderId);
    return [];
  }
  const results = [];
  for (const item of orderItems) {
    const variantId = item.variant_id ?? item.id;
    const quantity = item.quantity ?? 1;
    if (variantId == null) {
      console.warn('[Sync] TN orden %s: ítem sin variant_id', orderId);
      continue;
    }
    const sku = getSkuByTnVariant(variantId) || (item.sku ? String(item.sku).trim() : null);
    if (!sku) {
      console.warn('[Sync] TN orden %s: variante %s no tiene SKU en el mapeo (¿producto vinculado en Conflictos?).', orderId, variantId);
      continue;
    }
    if (!getMlItemBySku(sku)) {
      console.warn('[Sync] TN orden %s: SKU %s no tiene ítem de ML en el mapeo.', orderId, sku);
      continue;
    }
    const out = await deductStockMercadoLibre(sku, quantity);
    results.push({ variantId, sku, quantity, ...out });
    if (out.ok && out.stockBefore !== undefined) {
      const productId = item.product_id ?? item.productId;
      const saleItemId = productId != null ? `${productId}:${variantId}` : String(variantId);
      await insertAuditLog({
        channelSale: 'tiendanube',
        orderId: String(orderId),
        saleItemId,
        sku,
        productLabel: 'Venta TN',
        productDisplay: tnOrderItemDisplay(item),
        quantity,
        updatedChannel: 'mercadolibre',
        stockBefore: out.stockBefore,
        stockAfter: out.stockAfter ?? out.stockBefore - quantity,
        notificationPayload: orderPayload
      });
      console.log('[Sync] TN orden %s: descontado stock ML SKU %s, cantidad %s (antes %s, después %s)', orderId, sku, quantity, out.stockBefore, out.stockAfter);
    } else {
      console.error('[Sync] TN orden %s: no se pudo descontar stock en ML para SKU %s', orderId, sku);
    }
  }
  return results;
}

/** Orden ML cancelada: restaurar stock en TN por cada ítem. Solo si sync está activada. orderPayload = respuesta getOrder ML (opcional). */
export async function onMercadoLibreOrderCancelled(orderItems, orderId = '', orderPayload = null) {
  const enabled = await getSyncEnabled();
  if (!enabled) return [];
  const results = [];
  for (const oi of orderItems) {
    const itemId = oi?.item?.id;
    const variationId = oi?.item?.variation_id ?? oi?.variation_id;
    const quantity = oi?.quantity ?? 1;
    if (!itemId) continue;
    let sku = getSkuByMlItem(itemId, variationId);
    if (!sku) {
      const accessToken = await getMlToken();
      if (accessToken) {
        const item = await ml.getItem(accessToken, itemId);
        sku = item ? ml.extractSkuFromItem(item) : null;
        if (item?.variations?.length && variationId) {
          const v = item.variations.find(vr => String(vr.id) === String(variationId));
          if (v?.seller_sku) sku = v.seller_sku;
        }
      }
    }
    if (sku) {
      const out = await restoreStockTiendaNube(sku, quantity);
      results.push({ itemId, variationId, sku, quantity, ...out });
      if (out.ok && out.stockBefore !== undefined) {
        const saleItemId = orderItems.length > 1 && oi.id != null && oi.id !== ''
          ? String(oi.id)
          : null;
        await insertAuditLog({
          channelSale: 'mercadolibre',
          orderId: String(orderId),
          saleItemId,
          sku,
          productLabel: 'Cancelación ML',
          productDisplay: mlOrderItemDisplay(oi),
          quantity,
          updatedChannel: 'tiendanube',
          stockBefore: out.stockBefore,
          stockAfter: out.stockAfter ?? out.stockBefore + quantity,
          notificationPayload: orderPayload
        });
      }
    }
  }
  return results;
}

/** Orden TN cancelada: restaurar stock en ML por cada producto. Solo si sync está activada. orderPayload = respuesta getOrder TN (opcional). */
export async function onTiendaNubeOrderCancelled(orderItems, orderId = '', orderPayload = null) {
  const enabled = await getSyncEnabled();
  if (!enabled) return [];
  const results = [];
  for (const item of orderItems) {
    const variantId = item.variant_id ?? item.id;
    const quantity = item.quantity ?? 1;
    if (variantId == null) continue;
    const sku = getSkuByTnVariant(variantId) || (item.sku ? String(item.sku).trim() : null);
    if (!sku) continue;
    if (!getMlItemBySku(sku)) continue;
    const out = await restoreStockMercadoLibre(sku, quantity);
    results.push({ variantId, sku, quantity, ...out });
    if (out.ok && out.stockBefore !== undefined) {
      const productId = item.product_id ?? item.productId;
      const saleItemId = productId != null ? `${productId}:${variantId}` : String(variantId);
      await insertAuditLog({
        channelSale: 'tiendanube',
        orderId: String(orderId),
        saleItemId,
        sku,
        productLabel: 'Cancelación TN',
        productDisplay: tnOrderItemDisplay(item),
        quantity,
        updatedChannel: 'mercadolibre',
        stockBefore: out.stockBefore,
        stockAfter: out.stockAfter ?? out.stockBefore + quantity,
        notificationPayload: orderPayload
      });
    }
  }
  return results;
}

/** Sincronizar precios: llevar precio de ML al ítem TN con el mismo SKU (o viceversa). */
export async function syncPricesForSku(sku) {
  const mlIds = getMlItemBySku(sku);
  const tnIds = getTnVariantBySku(sku);
  if (!mlIds?.itemId || !tnIds || !tokens.tiendanube?.access_token) return { ml: false, tn: false };
  const mlToken = await getMlToken();
  if (!mlToken) return { ml: false, tn: false };
  const item = await ml.getItem(mlToken, mlIds.itemId);
  const priceML = item?.price ?? 0;
  if (priceML <= 0) return { ml: false, tn: false };
  const tnOk = await tn.updateVariantPrice(
    tokens.tiendanube.access_token,
    tokens.tiendanube.store_id,
    tnIds.productId,
    tnIds.variantId,
    priceML
  );
  return { ml: true, tn: tnOk };
}

/**
 * Aprobar una devolución pendiente: restaura stock en ML y en TN para ese SKU/cantidad.
 * Devuelve { ok, error?, mlRestored, tnRestored }.
 */
export async function approvePendingReturn(returnId) {
  const row = await getPendingReturnById(returnId);
  if (!row || row.status !== 'pending') return { ok: false, error: 'Devolución no encontrada o ya aprobada' };

  let sku = (row.sku || '').trim() || null;
  if (!sku) {
    sku = getSkuByMlItem(row.itemId, row.variationId);
    if (!sku) {
      const accessToken = await getMlToken();
      if (accessToken) {
        const item = await ml.getItem(accessToken, row.itemId);
        if (item) sku = ml.extractSkuFromItem(item);
        if (!sku && item?.variations?.length && row.variationId) {
          const v = item.variations.find(vr => String(vr.id ?? vr.id_plain) === String(row.variationId));
          if (v?.seller_sku) sku = v.seller_sku;
        }
      }
    }
  }
  if (!sku) return { ok: false, error: 'No se pudo obtener el SKU del ítem' };

  const quantity = Math.max(1, Number(row.quantity) || 1);
  let mlRestored = false;
  let tnRestored = false;

  try {
    const outMl = await restoreStockMercadoLibre(sku, quantity);
    mlRestored = outMl.ok;
    if (outMl.ok && outMl.stockBefore !== undefined) {
      const saleItemId = row.variationId ? `${row.itemId}:${row.variationId}` : String(row.itemId);
      await insertAuditLog({
        channelSale: 'mercadolibre',
        orderId: String(row.orderId),
        saleItemId,
        sku,
        productLabel: 'Devolución aprobada',
        productDisplay: row.productLabel ?? null,
        quantity,
        updatedChannel: 'mercadolibre',
        stockBefore: outMl.stockBefore,
        stockAfter: outMl.stockAfter ?? outMl.stockBefore + quantity
      });
    }
  } catch (e) {
    console.error('approvePendingReturn ML:', e);
  }

  try {
    const outTn = await restoreStockTiendaNube(sku, quantity);
    tnRestored = outTn.ok;
    if (outTn.ok && outTn.stockBefore !== undefined) {
      const saleItemId = row.variationId ? `${row.itemId}:${row.variationId}` : String(row.itemId);
      await insertAuditLog({
        channelSale: 'mercadolibre',
        orderId: String(row.orderId),
        saleItemId,
        sku,
        productLabel: 'Devolución aprobada',
        productDisplay: row.productLabel ?? null,
        quantity,
        updatedChannel: 'tiendanube',
        stockBefore: outTn.stockBefore,
        stockAfter: outTn.stockAfter ?? outTn.stockBefore + quantity
      });
    }
  } catch (e) {
    console.error('approvePendingReturn TN:', e);
  }

  if (mlRestored || tnRestored) {
    await setReturnApproved(returnId);
    return { ok: true, mlRestored, tnRestored };
  }
  return { ok: false, error: 'No se pudo restaurar el stock en ninguna plataforma', mlRestored, tnRestored };
}
