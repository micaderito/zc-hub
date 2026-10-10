/**
 * "Para despachar": paquetes de ML y TN que todavía no salieron, con su horario límite.
 *
 * Se lee en vivo de las APIs (no de webhooks ni de una tabla local): son pocos pedidos por día y
 * lo que importa es el estado de AHORA. ML no tiene un "envíos pendientes del vendedor" ni deja
 * filtrar `/orders/search` por estado del envío, así que se buscan las órdenes recientes y se
 * consulta el envío de cada una (`GET /shipments/:id`) + su límite (`GET /shipments/:id/sla`).
 * TN sí filtra por `shipping_status` en `GET /orders`.
 *
 * Para no castigar a ML en cada visita: caché de 60 s del resultado crudo, y los envíos que ya
 * salieron se memorizan (un envío despachado no vuelve atrás). Las marcas del hub (preparado,
 * "Entendido" de un cancelado) se mergean en cada request, así un tilde se ve al instante aunque
 * el resto venga de la caché.
 */

import * as ml from '../lib/mercadolibre.js';
import * as tn from '../lib/tiendanube.js';
import { tokens, getMlToken } from '../store.js';
import { getShipmentIdFromOrder, isSafeToAutoRestore } from '../lib/mlShipmentState.js';
import * as db from '../db.js';

const MS_HOUR = 60 * 60 * 1000;
const MS_DAY = 24 * MS_HOUR;
const AR_TZ = 'America/Argentina/Buenos_Aires';

/** Cuántos días para atrás se buscan órdenes de ML. Un pendiente más viejo que esto ya es un problema aparte. */
export const ML_LOOKBACK_DAYS = 15;
/** Ventana en la que una cancelación todavía se avisa ("no despachar"). */
export const CANCELLED_WINDOW_HOURS = 48;
const CACHE_TTL_MS = 60_000;

// ─────────────────────────── funciones puras (sin red ni base) ───────────────────────────

/** Estados del envío de ML en los que todavía hay que armar/llevar el paquete. */
const ML_PENDING_STATUSES = new Set(['handling', 'ready_to_ship']);
/** Estados en los que el envío ya no va a volver a "pendiente": se pueden memorizar. */
const ML_FINAL_STATUSES = new Set(['shipped', 'delivered', 'not_delivered', 'cancelled', 'canceled']);

/** Tipo de logística, en el formato nuevo (`logistic.type`) o el legacy (`logistic_type`). */
export function logisticTypeOf(shipment) {
  return shipment?.logistic?.type ?? shipment?.logistic_type ?? null;
}

/**
 * Substatus de `ready_to_ship` que significan "la vendedora ya lo entregó": con drop_off el envío
 * sigue `ready_to_ship` mientras el paquete está en el punto, hasta que el correo lo levanta y pasa a
 * `shipped`. ML ya lo muestra como "En camino · Despachaste el paquete".
 */
const ML_HANDED_OVER_SUBSTATUSES = new Set(['dropped_off', 'in_hub', 'picked_up']);
/**
 * Con drop_off, cuando el punto escanea el paquete ML lo pasa a `in_packing_list` ("Despachaste el
 * paquete" en el panel). Confirmado con los logs de la cuenta (2026-10-10). En Colecta
 * (`cross_docking`) en cambio significa "entró en la lista de retiro": ahí todavía no salió.
 */
const ML_DROP_OFF_TYPES = new Set(['drop_off', 'xd_drop_off']);

function isHandedOverSubstatus(substatus, logisticType) {
  const sub = String(substatus ?? '').toLowerCase();
  if (ML_HANDED_OVER_SUBSTATUSES.has(sub)) return true;
  return sub === 'in_packing_list' && ML_DROP_OFF_TYPES.has(String(logisticType ?? '').toLowerCase());
}

/**
 * ¿La vendedora ya entregó el paquete, y cuándo? `dispatchedAt` sale del historial de substatus (la
 * entrega en el punto) y si no, de `date_shipped`; null si ML no trae ninguno de los dos.
 */
export function mlDispatchInfo(shipment) {
  const status = String(shipment?.status ?? '').toLowerCase();
  const logistic = logisticTypeOf(shipment);
  const dispatched = status === 'shipped' || (status === 'ready_to_ship' && isHandedOverSubstatus(shipment?.substatus, logistic));
  if (!dispatched) return { dispatched: false, dispatchedAt: null };
  const history = Array.isArray(shipment?.substatus_history) ? shipment.substatus_history : [];
  const handedOver = history
    .filter((h) => isHandedOverSubstatus(h?.substatus, logistic))
    .map((h) => dateOrNull(h?.date))
    .filter(Boolean)
    .sort((a, b) => a.getTime() - b.getTime());
  const dispatchedAt = handedOver[0] ?? dateOrNull(shipment?.status_history?.date_shipped);
  return { dispatched: true, dispatchedAt };
}

/** ¿El envío está pendiente de despachar por la vendedora? Full lo despacha ML: nunca. */
export function isPendingShipment(shipment) {
  if (!shipment) return false;
  if (logisticTypeOf(shipment) === 'fulfillment') return false;
  const status = String(shipment.status ?? '').toLowerCase();
  // "Despachá el X día": ML lo deja `pending/buffered` hasta que habilita la etiqueta. Es un envío
  // por despachar (va a Próximos días), no uno sin pagar.
  if (status === 'pending') return String(shipment.substatus ?? '').toLowerCase() === 'buffered';
  if (!ML_PENDING_STATUSES.has(status)) return false;
  return !mlDispatchInfo(shipment).dispatched;
}

/**
 * ¿Se muestra en "Ya despachados"? Solo lo entregado hoy (hora argentina). Si ML no da la fecha,
 * un `ready_to_ship` entregado igual se muestra (sigue en el punto: es reciente); un `shipped` sin
 * fecha no (no hay forma de saber si fue hoy).
 */
export function isDispatchedToday(shipment, now) {
  if (!shipment || logisticTypeOf(shipment) === 'fulfillment') return false;
  const { dispatched, dispatchedAt } = mlDispatchInfo(shipment);
  if (!dispatched) return false;
  if (dispatchedAt) return arDayKey(dispatchedAt) === arDayKey(now);
  return String(shipment.status).toLowerCase() === 'ready_to_ship';
}

/** Clave del paquete: un carrito de ML son varias órdenes con el mismo pack_id. */
export function packKey(order) {
  return String(order?.pack_id ?? order?.id);
}

/** `YYYY-MM-DD` del instante en hora argentina. */
export function arDayKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  return new Intl.DateTimeFormat('en-CA', { timeZone: AR_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function dateOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Horario límite de despacho de ML: `sla.expected_date` (fecha y hora) y, si no hay, el
 * `estimated_handling_limit` del lead_time (solo fecha: ML da todo ese día). `bufferedUntil` es la
 * fecha desde la que se habilita la etiqueta cuando el envío está en espera (`buffered`) — el
 * "Despachá el X" del panel de ML.
 */
export function mlDeadlineInfo(shipment, sla) {
  const leadTime = shipment?.lead_time ?? shipment?.shipping_option ?? {};
  const slaDate = dateOrNull(sla?.expected_date);
  const handlingLimit = dateOrNull(leadTime?.estimated_handling_limit?.date);
  const bufferingDate = dateOrNull(leadTime?.buffering?.date);
  const substatus = String(shipment?.substatus ?? '').toLowerCase();
  return {
    deadline: slaDate ?? handlingLimit ?? null,
    deadlineHasTime: !!slaDate,
    slaStatus: sla?.status ?? null,
    bufferedUntil: substatus === 'buffered' ? (bufferingDate ?? slaDate ?? handlingLimit) : null,
    buffered: substatus === 'buffered',
  };
}

/**
 * En qué parte de la página va el paquete: 'overdue' | 'today' | 'upcoming'. Sin límite conocido
 * (o TN, que no tiene) va a "hoy": mejor que se vea de más a que quede escondido en otro día.
 */
export function bucketFor({ deadline, deadlineHasTime, slaStatus, bufferedUntil, buffered }, now) {
  const today = arDayKey(now);
  if (bufferedUntil && arDayKey(bufferedUntil) > today) return 'upcoming';
  // En espera sin fecha conocida: la etiqueta todavía no se puede imprimir, no es para hoy.
  if (buffered && !bufferedUntil) return 'upcoming';
  if (!deadline) return 'today';
  const deadlineDay = arDayKey(deadline);
  if (slaStatus === 'delayed' || deadlineDay < today) return 'overdue';
  // Con hora exacta (SLA), pasado el horario ya está vencido aunque sea el mismo día.
  if (deadlineHasTime && new Date(deadline).getTime() < now.getTime()) return 'overdue';
  if (deadlineDay === today) return 'today';
  return 'upcoming';
}

const ML_SUBSTATUS_LABELS = {
  ready_to_print: 'Imprimir etiqueta',
  printed: 'Etiqueta impresa',
  in_packing_list: 'En lista de despacho',
  in_hub: 'En el punto de despacho',
  picked_up: 'Retirado',
  ready_for_pickup: 'Listo para retirar',
  ready_for_dropoff: 'Listo para llevar al correo',
};

/** Estado legible del paquete y su tono (para el chip): 'warn' | 'err' | 'neutral' | 'ok'. */
export function stateLabel(pkg) {
  if (pkg.cancelled) return { label: 'Cancelado', tone: 'err' };
  if (pkg.bucket === 'dispatched') {
    return { label: pkg.dispatchedAt ? `Despachado ${formatTime(pkg.dispatchedAt)}` : 'Despachado', tone: 'ok' };
  }
  if (pkg.channel === 'tn') {
    const s = String(pkg.shipStatus ?? '').toLowerCase();
    if (s === 'unpacked') return { label: 'Sin empaquetar', tone: 'warn' };
    if (s.startsWith('partially')) return { label: 'Empaquetado en parte', tone: 'warn' };
    return { label: 'Empaquetado, sin enviar', tone: 'neutral' };
  }
  const sub = String(pkg.substatus ?? '').toLowerCase();
  if (sub === 'buffered' && pkg.bufferedUntil) {
    return { label: `En espera hasta el ${formatDayShort(pkg.bufferedUntil)}`, tone: 'neutral' };
  }
  if (pkg.bucket === 'overdue') {
    return { label: 'Atrasado', tone: 'err' };
  }
  if (String(pkg.shipStatus).toLowerCase() === 'handling') return { label: 'Preparando etiqueta', tone: 'neutral' };
  if (ML_SUBSTATUS_LABELS[sub]) return { label: ML_SUBSTATUS_LABELS[sub], tone: sub === 'ready_to_print' ? 'warn' : 'neutral' };
  return { label: 'Para despachar', tone: 'neutral' };
}

function formatTime(d) {
  return new Intl.DateTimeFormat('es-AR', { timeZone: AR_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(d));
}

function formatDayShort(d) {
  return new Intl.DateTimeFormat('es-AR', { timeZone: AR_TZ, day: '2-digit', month: '2-digit' }).format(new Date(d));
}

/** Versión chica (thumbnail) de una URL de foto de ML: `…-O.jpg` → `…-I.jpg`. */
export function mlThumbFromUrl(url) {
  if (!url) return null;
  return String(url).replace(/-[A-Z]\.(jpg|jpeg|png|webp)$/i, '-I.$1');
}

/**
 * Fotos de un ítem de ML para una línea de la orden: las de la variación (por `picture_ids`, en su
 * orden) y si no tiene, las del ítem. URLs grandes (`secure_url`), para el zoom.
 */
export function mlPicturesFor(item, variationId) {
  if (!item) return [];
  const all = Array.isArray(item.pictures) ? item.pictures : [];
  const byId = new Map(all.map((p) => [String(p.id), p]));
  const variation = variationId != null
    ? (item.variations || []).find((v) => String(v.id) === String(variationId))
    : null;
  const ids = Array.isArray(variation?.picture_ids) ? variation.picture_ids : [];
  const chosen = ids.length ? ids.map((id) => byId.get(String(id))).filter(Boolean) : all;
  return [...new Set(chosen.map((p) => p.secure_url || p.url).filter(Boolean))];
}

function mlVariationLabel(orderItem) {
  const attrs = orderItem?.item?.variation_attributes || [];
  return attrs.map((a) => a.value_name).filter(Boolean).join(' · ') || null;
}

/**
 * Arma los paquetes de ML a partir de las órdenes y lo ya resuelto por envío. Puro: recibe
 * `shipments`/`slas` (Map por shipment id) e `items` (Map por item id) ya traídos.
 */
export function buildMlPackages(orders, { shipments, slas, items, now }) {
  const groups = new Map();
  for (const order of orders) {
    const key = packKey(order);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(order);
  }

  const pending = [];
  const cancelled = [];
  for (const [saleId, group] of groups) {
    const first = group[0];
    const shipmentId = group.map(getShipmentIdFromOrder).find(Boolean) ?? null;
    const shipment = shipmentId ? shipments.get(String(shipmentId)) : null;
    const lines = group.flatMap((o) => (o.order_items || []).map((it) => {
      const itemId = it?.item?.id ?? null;
      const variationId = it?.item?.variation_id ?? null;
      const pictures = mlPicturesFor(items.get(String(itemId)), variationId);
      return {
        sku: it?.item?.seller_sku ?? it?.item?.seller_custom_field ?? null,
        title: it?.item?.title ?? '',
        variation: mlVariationLabel(it),
        qty: Number(it.quantity) || 0,
        thumb: mlThumbFromUrl(pictures[0]) ?? items.get(String(itemId))?.secure_thumbnail ?? null,
        pictures,
        itemId,
      };
    }));
    const base = {
      channel: 'ml',
      saleId,
      orderIds: group.map((o) => String(o.id)),
      buyer: first?.buyer?.nickname ?? null,
      city: shipment?.destination?.shipping_address?.city?.name ?? shipment?.receiver_address?.city?.name ?? null,
      createdAt: first?.date_created ?? null,
      shipmentId: shipmentId ? String(shipmentId) : null,
      logisticType: logisticTypeOf(shipment),
      shipStatus: shipment?.status ?? null,
      substatus: shipment?.substatus ?? null,
      shippingMethod: null,
      items: lines,
    };

    const allCancelled = group.every((o) => String(o.status).toLowerCase() === 'cancelled');
    if (allCancelled) {
      if (!wasRealSale(group) || !cancelledRecently(group, now)) continue;
      // Si el paquete llegó a salir, ya no es "no despachar": es una devolución (otro circuito).
      if (shipment && !isSafeToAutoRestore(shipment).safe) continue;
      cancelled.push({
        ...base,
        cancelled: true,
        cancelledAt: latestDate(group.map((o) => o.date_last_updated ?? o.date_closed)),
        deadline: null, deadlineHasTime: false, slaStatus: null, bufferedUntil: null,
        bucket: 'cancelled',
      });
      continue;
    }

    if (!group.some((o) => String(o.status).toLowerCase() === 'paid')) continue;
    if (isDispatchedToday(shipment, now)) {
      const { dispatchedAt } = mlDispatchInfo(shipment);
      pending.push({
        ...base,
        cancelled: false,
        deadline: null, deadlineHasTime: false, slaStatus: null, bufferedUntil: null,
        dispatchedAt: dispatchedAt ? dispatchedAt.toISOString() : null,
        bucket: 'dispatched',
      });
      continue;
    }
    if (!isPendingShipment(shipment)) continue;
    const dl = mlDeadlineInfo(shipment, slas.get(String(shipmentId)));
    const pkg = {
      ...base,
      cancelled: false,
      deadline: dl.deadline ? dl.deadline.toISOString() : null,
      deadlineHasTime: dl.deadlineHasTime,
      slaStatus: dl.slaStatus,
      bufferedUntil: dl.bufferedUntil ? dl.bufferedUntil.toISOString() : null,
    };
    pkg.bucket = bucketFor(dl, now);
    pending.push(pkg);
  }
  return { pending, cancelled };
}

/** Una orden cancelada solo se avisa si llegó a cobrarse: un pago rechazado nunca fue un pedido a armar. */
function wasRealSale(group) {
  return group.some((o) => (o.payments || []).some((p) => p.date_approved || p.status === 'approved' || p.status === 'refunded'));
}

function cancelledRecently(group, now) {
  const at = latestDate(group.map((o) => o.date_last_updated ?? o.date_closed));
  return !!at && now.getTime() - new Date(at).getTime() <= CANCELLED_WINDOW_HOURS * MS_HOUR;
}

function latestDate(values) {
  const ds = values.map(dateOrNull).filter(Boolean);
  if (!ds.length) return null;
  return new Date(Math.max(...ds.map((d) => d.getTime()))).toISOString();
}

/** Un paquete de TN a partir de su orden (ya filtrada: pendiente o cancelada). */
export function buildTnPackage(order, { cancelled = false } = {}) {
  const addr = order?.shipping_address || {};
  const items = (order?.products || []).map((p) => {
    const src = p?.image?.src ? String(p.image.src).replace(/^http:/, 'https:') : null;
    const variantValues = Array.isArray(p?.variant_values) ? p.variant_values.filter(Boolean) : [];
    return {
      sku: p?.sku || null,
      title: p?.name ?? '',
      variation: variantValues.length ? variantValues.join(' · ') : null,
      qty: Number(p?.quantity) || 0,
      thumb: src,
      pictures: src ? [src] : [],
      productId: p?.product_id ?? null,
    };
  });
  const shippingOption = typeof order?.shipping_option === 'string'
    ? order.shipping_option
    : order?.shipping_option?.name ?? null;
  return {
    channel: 'tn',
    saleId: String(order.id),
    orderNumber: order?.number != null ? String(order.number) : null,
    buyer: order?.contact_name ?? order?.customer?.name ?? null,
    city: addr.city ?? null,
    createdAt: order?.paid_at ?? order?.created_at ?? null,
    shipStatus: order?.shipping_status ?? null,
    substatus: null,
    logisticType: order?.shipping_pickup_type === 'pickup' ? 'pickup' : 'ship',
    shippingMethod: shippingOption,
    deadline: null,
    deadlineHasTime: false,
    slaStatus: null,
    bufferedUntil: null,
    cancelled,
    cancelledAt: cancelled ? (order?.cancelled_at ?? order?.updated_at ?? null) : null,
    bucket: cancelled ? 'cancelled' : 'today',
    items,
  };
}

const TN_DONE_SHIPPING = new Set(['shipped', 'fulfilled', 'delivered']);

/** ¿La orden de TN está pagada y sin enviar? */
export function isTnPending(order) {
  if (String(order?.status ?? '').toLowerCase() !== 'open') return false;
  if (String(order?.payment_status ?? '').toLowerCase() !== 'paid') return false;
  return !TN_DONE_SHIPPING.has(String(order?.shipping_status ?? '').toLowerCase());
}

/**
 * Mergea las marcas del hub, calcula el estado legible y ordena: dentro de cada bucket por horario
 * (lo que vence antes, arriba), los preparados al final. Los cancelados ya vistos se descartan.
 */
export function finalizePackages(packages, marks) {
  const out = [];
  for (const pkg of packages) {
    const mark = marks.get(`${pkg.channel}:${pkg.saleId}`) ?? null;
    if (pkg.cancelled && mark?.cancelSeenAt) continue;
    const withMark = {
      ...pkg,
      preparedAt: mark?.preparedAt ?? null,
      preparedBy: mark?.preparedBy ?? null,
      deadlineDay: pkg.deadline ? arDayKey(pkg.deadline) : null,
      bufferedDay: pkg.bufferedUntil ? arDayKey(pkg.bufferedUntil) : null,
    };
    withMark.state = stateLabel(withMark);
    out.push(withMark);
  }
  const ts = (p) => {
    const d = p.bufferedUntil ?? p.deadline ?? p.createdAt;
    return d ? new Date(d).getTime() : Number.MAX_SAFE_INTEGER;
  };
  return out.sort((a, b) => {
    if (!!a.preparedAt !== !!b.preparedAt) return a.preparedAt ? 1 : -1;
    if (a.channel !== b.channel) return a.channel === 'ml' ? -1 : 1;
    return ts(a) - ts(b);
  });
}

// ─────────────────────────── I/O ───────────────────────────

/** Envíos que ya no pueden volver a "pendiente" (despachados, entregados, cancelados): no se reconsultan. */
const finalShipments = new Map();
const FINAL_SHIPMENTS_MAX = 2000;

function rememberFinal(shipment) {
  if (!shipment?.id || !ML_FINAL_STATUSES.has(String(shipment.status).toLowerCase())) return;
  if (finalShipments.size >= FINAL_SHIPMENTS_MAX) finalShipments.delete(finalShipments.keys().next().value);
  finalShipments.set(String(shipment.id), shipment);
}

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (i < list.length) {
      const idx = i++;
      out[idx] = await fn(list[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** `{ 'ready_to_ship/printed': 3, … }` — para confirmar en los logs los substatus reales de la cuenta. */
function countByStatus(shipments) {
  const out = {};
  for (const s of shipments.values()) {
    const k = `${s?.status ?? '?'}/${s?.substatus ?? '-'}`;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

async function loadMl(now) {
  const token = await getMlToken();
  const sellerId = tokens.mercadolibre?.user_id;
  if (!token || !sellerId) throw new Error('Mercado Libre no está conectado');

  const from = new Date(now.getTime() - ML_LOOKBACK_DAYS * MS_DAY).toISOString();
  const orders = await ml.getOrdersWindow(token, sellerId, from, now.toISOString());
  // Solo interesan las pagadas sin entregar y las canceladas recientes; el resto ni se mira.
  const relevant = orders.filter((o) => {
    const st = String(o.status).toLowerCase();
    if (st === 'paid') return !(o.tags || []).includes('delivered');
    if (st === 'cancelled') return cancelledRecently([o], now);
    return false;
  });

  const shipmentIds = [...new Set(relevant.map(getShipmentIdFromOrder).filter(Boolean).map(String))];
  const shipments = new Map();
  await mapLimit(shipmentIds, 4, async (id) => {
    const memo = finalShipments.get(id);
    if (memo) { shipments.set(id, memo); return; }
    const s = await ml.getShipment(token, id);
    if (s) { shipments.set(id, s); rememberFinal(s); }
  });

  console.info('[Despachos] envíos ML:', JSON.stringify(countByStatus(shipments)));

  const slas = new Map();
  const pendingIds = shipmentIds.filter((id) => isPendingShipment(shipments.get(id)));
  await mapLimit(pendingIds, 4, async (id) => {
    const sla = await ml.getShipmentSla(token, id);
    if (sla) slas.set(id, sla);
  });

  // Fotos: solo de los ítems de paquetes que se van a mostrar.
  const shownIds = new Set([...pendingIds, ...shipmentIds.filter((id) => isDispatchedToday(shipments.get(id), now))]);
  const shown = relevant.filter((o) => {
    const sid = getShipmentIdFromOrder(o);
    return String(o.status).toLowerCase() === 'cancelled' || (sid && shownIds.has(String(sid)));
  });
  const itemIds = [...new Set(shown.flatMap((o) => (o.order_items || []).map((it) => it?.item?.id)).filter(Boolean))];
  const itemList = itemIds.length ? await ml.getItems(token, itemIds, 'id,pictures,variations,secure_thumbnail') : [];
  const items = new Map(itemList.map((it) => [String(it.id), it]));

  const { pending, cancelled } = buildMlPackages(relevant, { shipments, slas, items, now });
  return [...pending, ...cancelled];
}

async function loadTn(now) {
  const t = tokens.tiendanube;
  if (!t?.access_token || !t?.store_id) throw new Error('Tienda Nube no está conectada');
  const base = { status: 'open', payment_status: 'paid' };
  const [unpacked, unfulfilled, cancelledOrders] = await Promise.all([
    tn.listOrders(t.access_token, t.store_id, { ...base, shipping_status: 'unpacked' }),
    tn.listOrders(t.access_token, t.store_id, { ...base, shipping_status: 'unfulfilled' }),
    tn.listOrders(t.access_token, t.store_id, {
      status: 'cancelled',
      updated_at_min: new Date(now.getTime() - CANCELLED_WINDOW_HOURS * MS_HOUR).toISOString(),
    }),
  ]);
  const byId = new Map();
  for (const o of [...unpacked, ...unfulfilled]) if (isTnPending(o)) byId.set(String(o.id), o);
  const pending = [...byId.values()].map((o) => buildTnPackage(o));
  const cancelled = cancelledOrders
    .filter((o) => !['pending', 'abandoned'].includes(String(o.payment_status).toLowerCase()))
    .filter((o) => !TN_DONE_SHIPPING.has(String(o.shipping_status ?? '').toLowerCase()))
    .map((o) => buildTnPackage(o, { cancelled: true }));
  return [...pending, ...cancelled];
}

let cache = null; // { at, packages, errors }

/**
 * Lista para la página. `refresh` saltea la caché (botón "Actualizar"). Si un canal falla, el otro
 * se devuelve igual y `errors` dice cuál no se pudo leer — una lista vacía nunca debe significar
 * "no hay pedidos" cuando en realidad ML no contestó.
 */
export async function getDispatchList({ refresh = false, now = new Date() } = {}) {
  if (refresh || !cache || now.getTime() - cache.at > CACHE_TTL_MS) {
    const errors = {};
    const [mlRes, tnRes] = await Promise.allSettled([loadMl(now), loadTn(now)]);
    const packages = [];
    if (mlRes.status === 'fulfilled') packages.push(...mlRes.value);
    else { errors.ml = describeError(mlRes.reason); console.warn('[Despachos] ML:', mlRes.reason?.message); }
    if (tnRes.status === 'fulfilled') packages.push(...tnRes.value);
    else { errors.tn = describeError(tnRes.reason); console.warn('[Despachos] TN:', tnRes.reason?.message); }
    cache = { at: now.getTime(), packages, errors };
  }
  const marks = await db.getDispatchMarks();
  return {
    generatedAt: new Date(cache.at).toISOString(),
    today: arDayKey(now),
    packages: finalizePackages(cache.packages, marks),
    errors: cache.errors,
  };
}

function describeError(e) {
  if (e?.statusCode === 429) return 'La API no contestó (demasiados pedidos seguidos). Probá de nuevo en un minuto.';
  return e?.message || 'No se pudo leer';
}

/** Solo para tests. */
export function _resetDispatchCache() {
  cache = null;
  finalShipments.clear();
}
