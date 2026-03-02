import { Router } from 'express';
import { tokens, getResolvedSkus, getMlToken, setMlTokenKnownInvalid } from '../store.js';
import * as ml from '../lib/mercadolibre.js';
import * as tn from '../lib/tiendanube.js';
import { getAnalysis } from '../services/conflictsService.js';
import { tryClaimOrderProcessing, hasOrderProcessingClaimed } from '../db.js';
import {
  onMercadoLibreOrderPaid,
  onMercadoLibreOrderCancelled,
  onTiendaNubeOrderPaid,
  onTiendaNubeOrderCancelled
} from '../services/syncService.js';

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

/** Mercado Libre envía POST con application_id, resource, topic, etc. */
webhookRoutes.post('/mercadolibre', async (req, res) => {
  res.status(200).send();
  const { topic, resource } = req.body || {};
  if (topic !== 'orders' && topic !== 'orders_v2') return;
  const orderId = typeof resource === 'string'
    ? resource.replace(/https:\/\/api\.mercadolibre\.com\/orders\/?/i, '').replace(/^\/orders\/?/, '').trim() || null
    : null;
  if (!orderId) return;
  const accessToken = await getMlToken();
  if (!accessToken) {
    console.warn('[Webhook ML] Sin token válido (reconectá ML en Inicio). No se puede obtener la orden.');
    return;
  }
  try {
    const order = await ml.getOrder(accessToken, orderId);
    if (!order) return;
    const items = order.order_items || [];
    const status = (order.status || '').toLowerCase();
    const statusDetail = (order.status_detail || '').toLowerCase();

    if (status === 'cancelled' || status === 'canceled') {
      const claimed = await tryClaimOrderProcessing('mercadolibre', orderId, 'restore');
      if (!claimed) {
        console.log('[Webhook ML] Orden %s ya se restauró stock (idempotencia), no se vuelve a restaurar.', orderId);
        return;
      }
      await onMercadoLibreOrderCancelled(items, orderId);
      return;
    }

    if (status === 'paid' || status === 'confirmed') {
      if (statusDetail && statusDetail.includes('cancel')) {
        console.log('[Webhook ML] Orden %s está en proceso de cancelación (status_detail), no se descuenta ni restaura hasta que ML confirme.', orderId);
        return;
      }
      if (await hasOrderProcessingClaimed('mercadolibre', orderId, 'restore')) {
        console.log('[Webhook ML] Orden %s ya fue cancelada/restaurada, no se descuenta.', orderId);
        return;
      }
      if (!orderPaidRecently(order)) {
        console.log('[Webhook ML] Orden %s pagada hace más de 2 h (date_closed/date_created). Solo descontamos ventas recientes; se ignora.', orderId);
        return;
      }
      const claimed = await tryClaimOrderProcessing('mercadolibre', orderId, 'deduct');
      if (!claimed) {
        console.log('[Webhook ML] Orden %s ya procesada (idempotencia), no se vuelve a descontar.', orderId);
        return;
      }
      await onMercadoLibreOrderPaid(items, orderId);
    }
  } catch (e) {
    if (e?.message?.includes('401') || e?.response?.status === 401) setMlTokenKnownInvalid(true);
    console.error('Webhook ML:', e);
  }
});

/** Tienda Nube: verificación HMAC y evento order/paid, order/created, etc. */
webhookRoutes.post('/tiendanube', async (req, res) => {
  console.log('[Webhook TN] POST recibido, body keys:', req.body ? Object.keys(req.body) : []);
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
  const { event, id } = req.body || {};
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
    const products = order.products || [];
    // order.number = número secuencial que ve el dueño/cliente (ej. 306); order.id = id interno.
    const orderNumber = String(order.number ?? order.id ?? id);
    if (event === 'order/cancelled') {
      const claimed = await tryClaimOrderProcessing('tiendanube', String(id), 'restore');
      if (!claimed) {
        console.log('[Webhook TN] Orden %s ya se restauró stock (idempotencia), no se vuelve a restaurar.', id);
        return;
      }
      await onTiendaNubeOrderCancelled(products, orderNumber);
    } else {
      const claimed = await tryClaimOrderProcessing('tiendanube', String(id), 'deduct');
      if (!claimed) {
        console.log('[Webhook TN] Orden %s ya procesada (idempotencia), no se vuelve a descontar.', id);
        return;
      }
      await onTiendaNubeOrderPaid(products, orderNumber);
    }
  } catch (e) {
    console.error('Webhook TN:', e);
  }
});
