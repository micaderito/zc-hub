import { Router } from 'express';
import { tokens, getResolvedSkus, getMlToken, setMlTokenKnownInvalid } from '../store.js';
import * as ml from '../lib/mercadolibre.js';
import * as tn from '../lib/tiendanube.js';
import { getAnalysis, refreshMlItemInSnapshot, refreshTnProductInSnapshot } from '../services/conflictsService.js';
import { tryClaimOrderProcessing, hasOrderProcessingClaimed, releaseOrderProcessingClaim, hasDatabase, hasPendingReturnForOrder } from '../db.js';
import {
  onMercadoLibreOrderPaid,
  onMercadoLibreOrderCancelled,
  onTiendaNubeOrderPaid,
  onTiendaNubeOrderCancelled
} from '../services/syncService.js';
import { processClaimToPendingReturns, insertPendingReturnsForOrder } from './sync.js';
import { isSafeToAutoRestore, getShipmentIdFromOrder } from '../lib/mlShipmentState.js';

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

/** addedAt opcional: al reencolar tras un 429 hay que conservar la fecha original para que
 * PENDING_ORDER_MAX_AGE_MS realmente expire la orden en vez de resetearse en cada reintento. */
function enqueuePendingMlOrder(orderId, addedAt = Date.now(), attempts = 0) {
  if (!orderId || pendingMlOrderIds.some((e) => e.orderId === orderId)) return;
  if (pendingMlOrderIds.length >= PENDING_ORDER_MAX) {
    pendingMlOrderIds.shift();
  }
  pendingMlOrderIds.push({ orderId, addedAt, attempts });
}

function isOrderIdPending(orderId) {
  return !!orderId && pendingMlOrderIds.some((e) => e.orderId === orderId);
}

/**
 * Envíos ya consultados. Todas las órdenes de un pack comparten el mismo envío, así que cachear
 * evita N requests cuando ML cancela un carrito entero de golpe (el caso que disparó este fix
 * fueron 11 órdenes de un mismo pack, y la API ya venía con 429 sostenidos).
 */
const shipmentCache = new Map();
const SHIPMENT_CACHE_TTL_MS = 10 * 60 * 1000;
const SHIPMENT_CACHE_MAX = 200;

/** Solo para tests: limpia el caché de envíos y la cola de reintentos entre casos. */
export function __resetShipmentCacheForTests() {
  shipmentCache.clear();
  pendingMlOrderIds.length = 0;
}

/**
 * Decide si una orden cancelada puede restaurar stock automáticamente, mirando el envío.
 *
 * `transient: true` significa "no pudimos preguntarle a ML" (429, sin token), no "la mercadería
 * salió". Una cancelación previa al despacho tiene que restaurar sola, así que ese caso se
 * reintenta más tarde en vez de mandarla a pendientes por un rate limit pasajero.
 */
async function evaluateCancelledOrderShipment(accessToken, order) {
  const shipmentId = getShipmentIdFromOrder(order);
  // Sin envío no hay despacho que rastrear (venta a acordar con el comprador, retiro en persona):
  // no hay paquete en viaje, así que la cancelación restaura sola.
  if (!shipmentId) return { safe: true, transient: false, reason: 'la orden no tiene envío asociado' };
  if (!accessToken) return { safe: false, transient: true, reason: 'sin token de ML para consultar el envío' };

  const cached = shipmentCache.get(shipmentId);
  if (cached && Date.now() - cached.at < SHIPMENT_CACHE_TTL_MS) {
    return { ...isSafeToAutoRestore(cached.shipment), transient: false };
  }

  let shipment = null;
  try {
    shipment = await ml.getShipment(accessToken, shipmentId);
  } catch (e) {
    // getShipment solo lanza por 429: el caño está saturado, no es información sobre el envío.
    console.warn('[Webhook ML] No se pudo obtener el envío %s: %s', shipmentId, e?.message);
    return { safe: false, transient: true, reason: 'ML respondió 429 al consultar el envío' };
  }
  if (!shipment) return { safe: false, transient: false, reason: 'no se pudo consultar el envío' };

  if (shipmentCache.size >= SHIPMENT_CACHE_MAX) shipmentCache.clear();
  shipmentCache.set(shipmentId, { at: Date.now(), shipment });
  return { ...isSafeToAutoRestore(shipment), transient: false };
}

/**
 * Cuántas veces reintentar la consulta del envío antes de resignarse y dejar la devolución
 * pendiente. Con el worker corriendo cada minuto, son ~3 minutos de margen para que ML se
 * recupere de una tanda de 429.
 */
const SHIPMENT_LOOKUP_MAX_ATTEMPTS = 3;

/**
 * Procesa una orden ya obtenida: cancel → restaurar, paid → descontar. Sin responder HTTP.
 * `attempt` es el nº de reintento cuando la orden vuelve por la cola de pendientes.
 */
async function processMlOrderPayload(order, orderId, attempt = 0) {
  const items = order.order_items || [];
  const status = (order.status || '').toLowerCase();
  const statusDetail = (order.status_detail || '').toLowerCase();
  const effectiveOrderId = String(order.id ?? orderId);

  if (status === 'cancelled' || status === 'canceled') {
    // Orden cancelada antes de llegar a pagarse (rechazo de pago, timeout, antifraude de ML): nunca se
    // descontó stock, así que no hay nada que restaurar. Evita inflar stock en TN con órdenes fantasma.
    const wasDeducted = await hasOrderProcessingClaimed('mercadolibre', effectiveOrderId, 'deduct');
    if (!wasDeducted) {
      console.log('[Webhook ML] Orden %s cancelada pero nunca se descontó stock, no se restaura.', effectiveOrderId);
      return;
    }
    // Verificar si hay una devolución pendiente en DB (caso normal: claims webhook llegó primero).
    // Se chequea también por pack porque el alta manual guarda el pack como nro de venta.
    const packId = order.pack_id != null ? String(order.pack_id) : null;
    for (const id of new Set([effectiveOrderId, packId].filter(Boolean))) {
      if (await hasPendingReturnForOrder(id)) {
        console.log('[Webhook ML] Orden %s cancelada por devolución (pending return en DB). Se omite restauración automática de stock.', effectiveOrderId);
        return;
      }
    }
    // Ya se aprobó manualmente una devolución de esta orden: el stock volvió por ese camino.
    // Si ML reenvía la notificación, ni restaurar de nuevo ni recrear la devolución pendiente.
    for (const id of new Set([effectiveOrderId, packId].filter(Boolean))) {
      if (await hasOrderProcessingClaimed('mercadolibre', id, 'return_restore')) {
        console.log('[Webhook ML] Orden %s ya tiene una devolución aprobada manualmente. No se toca el stock.', effectiveOrderId);
        return;
      }
    }
    const accessToken = await getMlToken();
    // Edge case: orders webhook llegó antes que claims. Consultar ML para detectar return claims activos.
    try {
      if (accessToken) {
        const claimsRes = await ml.getClaimsSearch(accessToken, { resource: 'order', resource_id: effectiveOrderId, type: 'return' });
        const activeClaims = (claimsRes?.data ?? []).filter(c => {
          const s = (c.status || '').toLowerCase();
          return s !== 'closed' && s !== 'expired' && s !== 'cancelled' && s !== 'canceled';
        });
        if (activeClaims.length > 0) {
          console.log('[Webhook ML] Orden %s tiene return claim activo en ML (claim %s). Se omite restauración automática de stock.', effectiveOrderId, activeClaims[0].id);
          // Procesar el claim para que quede en pendientes si aún no está
          for (const c of activeClaims) {
            try {
              const claim = await ml.getClaim(accessToken, String(c.id));
              if (claim) await processClaimToPendingReturns(accessToken, claim);
            } catch (_) {}
          }
          return;
        }
      }
    } catch (e) {
      console.warn('[Webhook ML] Error consultando claims para orden %s:', effectiveOrderId, e?.message);
    }
    // Una entrega fallida NO abre ningún claim en ML: la orden se cancela y el paquete vuelve al
    // vendedor. Los chequeos de arriba no la detectan, así que miramos el envío: si la mercadería
    // llegó a salir, todavía no la tenemos → devolución pendiente de confirmar, sin tocar stock.
    const decision = await evaluateCancelledOrderShipment(accessToken, order);
    // No pudimos consultar el envío por un 429: reintentar. Si diéramos por perdida la consulta acá,
    // una cancelación previa al despacho —que tiene que restaurar sola— terminaría en pendientes
    // solo porque ML estaba saturado en ese momento.
    if (!decision.safe && decision.transient && attempt < SHIPMENT_LOOKUP_MAX_ATTEMPTS) {
      enqueuePendingMlOrder(effectiveOrderId, Date.now(), attempt + 1);
      console.log(
        '[Webhook ML] Orden %s cancelada: %s. Reintento %s/%s en 1 min, sin tocar stock todavía.',
        effectiveOrderId, decision.reason, attempt + 1, SHIPMENT_LOOKUP_MAX_ATTEMPTS
      );
      return;
    }
    if (!decision.safe) {
      const out = await insertPendingReturnsForOrder(accessToken, order, {
        displayOrderId: packId ?? effectiveOrderId,
        reason: `Cancelada en ML — ${decision.reason}`
      });
      console.log(
        '[Webhook ML] Orden %s cancelada con mercadería despachada (%s). NO se restaura stock; devolución pendiente de confirmar (created=%s, skipped=%s).',
        effectiveOrderId, decision.reason, out.created, out.skipped
      );
      return;
    }
    console.log('[Webhook ML] Orden %s cancelada antes del despacho (%s). Restauración automática habilitada.', effectiveOrderId, decision.reason);
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

/** Un tick del worker. Exportado para los tests: dispara el reintento sin esperar el minuto. */
export async function processNextPendingMlOrder() {
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
      await processMlOrderPayload(order, entry.orderId, entry.attempts ?? 0);
    }
  } catch (e) {
    if (e?.statusCode === 429) {
      enqueuePendingMlOrder(entry.orderId, entry.addedAt, entry.attempts ?? 0);
    }
  }
}

let pendingMlOrderInterval = setInterval(processNextPendingMlOrder, ML_PENDING_INTERVAL_MS);
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

  // Topic `items`: ML avisa que cambió una publicación (precio/stock/estado). Actualizamos SOLO
  // ese ítem en el snapshot (1 request), en vez de re-bajar el catálogo. Recomendación oficial de ML.
  if (topic === 'items') {
    res.status(200).send();
    const m = String(resource || '').match(/\/items\/([A-Za-z0-9]+)/i);
    const itemId = m ? m[1] : (parseMlResourceId(resource) || null);
    if (!itemId) return;
    const accessToken = await getMlToken();
    if (!accessToken) return;
    try {
      await refreshMlItemInSnapshot(accessToken, itemId);
      console.log('[Webhook ML] items: snapshot actualizado para %s', itemId);
    } catch (e) {
      console.error('[Webhook ML] items:', e.message);
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
  // Ack inmediato (como claims/items): si esperáramos a getOrder acá, un 429 puede tardar
  // hasta ~40s en resolverse y ML reentrega la notificación por timeout, amplificando el 429.
  res.status(200).send();
  const accessToken = await getMlToken();
  if (!accessToken) {
    console.warn('[Webhook ML] Sin token válido (reconectá ML en Inicio). No se puede obtener la orden.');
    return;
  }
  if (isOrderIdPending(orderId)) return;
  if (inFlightOrderIds.has(orderId)) return;
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
      return;
    }
    console.log('[Webhook ML] Orden obtenida, order_id=%s, status=%s, items=%s', order.id ?? orderId, order.status, (order.order_items || []).length);
    await processMlOrderPayload(order, orderId);
  } catch (e) {
    if (e?.statusCode === 429) {
      enqueuePendingMlOrder(orderId);
      console.warn('[Webhook ML] 429 al obtener orden %s. Encolado para procesar en 1 min.', orderId);
    } else {
      if (e?.message?.includes('401') || e?.response?.status === 401) setMlTokenKnownInvalid(true);
      console.error('Webhook ML:', e);
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
  if (!tokens.tiendanube?.access_token) {
    console.warn('[Webhook TN] No hay token de TN, no se puede procesar.');
    return;
  }
  // Topic product/*: TN avisa que se creó/editó/borró un producto (id = productId). Refrescamos
  // SOLO ese producto en el snapshot (1 request), en vez de re-bajar el catálogo. Análogo al
  // topic `items` de ML.
  if (['product/created', 'product/updated', 'product/deleted'].includes(event)) {
    try {
      await refreshTnProductInSnapshot(tokens.tiendanube.access_token, tokens.tiendanube.store_id, id);
      console.log('[Webhook TN] %s: snapshot actualizado para producto %s', event, id);
    } catch (e) {
      console.error('[Webhook TN] product:', e.message);
    }
    return;
  }
  if (!['order/created', 'order/paid', 'order/cancelled'].includes(event)) {
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
      const wasDeducted = await hasOrderProcessingClaimed('tiendanube', String(id), 'deduct');
      if (!wasDeducted) {
        console.log('[Webhook TN] Orden %s cancelada pero nunca se descontó stock en ML, no se restaura.', id);
        return;
      }
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
