/**
 * Escrituras manuales de stock y precio en Tienda Nube (no por una venta): las usa Precio y stock
 * (routes/conflicts.js) y el editor de publicaciones (services/publicationUpdate.js), así las dos
 * dejan el mismo rastro en el historial y en la foto del catálogo.
 *
 * Mismo cuidado que en ML (ver CLAUDE.md, "El valor previo se lee ANTES de escribir"): el valor de
 * antes sale de la foto ANTES de escribir —nuestra propia escritura dispara el webhook de TN, que
 * puede mover la foto antes de que la leamos— y el eco se anota antes y se olvida si TN rechaza.
 */
import { tokens } from '../store.js';
import * as tn from '../lib/tiendanube.js';
// Imports por namespace: los tests de las rutas que usan este módulo mockean db.js y
// conflictsService.js solo con lo que cada ruta necesita.
import * as db from '../db.js';
import * as snapshot from './conflictsService.js';
import { rememberStockWrite, forgetStockWrite, tnStockEchoKey } from '../lib/stockEcho.js';

/** Pone el stock de una variante de TN. Devuelve true si TN lo aceptó. */
export async function setTnStockManual(productId, variantId, stock, { logPrefix = '[TN]' } = {}) {
  const pid = Number(productId);
  const vid = Number(variantId);
  const qty = Math.max(0, Math.floor(Number(stock)));
  const echoKey = tnStockEchoKey(pid, vid);
  const before = await snapshot.readTnSnapshotRow(pid, vid).catch((e) => {
    console.error(`${logPrefix} readTnSnapshotRow:`, e.message);
    return null;
  });
  rememberStockWrite(echoKey, qty);
  let ok;
  try {
    ok = await tn.updateVariantStock(tokens.tiendanube.access_token, tokens.tiendanube.store_id, pid, vid, qty);
  } catch (e) {
    forgetStockWrite(echoKey);
    throw e;
  }
  if (!ok) {
    forgetStockWrite(echoKey);
    return false;
  }
  await snapshot.patchTnStock(pid, vid, qty).catch((e) => console.error(`${logPrefix} patchTnStock:`, e.message));
  if (before && before.stock !== qty) {
    await db.insertAuditLog({
      source: 'manual',
      sku: before.sku || '',
      productLabel: 'Cambio manual',
      updatedChannel: 'tiendanube',
      stockBefore: before.stock,
      stockAfter: qty,
    }).catch((e) => console.error(`${logPrefix} insertAuditLog:`, e.message));
  } else if (!before) {
    console.warn(`${logPrefix} stock TN manual: sin fila en el snapshot para ${pid}/${vid}, no se registra en el historial.`);
  }
  return true;
}

/** Pone el precio de una variante de TN (o de todas, `applyAll`). Devuelve true si TN lo aceptó. */
export async function setTnPriceManual(productId, variantId, price, { applyAll = false, source = 'manual', productLabel = null } = {}) {
  const pid = Number(productId);
  const vid = Number(variantId);
  const before = await snapshot.readTnSnapshotRow(pid, vid).catch(() => null);
  const ok = applyAll
    ? await tn.updateVariantPriceAllVariants(tokens.tiendanube.access_token, tokens.tiendanube.store_id, pid, price)
    : await tn.updateVariantPrice(tokens.tiendanube.access_token, tokens.tiendanube.store_id, pid, vid, price);
  if (!ok) return false;
  await snapshot.patchTnPrice(pid, vid, price, !!applyAll).catch(() => {});
  if (before && before.price !== Number(price) && before.sku) {
    await db.insertPriceAudit?.({ sku: before.sku, channel: 'tiendanube', priceBefore: before.price, priceAfter: Number(price), source, productLabel }).catch(() => {});
  }
  return true;
}
