import { Router } from 'express';
import { tokens, getResolvedSkus, getMlToken, setMlTokenKnownInvalid } from '../store.js';
import * as ml from '../lib/mercadolibre.js';
import * as tn from '../lib/tiendanube.js';
import { getAnalysis } from '../services/conflictsService.js';
import { tryClaimOrderProcessing, hasOrderProcessingClaimed, releaseOrderProcessingClaim, hasDatabase } from '../db.js';
import {
  onMercadoLibreOrderPaid,
  onMercadoLibreOrderCancelled,
  onTiendaNubeOrderPaid,
  onTiendaNubeOrderCancelled
} from '../services/syncService.js';
import { processClaimToPendingReturns } from './sync.js';

export const webhookRoutes = Router();

/** Solo descontar ventas ML que se hayan pagado hace menos de esto (evita procesar órdenes viejas al activar sync o webhooks por entrega). */
const ORDER_PAID_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 horas

function orderPaidRecently(order) {
  const dateStr = order.date_closed || order.date_last_updated || order.date_created;
  if (!dateStr) return false;
  const t = new Date(dateStr).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() - t <= ORDER_PAID_MAX_AGE_MS;
}

/** Extrae el ID de un recurso ML (puede ser número o URL tipo .../claims/123 o .../orders/456). */
function parseMlResourceId(resource) {
  if (resource == null) return null;
  if (typeof resource === 'number' && !Number.isNaN(resource)) return String(resource);
  const s = String(resource).trim();
  if (!s) return null;
  const match = s.match(/\/(?:claims|orders)\/(\d+)$/i) || s.match(/^(\d+)$/);
  return match ? match[1] : null;
}

/** Mercado Libre envía POST con application_id, resource, topic, etc. */
webhookRoutes.post('/mercadolibre', async (req, res) => {
  const body = req.body || {};
  console.log('[Webhook ML] Notificación recibida, body:', JSON.stringify(body));
  res.status(200).send();
  const { topic, resource } = body;

  if (topic === 'claims' || topic === 'claims_actions') {
    const claimId = parseMlResourceId(resource);
    if (!claimId) return;
    const accessToken = await getMlToken();
    if (!accessToken) return;
    if (!hasDatabase()) return;
    try {
      const claim = await ml.getClaim(accessToken, claimId);
      if (!claim) return;
      const type = (claim.type || '').toLowerCase();
      if (type !== 'return') return;
      const out = await processClaimToPendingReturns(accessToken, claim);
      if (out.created > 0 || out.skipped > 0) {
        console.log('[Webhook ML] Devolución claim %s agregada a pendientes: created=%s, skipped=%s', claimId, out.created, out.skipped);
      }
    } catch (e) {
      console.error('[Webhook ML] claims:', e);
    }
    return;
  }

  if (topic !== 'orders' && topic !== 'orders_v2') return;
  const orderId = parseMlResourceId(resource);
  if (!orderId) {
    console.warn('[Webhook ML] orders: resource inválido o vacío', typeof resource, resource);
    return;
  }
  const accessToken = await getMlToken();
  if (!accessToken) {
    console.warn('[Webhook ML] Sin token válido (reconectá ML en Inicio). No se puede obtener la orden.');
    return;
  }
  try {
    let order = await ml.getOrder(accessToken, orderId);
    if (!order?.order_items?.length && tokens.mercadolibre?.user_id) {
      const userId = tokens.mercadolibre.user_id;
      let searchRes = await ml.getOrdersSearch(accessToken, { seller: userId, q: orderId, limit: 10 });
      let results = searchRes?.results ?? [];
      if (results.length === 0) {
        searchRes = await ml.getOrdersSearch(accessToken, { seller: userId, item: orderId, limit: 10 });
        results = searchRes?.results ?? [];
        if (results.length === 0 && /^\d+$/.test(orderId)) {
          searchRes = await ml.getOrdersSearch(accessToken, { seller: userId, item: `MLA${orderId}`, limit: 10 });
          results = searchRes?.results ?? [];
        }
      }
      const found = results[0];
      if (found?.order_items?.length) {
        order = found;
      } else if (found) {
        const internalId = found.id ?? found.orders?.[0]?.id;
        if (internalId != null) {
          const fullOrder = await ml.getOrder(accessToken, String(internalId));
          if (fullOrder?.order_items?.length) order = fullOrder;
        }
      }
    }
    if (!order) {
      console.warn('[Webhook ML] No se pudo obtener la orden %s (GET /orders devolvió 404 o sin resultados). Revisá que el resource del webhook sea el order id correcto.', orderId);
      return;
    }
    if (!order.order_items?.length) {
      console.warn('[Webhook ML] Orden %s sin order_items, se ignora.', order.id ?? orderId);
      return;
    }
    console.log('[Webhook ML] Orden obtenida de API, order_id=%s, status=%s, items=%s', order.id ?? orderId, order.status, (order.order_items || []).length);
    const items = order.order_items || [];
    const status = (order.status || '').toLowerCase();
    const statusDetail = (order.status_detail || '').toLowerCase();
    const effectiveOrderId = String(order.payments?.[0]?.order_id ?? order.id ?? orderId);

    if (status === 'cancelled' || status === 'canceled') {
      const claimed = await tryClaimOrderProcessing('mercadolibre', effectiveOrderId, 'restore');
      if (!claimed) {
        console.log('[Webhook ML] Orden %s ya se restauró stock (idempotencia), no se vuelve a restaurar.', effectiveOrderId);
        return;
      }
      await onMercadoLibreOrderCancelled(items, effectiveOrderId, order);
      return;
    }

    if (status === 'paid' || status === 'confirmed') {
      if (statusDetail && statusDetail.includes('cancel')) {
        console.log('[Webhook ML] Orden %s está en proceso de cancelación (status_detail), no se descuenta ni restaura hasta que ML confirme.', effectiveOrderId);
        return;
      }
      if (await hasOrderProcessingClaimed('mercadolibre', effectiveOrderId, 'restore')) {
        console.log('[Webhook ML] Orden %s ya fue cancelada/restaurada, no se descuenta.', effectiveOrderId);
        return;
      }
      if (!orderPaidRecently(order)) {
        console.log('[Webhook ML] Orden %s pagada hace más de 2 h (date_closed/date_created). Solo descontamos ventas recientes; se ignora.', effectiveOrderId);
        return;
      }
      const claimed = await tryClaimOrderProcessing('mercadolibre', effectiveOrderId, 'deduct');
      if (!claimed) {
        console.log('[Webhook ML] Orden %s ya procesada (idempotencia), no se vuelve a descontar.', effectiveOrderId);
        return;
      }
      const results = await onMercadoLibreOrderPaid(items, effectiveOrderId, order);
      if (results.length === 0) {
        await releaseOrderProcessingClaim('mercadolibre', effectiveOrderId, 'deduct');
        console.warn('[Webhook ML] Orden %s: no se descontó ningún ítem (sync desactivada o ítem sin SKU en Conflictos). Claim liberado para que puedas reintentar.', effectiveOrderId);
      }
    }
  } catch (e) {
    if (e?.message?.includes('401') || e?.response?.status === 401) setMlTokenKnownInvalid(true);
    console.error('Webhook ML:', e);
  }
});

/** Tienda Nube: verificación HMAC y evento order/paid, order/created, etc. */
webhookRoutes.post('/tiendanube', async (req, res) => {
  const body = req.body || {};
  console.log('[Webhook TN] Notificación recibida, body:', JSON.stringify(body));
  const hmacHeader = req.headers['x-linkedstore-hmac-sha256'];
  const secret = process.env.TN_CLIENT_SECRET?.trim?.() ?? process.env.TN_CLIENT_SECRET ?? '';
  if (secret && hmacHeader) {
    const crypto = await import('crypto');
    // TN doc usa PHP hash_hmac('sha256', $data, $secret) que devuelve HEX, no base64.
    const rawBody = req.rawBody;
    if (!rawBody) {
      console.warn('[Webhook TN] req.rawBody no está definido; el middleware de body raw puede no haber corrido para esta ruta.');
    }
    const bodyForHmac = rawBody ?? Buffer.from(JSON.stringify(req.body || {}), 'utf8');
    const expectedHex = crypto.createHmac('sha256', secret).update(bodyForHmac).digest('hex');
    const expectedBase64 = crypto.createHmac('sha256', secret).update(bodyForHmac).digest('base64');
    const hmac = String(hmacHeader).trim().toLowerCase();
    const match = (hmac === expectedHex.toLowerCase()) || (String(hmacHeader).trim() === expectedBase64);
    if (!match) {
      console.warn('[Webhook TN] HMAC inválido (revisá TN_CLIENT_SECRET o que req.rawBody llegue). Rechazado con 401.');
      return res.status(401).send('Invalid signature');
    }
  } else if (secret && !hmacHeader) {
    console.warn('[Webhook TN] TN_CLIENT_SECRET está definido pero no vino header x-linkedstore-hmac-sha256.');
  }
  res.status(200).send();
  const { event, id } = body;
  console.log('[Webhook TN] event=%s, orderId=%s', event, id);
  if (id == null) {
    if (event != null) console.log('[Webhook TN] Evento sin id, se ignora.');
    return;
  }
  if (!['order/paid', 'order/cancelled'].includes(event)) {
    return;
  }
  if (!tokens.tiendanube?.access_token) {
    console.warn('[Webhook TN] No hay token de TN, no se puede procesar.');
    return;
  }
  try {
    if (getResolvedSkus().length === 0) {
      console.log('[Webhook TN] Mapeo SKU vacío, cargando análisis para poblar mapeo…');
      await getAnalysis();
    }
    const order = await tn.getOrder(tokens.tiendanube.access_token, tokens.tiendanube.store_id, id);
    if (!order) return;
    console.log('[Webhook TN] Orden obtenida de API, order.id=%s, number=%s, products=%s', order.id, order.number, (order.products || []).length);
    const products = order.products || [];
    // order.number = número secuencial que ve el dueño/cliente (ej. 306); order.id = id interno.
    const orderNumber = String(order.number ?? order.id ?? id);
    if (event === 'order/cancelled') {
      const claimed = await tryClaimOrderProcessing('tiendanube', String(id), 'restore');
      if (!claimed) {
        console.log('[Webhook TN] Orden %s ya se restauró stock (idempotencia), no se vuelve a restaurar.', id);
        return;
      }
      await onTiendaNubeOrderCancelled(products, orderNumber, order);
    } else {
      const claimed = await tryClaimOrderProcessing('tiendanube', String(id), 'deduct');
      if (!claimed) {
        console.log('[Webhook TN] Orden %s ya procesada (idempotencia), no se vuelve a descontar.', id);
        return;
      }
      await onTiendaNubeOrderPaid(products, orderNumber, order);
    }
  } catch (e) {
    console.error('Webhook TN:', e);
  }
});
