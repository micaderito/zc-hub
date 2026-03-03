import { Router } from 'express';
import { syncPricesForSku, approvePendingReturn, revertSyncAudit } from '../services/syncService.js';
import { getResolvedSkus, getSkuByMlItem, getMlToken, tokens } from '../store.js';
import * as ml from '../lib/mercadolibre.js';
import * as tn from '../lib/tiendanube.js';
import { getSyncEnabled, setSyncEnabled, getAuditLog, getAuditRowById, setAuditReverted, hasDatabase, getPendingReturns, insertPendingReturn, hasPendingReturnForClaimItem } from '../db.js';

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

/** Traer devoluciones desde ML: reclamos tipo "return" (por type en API o en código). Incluimos todo lo que no esté explícitamente cerrado. */
syncRoutes.post('/returns/fetch', async (_, res) => {
  const accessToken = await getMlToken();
  if (!accessToken) return res.status(401).json({ error: 'No conectado a Mercado Libre' });
  if (!hasDatabase()) return res.status(503).json({ error: 'Base de datos no configurada (DATABASE_URL).' });

  if (returnsFetchCache.result && Date.now() - returnsFetchCache.at < RETURNS_FETCH_CACHE_TTL_MS) {
    return res.json({ ...returnsFetchCache.result, cached: true });
  }

  try {
    // Buscar con type=return; si no viene nada, repetir sin type y filtrar en código. Paginamos para no perder devoluciones atrás.
    let claims = [];
    for (const useType of [true, false]) {
      let collected = [];
      for (let offset = 0; offset < 100; offset += 50) {
        const params = { limit: 50, offset, resource: 'order' };
        if (useType) params.type = 'return';
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
    }
    const returnClaims = claims.filter((c) => (c.type || '').toLowerCase() === 'return');
    const listToUse = returnClaims.length > 0 ? returnClaims : claims.filter((c) => (c.type || '').toLowerCase() === 'return');
    console.log('[returns/fetch] claims total=%s, type=return=%s, procesando=%s', claims.length, returnClaims.length, listToUse.length);

    let created = 0;
    let skipped = 0;

    for (const claim of listToUse) {
      const claimId = claim.id;
      let orderId = claim.resource_id;
      if (!claimId) continue;

      const returnsData = await ml.getClaimReturns(accessToken, claimId);
      const singleReturn = returnsData && typeof returnsData === 'object' && !Array.isArray(returnsData) && (returnsData.id != null || returnsData.claim_id != null || returnsData.status != null);
      const returnsList = Array.isArray(returnsData) ? returnsData : singleReturn ? [returnsData] : [];
      const returnStatus = returnsList.length > 0 ? String(returnsList[0]?.status || '').toLowerCase() : '';
      const isExplicitlyClosed = returnStatus && ML_RETURN_CLOSED_STATUSES.includes(returnStatus);
      if (returnsList.length > 0 && !orderId && returnsList[0]?.resource_id) orderId = returnsList[0].resource_id;
      if (!orderId) continue;
      if (isExplicitlyClosed) continue;

      const order = await ml.getOrder(accessToken, orderId);
      if (!order?.order_items?.length) continue;

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
          orderId,
          itemId,
          variationId: variationId ?? undefined,
          sku: sku || null,
          quantity,
          productLabel
        });
        if (row) created++;
      }
    }

    const result = { ok: true, claimsChecked: claims.length, created, skipped };
    returnsFetchCache = { at: Date.now(), result };
    res.json(result);
  } catch (e) {
    console.error('returns/fetch:', e);
    res.status(500).json({ error: e.message || 'Error al traer devoluciones desde ML' });
  }
});

/** Agregar devoluciones desde una orden de ML: trae los ítems de la orden y los deja pendientes. */
syncRoutes.post('/returns', async (req, res) => {
  const orderId = (req.body?.orderId || '').trim();
  if (!orderId) return res.status(400).json({ error: 'orderId es requerido' });
  const accessToken = await getMlToken();
  if (!accessToken) return res.status(401).json({ error: 'No conectado a Mercado Libre' });
  if (!hasDatabase()) return res.status(503).json({ error: 'Base de datos no configurada (DATABASE_URL).' });

  try {
    const order = await ml.getOrder(accessToken, orderId);
    if (!order) return res.status(404).json({ error: 'Orden no encontrada en Mercado Libre' });
    const items = order.order_items || [];
    if (items.length === 0) return res.status(400).json({ error: 'La orden no tiene ítems' });

    const created = [];
    for (const oi of items) {
      const itemId = oi?.item?.id;
      const variationId = oi?.item?.variation_id ?? oi?.variation_id ?? null;
      const quantity = oi?.quantity ?? 1;
      const productLabel = oi?.item?.title ?? null;
      if (!itemId) continue;

      let sku = getSkuByMlItem(itemId, variationId);
      if (!sku && accessToken) {
        const item = await ml.getItem(accessToken, itemId);
        if (item) sku = ml.extractSkuFromItem(item);
        if (!sku && item?.variations?.length && variationId) {
          const v = item.variations.find(vr => String(vr.id ?? vr.id_plain) === String(variationId));
          if (v?.seller_sku) sku = v.seller_sku;
        }
      }

      const row = await insertPendingReturn({
        orderId,
        itemId,
        variationId: variationId ?? undefined,
        sku: sku || null,
        quantity,
        productLabel
      });
      if (row) created.push(row);
    }
    res.status(201).json({ created: created.length, rows: created });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Error al cargar la orden' });
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
