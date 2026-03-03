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

/** Cola de órdenes ML que no se pudieron obtener por 429; se procesan en background sin devolver 503 (evita loop). */
const pendingMlOrderIds = [];
const PENDING_ORDER_MAX = 50;
const PENDING_ORDER_MAX_AGE_MS = 30 * 60 * 1000; // 30 min
/** Misma orden siendo obtenida por otro request: no duplicar getOrder (evita 429). No usamos "recently processed" para no perder cancelaciones. */
const inFlightOrderIds = new Set();

function enqueuePendingMlOrder(orderId) {
  if (!orderId || pendingMlOrderIds.some((e) => e.orderId === orderId)) return;
  if (pendingMlOrderIds.length >= PENDING_ORDER_MAX) {
    pendingMlOrderIds.shift();
  }
  pendingMlOrderIds.push({ orderId, addedAt: Date.now() });
}

function isOrderIdPending(orderId) {
  return !!orderId && pendingMlOrderIds.some((e) => e.orderId === orderId);
}

/** Procesa una orden ya obtenida: cancel → restaurar, paid → descontar. Sin responder HTTP. */
async function processMlOrderPayload(order, orderId) {
  const items = order.order_items || [];
  const status = (order.status || '').toLowerCase();
  const statusDetail = (order.status_detail || '').toLowerCase();
  const effectiveOrderId = String(order.id ?? orderId);

  if (status === 'cancelled' || status === 'canceled') {
    const claimed = await tryClaimOrderProcessing('mercadolibre', effectiveOrderId, 'restore');
    if (!claimed) {
      console.log('[Webhook ML] Orden %s ya se restauró stock (idempotencia).', effectiveOrderId);
      return;
    }
    await onMercadoLibreOrderCancelled(items, effectiveOrderId, order);
    console.log('[Webhook ML] Orden %s cancelación registrada y stock restaurado.', effectiveOrderId);
    return;
  }

  if (status === 'paid' || status === 'confirmed') {
    if (statusDetail && statusDetail.includes('cancel')) return;
    if (await hasOrderProcessingClaimed('mercadolibre', effectiveOrderId, 'restore')) return;
    if (!orderPaidRecently(order)) return;
    const claimed = await tryClaimOrderProcessing('mercadolibre', effectiveOrderId, 'deduct');
    if (!claimed) return;
    const results = await onMercadoLibreOrderPaid(items, effectiveOrderId, order);
    if (results.length === 0) {
      await releaseOrderProcessingClaim('mercadolibre', effectiveOrderId, 'deduct');
    }
  }
}

/** Worker: cada 60s intenta obtener y procesar una orden pendiente (evita 429 en loop). */
const ML_PENDING_INTERVAL_MS = 60 * 1000;
let pendingMlOrderInterval = setInterval(async () => {
  if (pendingMlOrderIds.length === 0) return;
  const now = Date.now();
  const entry = pendingMlOrderIds.shift();
  if (now - entry.addedAt > PENDING_ORDER_MAX_AGE_MS) {
    console.log('[Webhook ML] Orden pendiente %s descartada por antigüedad.', entry.orderId);
    return;
  }
  const accessToken = await getMlToken();
  if (!accessToken) return;
  try {
    let order = await ml.getOrder(accessToken, entry.orderId);
    if (!order?.order_items?.length && tokens.mercadolibre?.user_id) {
      try {
        const searchRes = await ml.getOrdersSearch(accessToken, { seller: tokens.mercadolibre.user_id, q: entry.orderId, limit: 10 });
        const results = searchRes?.results ?? [];
        const found = results[0];
        if (found?.order_items?.length) order = found;
        else if (found?.id) order = await ml.getOrder(accessToken, String(found.id));
      } catch (_) {}
    }
    if (order?.order_items?.length) {
      console.log('[Webhook ML] Orden pendiente %s obtenida, status=%s. Procesando.', order.id ?? entry.orderId, order.status);
      await processMlOrderPayload(order, entry.orderId);
    }
  } catch (e) {
    if (e?.statusCode === 429) {
      enqueuePendingMlOrder(entry.orderId);
    }
  }
}, ML_PENDING_INTERVAL_MS);
pendingMlOrderInterval.unref?.();

/** Mercado Libre envía POST con application_id, resource, topic, etc. */
webhookRoutes.post('/mercadolibre', async (req, res) => {
  const body = req.body || {};
  console.log('[Webhook ML] Notificación recibida, body:', JSON.stringify(body));
  const { topic, resource } = body;

  if (topic === 'claims' || topic === 'claims_actions') {
    res.status(200).send();
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

  if (topic !== 'orders' && topic !== 'orders_v2') {
    res.status(200).send();
    return;
  }
  const orderId = parseMlResourceId(resource);
  if (!orderId) {
    console.warn('[Webhook ML] orders: resource inválido o vacío', typeof resource, resource);
    res.status(200).send();
    return;
  }
  const accessToken = await getMlToken();
  if (!accessToken) {
    console.warn('[Webhook ML] Sin token válido (reconectá ML en Inicio). No se puede obtener la orden.');
    res.status(200).send();
    return;
  }
  if (isOrderIdPending(orderId)) {
    res.status(200).send();
    return;
  }
  if (inFlightOrderIds.has(orderId)) {
    res.status(200).send();
    return;
  }
  inFlightOrderIds.add(orderId);
  try {
    let order = await ml.getOrder(accessToken, orderId);
    if (!order?.order_items?.length && tokens.mercadolibre?.user_id) {
      const searchRes = await ml.getOrdersSearch(accessToken, { seller: tokens.mercadolibre.user_id, q: orderId, limit: 10 });
      const results = searchRes?.results ?? [];
      const found = results[0];
      if (found?.order_items?.length) {
        order = found;
      } else if (found?.id) {
        order = await ml.getOrder(accessToken, String(found.id));
      }
    }
    if (!order?.order_items?.length) {
      console.warn('[Webhook ML] No se pudo obtener la orden %s', orderId);
      res.status(200).send();
      return;
    }
    console.log('[Webhook ML] Orden obtenida, order_id=%s, status=%s, items=%s', order.id ?? orderId, order.status, (order.order_items || []).length);
    await processMlOrderPayload(order, orderId);
    res.status(200).send();
  } catch (e) {
    if (e?.statusCode === 429) {
      enqueuePendingMlOrder(orderId);
      console.warn('[Webhook ML] 429 al obtener orden %s. Respondiendo 200 (sin loop) y encolando para procesar en 1 min.', orderId);
      res.status(200).send();
    } else {
      if (e?.message?.includes('401') || e?.response?.status === 401) setMlTokenKnownInvalid(true);
      console.error('Webhook ML:', e);
      res.status(200).send();
    }
  } finally {
    inFlightOrderIds.delete(orderId);
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
