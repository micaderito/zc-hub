import { Router } from 'express';
import { syncPricesForSku, approvePendingReturn, revertSyncAudit } from '../services/syncService.js';
import { getResolvedSkus, getSkuByMlItem, getMlToken, tokens } from '../store.js';
import * as ml from '../lib/mercadolibre.js';
import * as tn from '../lib/tiendanube.js';
import { getSyncEnabled, setSyncEnabled, getAuditLog, getAuditRowById, setAuditReverted, hasDatabase, getPendingReturns, insertPendingReturn, hasPendingReturnForClaimItem, releaseOrderProcessingClaim } from '../db.js';
import { onMercadoLibreOrderPaid } from '../services/syncService.js';

export const syncRoutes = Router();

/** Volver a registrar webhooks de Tienda Nube (order/paid, order/cancelled, etc.). Útil cuando cambia la URL de ngrok. */
syncRoutes.post('/register-webhooks', async (_, res) => {
  const baseUrl = process.env.WEBHOOK_BASE_URL;
  if (!baseUrl) return res.status(400).json({ error: 'WEBHOOK_BASE_URL no configurada en .env' });
  const { access_token, store_id } = tokens.tiendanube || {};
  if (!access_token || !store_id) return res.status(401).json({ error: 'Tienda Nube no conectada' });
  try {
    const created = await tn.registerOrderWebhooks(access_token, store_id, baseUrl);
    res.json({ ok: true, registered: created.length, created });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Estado de la sincronización de stock y si hay base de datos configurada. */
syncRoutes.get('/config', async (_, res) => {
  try {
    const enabled = await getSyncEnabled();
    const hasDb = hasDatabase();
    res.json({ enabled, hasDatabase: hasDb });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Activar o desactivar la sincronización de stock al vender en ML o TN. */
syncRoutes.patch('/config', async (req, res) => {
  if (!hasDatabase()) {
    return res.status(503).json({ error: 'No hay base de datos configurada. Agregá DATABASE_URL en .env (ej. Supabase).' });
  }
  const enabled = req.body?.enabled === true;
  try {
    await setSyncEnabled(enabled);
    res.json({ enabled });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Reintentar sincronización por pack_id (nro de venta).
 * Flujo: 1) GET /packs/:packId → { orders: [{ id: 2000015382437056 }, ...] }
 *        2) Por cada orders[].id → GET /orders/:orderId → { order_items: [...], pack_id, ... }
 *        3) onMercadoLibreOrderPaid(items, packId, order) → descuenta en TN y crea sync_audit (nro venta = pack_id, nro orden = order.id).
 */
syncRoutes.post('/reprocess-order', async (req, res) => {
  const rawPackId = (req.body?.packId ?? req.body?.orderId ?? '').trim();
  const packId = rawPackId.replace(/\D/g, '') || rawPackId;
  if (!packId) return res.status(400).json({ error: 'packId es requerido (nro de venta que ves en la app de ML).' });
  const accessToken = await getMlToken();
  if (!accessToken) return res.status(401).json({ error: 'No conectado a Mercado Libre' });
  if (!hasDatabase()) return res.status(503).json({ error: 'Base de datos no configurada' });
  try {
    const syncEnabled = await getSyncEnabled();
    if (!syncEnabled) {
      return res.status(400).json({
        error: 'Sincronización desactivada. Activá el switch «Sincronización de stock» en esta página y volvé a intentar.'
      });
    }
    const pack = await ml.getPack(accessToken, packId);
    const ordersList = pack?.orders ?? pack?.data?.orders ?? (Array.isArray(pack?.data) ? pack.data : []);
    if (!pack || !Array.isArray(ordersList) || ordersList.length === 0) {
      return res.status(404).json({ error: 'Pack no encontrado. Usá el nro de venta (pack id) que ves en la app de ML.' });
    }
    let totalSynced = 0;
    for (const o of ordersList) {
      const orderId = String(o?.id ?? o);
      if (!orderId) continue;
      await releaseOrderProcessingClaim('mercadolibre', orderId, 'deduct');
      const order = await ml.getOrder(accessToken, orderId);
      if (!order?.order_items?.length) continue;
      const items = order.order_items || [];
      let itemsWithSku = 0;
      for (const oi of items) {
        const itemId = oi?.item?.id;
        const variationId = oi?.item?.variation_id ?? oi?.variation_id;
        if (!itemId) continue;
        let sku = getSkuByMlItem(itemId, variationId);
        if (!sku) {
          const item = await ml.getItem(accessToken, itemId);
          if (item) sku = ml.extractSkuFromItem(item);
          if (!sku && item?.variations?.length && variationId) {
            const v = item.variations.find(vr => String(vr.id ?? vr.id_plain) === String(variationId));
            if (v?.seller_sku) sku = v.seller_sku;
          }
        }
        if (sku) itemsWithSku++;
      }
      if (itemsWithSku === 0) continue;
      const results = await onMercadoLibreOrderPaid(items, packId, order, order.id);
      totalSynced += results.length;
    }
    if (totalSynced === 0) {
      return res.status(400).json({
        error: 'Ningún ítem del pack tiene SKU vinculado o no se pudo descontar en TN. Revisá Conflictos (Precio y stock).'
      });
    }
    res.json({ ok: true, orderId: packId, itemsSynced: totalSynced });
  } catch (e) {
    console.error('reprocess-order:', e);
    res.status(500).json({ error: e.message || 'Error al reprocesar' });
  }
});

/** Historial de sincronización. Query: limit, offset, orderId (buscar por nº venta o por id. ítem en la venta). */
syncRoutes.get('/audit', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Number(req.query.offset) || 0;
    const search = (req.query.orderId || '').trim();
    const { rows, total } = await getAuditLog(limit, offset, search);
    res.json({ rows, total });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Revierte un registro del historial: vuelve a sumar en el canal donde se había descontado. */
syncRoutes.post('/audit/:id/revert', async (req, res) => {
  const id = Number(req.params.id);
  if (!id || Number.isNaN(id)) return res.status(400).json({ error: 'id inválido' });
  try {
    const row = await getAuditRowById(id);
    if (!row) return res.status(404).json({ error: 'Registro no encontrado' });
    if (row.revertedAt) return res.status(400).json({ error: 'Este registro ya fue revertido' });
    const result = await revertSyncAudit(row);
    if (!result.ok) return res.status(502).json({ error: result.error || 'No se pudo revertir' });
    const updated = await setAuditReverted(id);
    if (!updated) return res.status(409).json({ error: 'El registro fue revertido por otro proceso' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Sincronizar precios de un SKU a ambos canales. */
syncRoutes.post('/prices/:sku', async (req, res) => {
  try {
    const result = await syncPricesForSku(req.params.sku);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Sincronizar precios de todos los SKU resueltos (mismo SKU en ML y TN). */
syncRoutes.post('/prices', async (req, res) => {
  const results = {};
  for (const sku of getResolvedSkus()) {
    try {
      results[sku] = await syncPricesForSku(sku);
    } catch (e) {
      results[sku] = { error: e.message };
    }
  }
  res.json(results);
});

/** Listar devoluciones pendientes (ML) para aprobar y restaurar stock. */
syncRoutes.get('/returns', async (_, res) => {
  try {
    const rows = await getPendingReturns();
    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Estados de devolución ML que consideramos ya cerrados (no mostrar como pendiente). */
const ML_RETURN_CLOSED_STATUSES = ['closed', 'delivered', 'expired', 'failed', 'cancelled', 'canceled', 'not_delivered'];

/** Caché del último fetch de devoluciones (evita 429 por clics seguidos en Actualizar). TTL 2 min. */
const RETURNS_FETCH_CACHE_TTL_MS = 2 * 60 * 1000;
let returnsFetchCache = { at: 0, result: null };

/**
 * Procesa un reclamo de ML: si es devolución (return) y no está cerrada, agrega sus ítems a sync_pending_returns.
 * Usado por POST /returns/fetch y por el webhook de notificaciones de claims.
 * @returns {{ created: number, skipped: number }}
 */
export async function processClaimToPendingReturns(accessToken, claim) {
  const claimId = claim.id;
  let orderId = claim.resource_id;
  if (!claimId) return { created: 0, skipped: 0 };
  if (!hasDatabase()) return { created: 0, skipped: 0 };

  const returnsData = await ml.getClaimReturns(accessToken, claimId);
  const singleReturn = returnsData && typeof returnsData === 'object' && !Array.isArray(returnsData) && (returnsData.id != null || returnsData.claim_id != null || returnsData.status != null);
  const returnsList = Array.isArray(returnsData) ? returnsData : singleReturn ? [returnsData] : [];
  const returnStatus = returnsList.length > 0 ? String(returnsList[0]?.status || '').toLowerCase() : '';
  const isExplicitlyClosed = returnStatus && ML_RETURN_CLOSED_STATUSES.includes(returnStatus);
  if (returnsList.length > 0 && !orderId && returnsList[0]?.resource_id) orderId = returnsList[0].resource_id;
  if (!orderId || isExplicitlyClosed) return { created: 0, skipped: 0 };

  let order = await ml.getOrder(accessToken, orderId);
  if (!order?.order_items?.length && tokens.mercadolibre?.user_id) {
    const { getOrdersSearch } = await import('../lib/mercadolibre.js');
    const searchRes = await getOrdersSearch(accessToken, { seller: tokens.mercadolibre.user_id, q: String(orderId), limit: 10 });
    const resultsList = searchRes?.results ?? [];
    const found = resultsList[0];
    if (found?.order_items?.length) order = found;
  }
  if (!order?.order_items?.length) return { created: 0, skipped: 0 };

  const displayOrderId = String(order.payments?.[0]?.order_id ?? order.id ?? orderId);

  let created = 0;
  let skipped = 0;
  for (const oi of order.order_items) {
    const itemId = oi?.item?.id;
    const variationId = oi?.item?.variation_id ?? oi?.variation_id ?? null;
    const quantity = oi?.quantity ?? 1;
    const productLabel = oi?.item?.title ?? null;
    if (!itemId) continue;

    const exists = await hasPendingReturnForClaimItem(claimId, itemId, variationId);
    if (exists) {
      skipped++;
      continue;
    }

    let sku = getSkuByMlItem(itemId, variationId);
    if (!sku) {
      const item = await ml.getItem(accessToken, itemId);
      if (item) sku = ml.extractSkuFromItem(item);
      if (!sku && item?.variations?.length && variationId) {
        const v = item.variations.find(vr => String(vr.id ?? vr.id_plain) === String(variationId));
        if (v?.seller_sku) sku = v.seller_sku;
      }
    }

    const row = await insertPendingReturn({
      claimId,
      orderId: displayOrderId,
      itemId,
      variationId: variationId ?? undefined,
      sku: sku || null,
      quantity,
      productLabel
    });
    if (row) created++;
  }
  return { created, skipped };
}

/** Traer devoluciones desde ML: reclamos tipo "return" (por type en API o en código). Incluimos todo lo que no esté explícitamente cerrado. */
syncRoutes.post('/returns/fetch', async (_, res) => {
  const accessToken = await getMlToken();
  if (!accessToken) return res.status(401).json({ error: 'No conectado a Mercado Libre' });
  if (!hasDatabase()) return res.status(503).json({ error: 'Base de datos no configurada (DATABASE_URL).' });

  if (returnsFetchCache.result && Date.now() - returnsFetchCache.at < RETURNS_FETCH_CACHE_TTL_MS) {
    return res.json({ ...returnsFetchCache.result, cached: true });
  }

  try {
    const userId = tokens.mercadolibre?.user_id;
    if (!userId) {
      return res.status(400).json({ error: 'Falta user_id de ML (reconectá Mercado Libre).' });
    }
    // ML: player_role+player_user_id obligatorios; type=return (devoluciones); status=opened para listar solo abiertas.
    let claims = [];
    let requestedWithTypeReturn = false;
    for (const useType of [true, false]) {
      let collected = [];
      for (let offset = 0; offset < 100; offset += 50) {
        const params = { limit: 50, offset, player_role: 'respondent', player_user_id: userId, status: 'opened' };
        if (useType) {
          params.type = 'return';
          requestedWithTypeReturn = true;
        }
        const searchRes = await ml.getClaimsSearch(accessToken, params);
        const page = searchRes?.data ?? searchRes?.results ?? [];
        if (page.length === 0) break;
        collected = collected.concat(page);
        if (page.length < 50) break;
      }
      if (collected.length > 0) {
        claims = collected;
        break;
      }
      requestedWithTypeReturn = false;
    }
    const returnClaims = claims.filter((c) => (c.type || '').toLowerCase() === 'return');
    const listToUse = requestedWithTypeReturn
      ? claims
      : (returnClaims.length > 0 ? returnClaims : claims.filter((c) => (c.type || '').toLowerCase() === 'return'));
    console.log('[returns/fetch] claims total=%s, con type=return en request=%s, procesando=%s', claims.length, requestedWithTypeReturn, listToUse.length);

    let created = 0;
    let skipped = 0;

    for (const claim of listToUse) {
      const out = await processClaimToPendingReturns(accessToken, claim);
      created += out.created;
      skipped += out.skipped;
    }

    const result = { ok: true, claimsChecked: claims.length, created, skipped };
    returnsFetchCache = { at: Date.now(), result };
    res.json(result);
  } catch (e) {
    console.error('returns/fetch:', e);
    res.status(500).json({ error: e.message || 'Error al traer devoluciones desde ML' });
  }
});

/** Normaliza el ID de orden: quita espacios y deja solo dígitos (por si pegaron con espacios o guiones). */
function normalizeOrderId(input) {
  const s = String(input || '').trim();
  const digits = s.replace(/\D/g, '');
  return digits || s;
}

/** Agregar devoluciones desde un pack de ML (pack_id = nro de venta).
 * Flujo: 1) GET /packs/:packId → { orders: [{ id: 2000015382437056 }, ...] }
 *        2) Por cada orders[].id → GET /orders/:orderId → { order_items: [...], pack_id, ... }
 *        3) Por cada order_item se inserta en sync_pending_returns (orderId = pack_id para mostrar como nro de venta).
 */
syncRoutes.post('/returns', async (req, res) => {
  const rawPackId = (req.body?.packId ?? req.body?.orderId ?? '').trim();
  const packId = normalizeOrderId(rawPackId);
  if (!packId) return res.status(400).json({ error: 'packId es requerido (nro de venta que ves en la app de ML).' });
  const accessToken = await getMlToken();
  if (!accessToken) return res.status(401).json({ error: 'No conectado a Mercado Libre' });
  if (!hasDatabase()) return res.status(503).json({ error: 'Base de datos no configurada (DATABASE_URL).' });

  try {
    const pack = await ml.getPack(accessToken, packId);
    if (!pack) {
      console.warn('[returns/add] getPack devolvió null para packId=%s', packId);
      return res.status(502).json({ error: 'No se pudo obtener el pack desde ML (revisá token y consola del servidor: [ML] getPack failed).' });
    }
    const ordersList = pack.orders ?? pack.data?.orders ?? (Array.isArray(pack.data) ? pack.data : []);
    if (!Array.isArray(ordersList) || ordersList.length === 0) {
      console.warn('[returns/add] pack sin órdenes, keys=%s', Object.keys(pack).join(','));
      return res.status(404).json({ error: 'Pack sin órdenes o estructura inesperada. Revisá la consola del servidor.' });
    }
    console.log('[returns/add] pack %s: %s órdenes', packId, ordersList.length);
    const created = [];
    for (const o of ordersList) {
      const orderId = o?.id ?? o;
      if (orderId == null) continue;
      const order = await ml.getOrder(accessToken, String(orderId));
      if (!order?.order_items?.length) continue;
      for (const oi of order.order_items) {
        const itemId = oi?.item?.id;
        const variationId = oi?.item?.variation_id ?? oi?.variation_id ?? null;
        const quantity = oi?.quantity ?? 1;
        const productLabel = oi?.item?.title ?? null;
        if (!itemId) continue;
        let sku = getSkuByMlItem(itemId, variationId);
        if (!sku) {
          const item = await ml.getItem(accessToken, itemId);
          if (item) sku = ml.extractSkuFromItem(item);
          if (!sku && item?.variations?.length && variationId) {
            const v = item.variations.find(vr => String(vr.id ?? vr.id_plain) === String(variationId));
            if (v?.seller_sku) sku = v.seller_sku;
          }
        }
        const row = await insertPendingReturn({
          orderId: String(packId),
          itemId,
          variationId: variationId ?? undefined,
          sku: sku || null,
          quantity,
          productLabel
        });
        if (row) created.push(row);
      }
    }
    if (ordersList.length > 0 && created.length === 0) {
      return res.status(502).json({ error: 'Se encontró el pack pero no se pudieron cargar ítems (GET order falló o no hay order_items). Revisá la consola del servidor [ML] getOrder failed.' });
    }
    res.status(201).json({ created: created.length, rows: created });
  } catch (e) {
    console.error('[returns/add]', e);
    res.status(500).json({ error: e.message || 'Error al cargar el pack' });
  }
});

/** Aprobar una devolución: restaura stock en ML y TN y marca como aprobada. */
syncRoutes.post('/returns/:id/approve', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'id inválido' });
  try {
    const result = await approvePendingReturn(id);
    if (!result.ok) {
      return res.status(400).json({ error: result.error || 'No se pudo aprobar', mlRestored: result.mlRestored, tnRestored: result.tnRestored });
    }
    res.json({ ok: true, mlRestored: result.mlRestored, tnRestored: result.tnRestored });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
