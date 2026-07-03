/**
 * Lógica de sincronización: al descontar stock en un canal, actualizar el otro.
 * Si la sincronización está activada, se registra cada cambio en la auditoría (Postgres).
 */

import { tokens, getMlToken, addResolution } from '../store.js';
import { getSkuByMlItem, getSkuByTnVariant, getMlItemBySku, getTnVariantBySku } from '../store.js';
import * as ml from '../lib/mercadolibre.js';
import * as tn from '../lib/tiendanube.js';
import { getSyncEnabled, insertAuditLog, getPendingReturnById, setReturnApproved, enqueueMlTask, waitForMlTask } from '../db.js';

/**
 * El mapeo SKU↔canal (`store.js`) vive solo en memoria y se llena al correr el análisis de
 * Conflictos/Precio y Stock. Si el backend se reinició y todavía no se visitó esa pantalla,
 * el mapeo está vacío aunque el SKU siga vinculado. Antes de dar por perdido un SKU, se
 * refresca el análisis (getAnalysis, con su propio cache) y se reintenta la resolución.
 */
async function ensureSkuResolved(sku, side) {
  const resolved = side === 'tn' ? getTnVariantBySku(sku) : getMlItemBySku(sku);
  if (resolved) return;
  try {
    const { getAnalysis } = await import('./conflictsService.js');
    const analysis = await getAnalysis();
    for (const m of analysis.mappings || []) addResolution(m);
  } catch (e) {
    console.error('[Sync] No se pudo refrescar el mapeo SKU→canal:', e.message);
  }
}

/** ID real de la orden ML (order.id); si no vino el payload completo, usa el fallback recibido. */
function resolveMlOrderId(orderPayload, fallback) {
  return String(orderPayload?.id ?? fallback ?? '');
}

/** Nro de venta real (pack_id) de una orden ML; si la orden no forma parte de un pack, ML no trae pack_id y se usa el fallback (el propio order id). */
function resolveMlPackId(orderPayload, fallback) {
  return String(orderPayload?.pack_id ?? fallback ?? '');
}

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
 * Enqueue SKU update en ML y escribe SKU en TN directo.
 * ML va a la cola para garantizar durabilidad (no se pierde si el proceso cae).
 * TN queda directo porque no tiene problema de 429.
 * Devuelve { ml: boolean, tn: boolean, mlTaskId? } — ml=true significa "encolado", no "completado".
 */
export async function persistSkuToChannels(entry) {
  const sku = (entry.sku || '').trim();
  if (!sku) return { ml: false, tn: false };

  let mlTaskId = null;
  let tnOk = false;

  if (entry.mercadolibre?.itemId) {
    const { itemId, variationId } = entry.mercadolibre;
    const idKey = `sku_ml:${itemId}:${variationId || 'item'}`;
    mlTaskId = await enqueueMlTask({
      kind: 'sku_ml',
      itemId,
      variationId: variationId || null,
      targetSku: sku,
      idempotencyKey: idKey,
    });
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

  return { ml: !!mlTaskId, tn: tnOk, mlTaskId: mlTaskId ?? undefined };
}

/** Descontar stock en Tienda Nube para el SKU dado. Devuelve { ok, stockBefore, stockAfter }. */
export async function deductStockTiendaNube(sku, quantity) {
  await ensureSkuResolved(sku, 'tn');
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

/**
 * Descuenta stock en ML encolando la tarea en Postgres.
 * target_qty es negativo (delta relativo). El worker hace GET → computa → PUT.
 * auditCtx: datos para insertAuditLog que el worker ejecuta al completar.
 * Devuelve { ok, queued: true, taskId } — ok=true significa "encolado con éxito".
 */
export async function deductStockMercadoLibre(sku, quantity, auditCtx = null) {
  await ensureSkuResolved(sku, 'ml');
  const mlItem = getMlItemBySku(sku);
  if (!mlItem?.itemId) return { ok: false };
  const { itemId, variationId: rawVid } = mlItem;
  const variationId = rawVid != null && rawVid !== '' ? String(rawVid) : null;
  const delta = -Math.max(0, Math.floor(quantity));
  const taskId = await enqueueMlTask({
    kind: 'stock_ml',
    itemId,
    variationId,
    targetQty: delta,
    contextJson: auditCtx ? JSON.stringify({ audit: auditCtx }) : null,
    idempotencyKey: null, // sin idempotency — cada deducción es un evento único
  });
  if (!taskId) return { ok: false };
  return { ok: true, queued: true, taskId };
}

/** Restaurar stock en Tienda Nube (sumar cantidad). Devuelve { ok, stockBefore, stockAfter }. */
export async function restoreStockTiendaNube(sku, quantity) {
  await ensureSkuResolved(sku, 'tn');
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

/**
 * Restaura stock en ML encolando la tarea en Postgres.
 * target_qty es positivo (delta relativo). El worker hace GET → computa → PUT.
 * Devuelve { ok, queued: true, taskId }.
 */
export async function restoreStockMercadoLibre(sku, quantity, auditCtx = null) {
  await ensureSkuResolved(sku, 'ml');
  const mlItem = getMlItemBySku(sku);
  if (!mlItem?.itemId) return { ok: false };
  const { itemId, variationId: rawVid } = mlItem;
  const variationId = rawVid != null && rawVid !== '' ? String(rawVid) : null;
  const delta = Math.max(0, Math.floor(quantity));
  const taskId = await enqueueMlTask({
    kind: 'stock_ml',
    itemId,
    variationId,
    targetQty: delta,
    contextJson: auditCtx ? JSON.stringify({ audit: auditCtx }) : null,
    idempotencyKey: null,
  });
  if (!taskId) return { ok: false };
  return { ok: true, queued: true, taskId };
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
    // La restauración en ML se encola y la aplica el worker en segundo plano; esperamos a que
    // termine antes de marcar el registro como revertido (si no, el historial diría "revertido"
    // sin que el stock en ML se haya actualizado todavía).
    if (out.ok && out.queued && out.taskId) {
      const status = await waitForMlTask(out.taskId);
      if (status?.status === 'failed') {
        return { ok: false, error: status.lastError || 'No se pudo restaurar stock en Mercado Libre (la tarea encolada falló).' };
      }
    }
    return { ok: out.ok, error: out.ok ? undefined : 'No se pudo restaurar stock en Mercado Libre (revisá que el SKU siga vinculado)' };
  }
  return { ok: false, error: 'Canal no reconocido' };
}

/** Dado un item_id (y opcional variation_id) de ML, encontrar SKU y descontar en TN. orderId = nro de venta (pack_id); saleOrderId opcional = nro de orden (order id del pack). Usa mapeo Conflictos, luego seller_sku del ítem en la orden, luego GET item ML. */
export async function onMercadoLibreOrderPaid(orderItems, orderId = '', orderPayload = null, saleOrderId = null) {
  const enabled = await getSyncEnabled();
  if (!enabled) {
    console.warn('[Sync] ML orden %s: sincronización desactivada, no se descuenta.', orderId);
    return [];
  }
  const realOrderId = resolveMlOrderId(orderPayload, saleOrderId ?? orderId);
  const packId = resolveMlPackId(orderPayload, orderId);
  const results = [];
  for (const oi of orderItems) {
    const itemId = oi?.item?.id;
    const variationId = oi?.item?.variation_id ?? oi?.variation_id;
    const quantity = oi?.quantity ?? 1;
    if (!itemId) continue;
    let sku = getSkuByMlItem(itemId, variationId);
    if (!sku && oi?.item?.seller_sku) sku = String(oi.item.seller_sku).trim() || null;
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
    if (!sku) {
      console.warn('[Sync] ML orden %s: ítem %s sin SKU (mapeo, order_item.seller_sku y GET item).', orderId, itemId);
      continue;
    }
    const out = await deductStockTiendaNube(sku, quantity);
    results.push({ itemId, variationId, sku, quantity, ...out });
    if (!out.ok) {
      console.warn('[Sync] ML orden %s: ítem %s SKU=%s — descuento en TN falló (variante no en TN o API).', orderId, itemId, sku);
    }
    if (out.ok && out.stockBefore !== undefined) {
      const saleItemId = saleOrderId != null ? String(saleOrderId) : (orderItems.length > 1 && oi.id != null && oi.id !== '' ? String(oi.id) : null);
      await insertAuditLog({
        channelSale: 'mercadolibre',
        orderId: realOrderId,
        packId,
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
    const productId = item.product_id ?? item.productId;
    const saleItemId = productId != null ? `${productId}:${variantId}` : String(variantId);
    const auditCtx = {
      channelSale: 'tiendanube',
      orderId: String(orderId),
      saleItemId,
      sku,
      productLabel: 'Venta TN',
      productDisplay: tnOrderItemDisplay(item),
      quantity,
      updatedChannel: 'mercadolibre',
      notificationPayload: orderPayload,
    };
    const out = await deductStockMercadoLibre(sku, quantity, auditCtx);
    results.push({ variantId, sku, quantity, ...out });
    if (out.ok) {
      console.log('[Sync] TN orden %s: SKU %s encolado en ML (taskId %s)', orderId, sku, out.taskId);
    } else {
      console.error('[Sync] TN orden %s: no se pudo encolar stock en ML para SKU %s', orderId, sku);
    }
  }
  return results;
}

/** Orden ML cancelada: restaurar stock en TN por cada ítem. Solo si sync está activada. orderPayload = respuesta getOrder ML (opcional). */
export async function onMercadoLibreOrderCancelled(orderItems, orderId = '', orderPayload = null) {
  const enabled = await getSyncEnabled();
  if (!enabled) return [];
  const realOrderId = resolveMlOrderId(orderPayload, orderId);
  const packId = resolveMlPackId(orderPayload, orderId);
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
          orderId: realOrderId,
          packId,
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
    const productId = item.product_id ?? item.productId;
    const saleItemId = productId != null ? `${productId}:${variantId}` : String(variantId);
    const auditCtx = {
      channelSale: 'tiendanube',
      orderId: String(orderId),
      saleItemId,
      sku,
      productLabel: 'Cancelación TN',
      productDisplay: tnOrderItemDisplay(item),
      quantity,
      updatedChannel: 'mercadolibre',
      notificationPayload: orderPayload,
    };
    const out = await restoreStockMercadoLibre(sku, quantity, auditCtx);
    results.push({ variantId, sku, quantity, ...out });
    if (out.ok) {
      console.log('[Sync] TN cancelación %s: SKU %s encolado en ML (taskId %s)', orderId, sku, out.taskId);
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
    const saleItemId = row.variationId ? `${row.itemId}:${row.variationId}` : String(row.itemId);
    const auditCtx = {
      channelSale: 'mercadolibre',
      orderId: String(row.orderId),
      saleItemId,
      sku,
      productLabel: 'Devolución aprobada',
      productDisplay: row.productLabel ?? null,
      quantity,
      updatedChannel: 'mercadolibre',
    };
    const outMl = await restoreStockMercadoLibre(sku, quantity, auditCtx);
    mlRestored = outMl.ok;
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
        stockAfter: outTn.stockAfter ?? outTn.stockBefore + quantity,
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
