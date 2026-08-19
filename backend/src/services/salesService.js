/**
 * Dashboard de ventas de ML por provincia (informe mensual para el contador).
 *
 * El hub no guardaba ventas — es un sistema de stock, no de facturación. Este servicio duplica
 * localmente lo necesario (backend/src/db.js: ml_sales_orders / ml_sales_items) porque armar el
 * informe on-the-fly costaría 1 request a ML por orden en cada visita (el `GET /orders/:id` no
 * trae provincia, hace falta un `GET /shipments/:id` extra). Se mantiene al día en tres capas:
 *
 *  1. Webhooks (tiempo real) — `upsertSaleFromOrder` se llama desde routes/webhooks.js reusando
 *     la orden que esos caminos ya traen, sin requests extra a ML.
 *  2. Barrido de seguridad (`sweepRecentSales`, 1x/día + botón) — reprocesa los últimos
 *     `REPROCESS_WINDOW_DAYS` por si se perdió algún webhook. Esa ventana no es arbitraria:
 *     coincide con el plazo que tiene un comprador para cancelar o devolver una compra.
 *  3. Backfill inicial (`syncMlSales`, una sola vez) — año en curso.
 *
 * Navegar al dashboard nunca le pega a ML: `getSalesReport` solo lee las tablas locales.
 */

import * as ml from '../lib/mercadolibre.js';
import { tokens, getMlToken } from '../store.js';
import { getShipmentIdFromOrder } from '../lib/mlShipmentState.js';
import * as db from '../db.js';

const MS_DAY = 24 * 60 * 60 * 1000;

/** Ventana de reproceso del barrido: coincide con el plazo de cancelación/devolución del comprador. */
export const REPROCESS_WINDOW_DAYS = 30;

// ─────────────────────────── funciones puras (sin red ni base) ───────────────────────────

const CABA_ALIASES = new Set([
  'capital federal',
  'ciudad autónoma de buenos aires',
  'ciudad autonoma de buenos aires',
  'caba',
]);

/** Unifica los nombres de provincia que devuelve ML. Sin envío asociado → "Sin provincia". */
export function normalizeStateName(rawName) {
  const trimmed = (rawName ?? '').toString().trim();
  if (!trimmed) return 'Sin provincia';
  if (CABA_ALIASES.has(trimmed.toLowerCase())) return 'CABA';
  return trimmed;
}

/**
 * Provincia/ciudad del envío. La forma exacta de `GET /shipments/:id` (con `x-format-new: true`,
 * como ya usa `ml.getShipment`) no está verificada contra un payload real de esta cuenta — se
 * cubren las dos formas documentadas por ML (`destination.shipping_address` del formato nuevo y
 * `receiver_address` del legacy) y hay que confirmar cuál trae la cuenta real antes de dar por
 * buena la columna de provincia en producción.
 */
function extractShipmentLocation(shipment) {
  const addr = shipment?.destination?.shipping_address ?? shipment?.receiver_address ?? null;
  const state = addr?.state ?? null;
  return {
    stateId: state?.id ?? null,
    stateName: state?.name ?? null,
    cityName: addr?.city?.name ?? null,
  };
}

/**
 * Clasifica una orden para el informe: 'facturada' | 'cancelada' | 'devuelta'. Puro a propósito
 * (testeable sin red): recibe la orden y el envío ya resueltos, nunca los busca.
 *
 * Una devolución vía claim (arrepentimiento / producto defectuoso, sin que ML cancele la orden)
 * NO se detecta acá — en ese camino la orden sigue 'paid' en ML. Se marca aparte, de forma
 * explícita, en el momento en que se aprueba (ver `markSaleReturned`), no como una clasificación
 * derivada en cada sync.
 */
export function classifyOrder(order, shipment) {
  const status = (order?.status || '').toLowerCase();
  if (status === 'cancelled' || status === 'canceled') {
    return { computedStatus: 'cancelada', exclusionReason: 'cancelada_ml' };
  }
  if (status !== 'paid' && status !== 'confirmed') {
    return { computedStatus: 'cancelada', exclusionReason: 'no_pagada' };
  }
  const shipStatus = (shipment?.status || '').toLowerCase();
  const shipSubstatus = (shipment?.substatus || '').toLowerCase();
  if (shipStatus === 'returned' || shipSubstatus === 'returning_to_sender' || shipSubstatus === 'returned') {
    return { computedStatus: 'devuelta', exclusionReason: 'envio_devuelto' };
  }
  return { computedStatus: 'facturada', exclusionReason: null };
}

/**
 * Arma la fila de `ml_sales_orders` y sus `ml_sales_items` a partir de una orden de ML (y, si se
 * tiene, su envío). "Facturado" = Σ unit_price × quantity de los ítems — sin envío, por acuerdo
 * con la usuaria (el resto de los montos se guardan igual, por si hacen falta después).
 */
export function buildOrderRow(order, shipment) {
  const items = order?.order_items || [];
  const itemsAmount = items.reduce((sum, it) => sum + (Number(it.unit_price) || 0) * (Number(it.quantity) || 0), 0);
  const units = items.reduce((sum, it) => sum + (Number(it.quantity) || 0), 0);
  const feesSum = items.reduce((sum, it) => sum + (Number(it.sale_fee) || 0), 0);

  const payments = order?.payments || [];
  const paidAmount = payments.length
    ? payments.reduce((s, p) => s + (Number(p.transaction_amount) || 0), 0)
    : (order?.paid_amount != null ? Number(order.paid_amount) : null);
  const shippingCostSum = payments.reduce((s, p) => s + (Number(p.shipping_cost) || 0), 0);

  const { stateId, stateName, cityName } = extractShipmentLocation(shipment);
  const { computedStatus, exclusionReason } = classifyOrder(order, shipment);
  const shipmentId = shipment?.id != null ? String(shipment.id) : getShipmentIdFromOrder(order);

  const orderItems = items.map((it) => ({
    itemId: it?.item?.id ?? null,
    variationId: it?.item?.variation_id ?? it?.variation_id ?? null,
    sku: it?.item?.seller_sku ?? it?.item?.seller_custom_field ?? null,
    title: it?.item?.title ?? null,
    quantity: Number(it.quantity) || 0,
    unitPrice: Number(it.unit_price) || 0,
    saleFee: it.sale_fee != null ? Number(it.sale_fee) : null,
  }));

  const row = {
    orderId: String(order.id),
    packId: order.pack_id != null ? String(order.pack_id) : null,
    dateCreated: order.date_created ?? null,
    dateClosed: order.date_closed ?? null,
    mlStatus: order.status ?? 'unknown',
    computedStatus,
    exclusionReason,
    shipmentId,
    shipmentStatus: shipment?.status ?? null,
    shipmentSubstatus: shipment?.substatus ?? null,
    stateId,
    stateName: normalizeStateName(stateName),
    cityName: cityName ?? null,
    itemsAmount,
    shippingCost: shippingCostSum || null,
    totalAmount: order.total_amount != null ? Number(order.total_amount) : null,
    paidAmount,
    mlFees: feesSum || null,
    units,
    buyerNickname: order?.buyer?.nickname ?? order?.buyer?.first_name ?? null,
  };

  return { row, items: orderItems };
}

/**
 * Límites [prevFrom, prevTo] del período inmediatamente anterior, del mismo largo EN DÍAS que
 * [from, to] — no el mes calendario anterior. Para un mes de 31 días eso corre el período
 * comparado un día hacia atrás del 1° del mes anterior (ej. julio compara contra 31 may.–30 jun.,
 * no contra junio completo). Es una simplificación a propósito: comparar por mes calendario
 * habría que tratarlo distinto de un rango libre, y el Δ% es una referencia para el informe, no el
 * número que se factura.
 */
export function computePreviousPeriod(fromISO, toISO) {
  const fromMs = new Date(fromISO).getTime();
  const toMs = new Date(toISO).getTime();
  const lengthMs = toMs - fromMs;
  const prevToMs = fromMs - 1;
  const prevFromMs = prevToMs - lengthMs;
  return { prevFrom: new Date(prevFromMs).toISOString(), prevTo: new Date(prevToMs).toISOString() };
}

function pctDelta(curr, prev) {
  if (prev > 0) return Math.round(((curr - prev) / prev) * 100);
  return curr > 0 ? 100 : 0;
}

/**
 * Agrega filas crudas de `ml_sales_orders` (rango [prevFrom, to], todos los computed_status) en
 * el shape del informe: KPIs del período actual con su Δ% contra el anterior, filas por provincia,
 * y el conteo de excluidas (auditoría de que el número cumple "sin canceladas ni devoluciones").
 * Pura: no toca la base — la lee quien llama (`getSalesReport`).
 */
export function aggregateSalesReport(rows, { from, to, prevFrom, prevTo }) {
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  const prevFromMs = new Date(prevFrom).getTime();
  const prevToMs = new Date(prevTo).getTime();

  const current = [];
  const previous = [];
  let currentTotalCount = 0;
  let canceladas = 0;
  let devueltas = 0;

  for (const r of rows) {
    const t = new Date(r.dateCreated).getTime();
    const inCurrent = t >= fromMs && t <= toMs;
    const inPrevious = !inCurrent && t >= prevFromMs && t <= prevToMs;

    if (inCurrent) {
      currentTotalCount++;
      if (r.computedStatus === 'cancelada') canceladas++;
      else if (r.computedStatus === 'devuelta') devueltas++;
    }
    if (r.computedStatus !== 'facturada') continue;
    if (inCurrent) current.push(r);
    else if (inPrevious) previous.push(r);
  }

  // "Ventas" = compras, no líneas de orden: un pack de N productos reparte cada producto en su
  // propia orden de ML (su propio order_id), así que contar filas cuenta productos disfrazados de
  // ventas — un pack de 9 productos aparecía como "9 ventas" en vez de 1 (incidente 2026-08-19: el
  // Excel de ML mostraba 51 paquetes en 3 semanas de julio —~78 al mes— contra las 236 "ventas" que
  // mostraba acá, que en realidad eran 237 líneas de producto). La clave de venta es `pack_id` si
  // la orden vino de un carrito, o el propio `order_id` si es una venta suelta.
  const saleKey = (r) => r.packId || r.orderId;

  const byProvince = (list) => {
    const map = new Map();
    for (const r of list) {
      const key = r.stateName || 'Sin provincia';
      const e = map.get(key) || { name: key, ventasSet: new Set(), unidades: 0, facturado: 0 };
      e.ventasSet.add(saleKey(r));
      e.unidades += r.units;
      e.facturado += r.itemsAmount;
      map.set(key, e);
    }
    return map;
  };

  const curByProv = byProvince(current);
  const prevByProv = byProvince(previous);

  const totalFacturado = current.reduce((s, r) => s + r.itemsAmount, 0);
  const totalPrevFacturado = previous.reduce((s, r) => s + r.itemsAmount, 0);
  const totalUnidades = current.reduce((s, r) => s + r.units, 0);
  const totalPrevUnidades = previous.reduce((s, r) => s + r.units, 0);
  const totalVentas = new Set(current.map(saleKey)).size;
  const totalPrevVentas = new Set(previous.map(saleKey)).size;

  const provinces = [...curByProv.values()]
    .map((e) => {
      const prevE = prevByProv.get(e.name);
      return {
        name: e.name,
        ventas: e.ventasSet.size,
        unidades: e.unidades,
        facturado: e.facturado,
        pctOfTotal: totalFacturado > 0 ? Math.round((e.facturado / totalFacturado) * 100) : 0,
        deltaPct: pctDelta(e.facturado, prevE?.facturado ?? 0),
      };
    })
    .sort((a, b) => b.facturado - a.facturado);

  const ticketPromedio = totalVentas > 0 ? totalFacturado / totalVentas : 0;
  const ticketPromedioPrev = totalPrevVentas > 0 ? totalPrevFacturado / totalPrevVentas : 0;

  return {
    kpis: {
      facturadoTotal: totalFacturado,
      facturadoDeltaPct: pctDelta(totalFacturado, totalPrevFacturado),
      ventas: totalVentas,
      ventasDeltaPct: pctDelta(totalVentas, totalPrevVentas),
      unidades: totalUnidades,
      unidadesDeltaPct: pctDelta(totalUnidades, totalPrevUnidades),
      ticketPromedio,
      ticketPromedioDeltaPct: pctDelta(ticketPromedio, ticketPromedioPrev),
    },
    provinces,
    excluded: {
      total: currentTotalCount,
      facturadas: current.length,
      canceladas,
      devueltas,
    },
  };
}

// ─────────────────────────── funciones async (tocan DB y/o ML) ───────────────────────────

/** Guarda (o actualiza) una venta a partir de una orden de ML. Usada por las tres capas. */
export async function upsertSaleFromOrder(order, shipment = null) {
  if (!order?.id) return false;
  const { row, items } = buildOrderRow(order, shipment);
  return db.upsertSale(row, items);
}

/**
 * Llamar cuando se aprueba una devolución por claim (arrepentimiento / producto defectuoso) —
 * `approvePendingReturn` en syncService.js. A diferencia de una cancelación, ML no cambia el
 * `status` de la orden a `cancelled` en este camino, así que `classifyOrder` no la detecta sola:
 * la transición a 'devuelta' es un evento explícito, no una reclasificación en el próximo sync.
 */
export async function markSaleReturned(orderId) {
  const existing = await db.getSaleByOrderId(String(orderId));
  if (!existing) return false;
  return db.updateSaleStatus(existing.orderId, 'devuelta', 'devolucion_aprobada');
}

let syncInFlight = null;

async function runSync(mode) {
  const accessToken = await getMlToken();
  const sellerId = tokens.mercadolibre?.user_id;
  const startedAt = new Date().toISOString();
  if (!accessToken || !sellerId) {
    await db.setSalesSyncState({ status: 'error', startedAt, error: 'Sin sesión de Mercado Libre', processed: 0, total: 0 });
    return;
  }

  const now = new Date();
  const prevState = (await db.getSalesSyncState()) || {};
  const from = mode === 'backfill'
    ? new Date(now.getFullYear(), 0, 1).toISOString()
    : new Date(now.getTime() - REPROCESS_WINDOW_DAYS * MS_DAY).toISOString();
  const to = now.toISOString();

  await db.setSalesSyncState({
    status: 'running', startedAt, lastSyncAt: prevState.lastSyncAt ?? null,
    processed: 0, total: 0, phase: 'listando órdenes',
  });

  try {
    const orders = await ml.getOrdersWindow(accessToken, sellerId, from, to);
    await db.setSalesSyncState({
      status: 'running', startedAt, lastSyncAt: prevState.lastSyncAt ?? null,
      processed: 0, total: orders.length, phase: 'trayendo envíos',
    });

    const shipmentCache = new Map();
    let processed = 0;
    for (const order of orders) {
      const orderId = String(order.id);
      const orderDateMs = new Date(order.date_created).getTime();
      const withinReprocessWindow = Number.isFinite(orderDateMs) && (now.getTime() - orderDateMs) <= REPROCESS_WINDOW_DAYS * MS_DAY;

      // Ya guardada, mismo status, y ya no puede cambiar (fuera del plazo de cancelación/devolución):
      // no vale la pena ni el request del envío. Esto es lo que hace barato el "Actualizar" mensual.
      const existing = await db.getSaleByOrderId(orderId);
      if (existing && existing.mlStatus === order.status && !withinReprocessWindow) {
        processed++;
        continue;
      }

      const shipmentId = getShipmentIdFromOrder(order);
      let shipment = null;
      if (shipmentId) {
        if (shipmentCache.has(shipmentId)) {
          shipment = shipmentCache.get(shipmentId);
        } else {
          try {
            shipment = await ml.getShipment(accessToken, shipmentId);
          } catch (e) {
            shipment = null; // 429 agotado: se guarda sin provincia, el próximo barrido la completa
          }
          shipmentCache.set(shipmentId, shipment);
        }
      }

      await upsertSaleFromOrder(order, shipment);
      processed++;
      if (processed % 10 === 0 || processed === orders.length) {
        await db.setSalesSyncState({
          status: 'running', startedAt, lastSyncAt: prevState.lastSyncAt ?? null,
          processed, total: orders.length, phase: 'guardando ventas',
        });
      }
    }

    await db.setSalesSyncState({
      status: 'idle', startedAt, lastSyncAt: now.toISOString(),
      processed: orders.length, total: orders.length, phase: null,
    });
  } catch (e) {
    console.error('[Ventas] sync error:', e.message);
    await db.setSalesSyncState({
      status: 'error', startedAt, lastSyncAt: prevState.lastSyncAt ?? null,
      error: e.message, processed: 0, total: 0,
    });
  }
}

/** Backfill inicial: año en curso completo. Una sola vez (o si el usuario la vuelve a pedir). */
export async function syncMlSales() {
  if (syncInFlight) return syncInFlight;
  syncInFlight = runSync('backfill').finally(() => { syncInFlight = null; });
  return syncInFlight;
}

/** Barrido de seguridad: últimos REPROCESS_WINDOW_DAYS días. Dispara el botón y el job diario. */
export async function sweepRecentSales() {
  if (syncInFlight) return syncInFlight;
  syncInFlight = runSync('sweep').finally(() => { syncInFlight = null; });
  return syncInFlight;
}

/** Lo que dispara el botón "Actualizar": el backfill si nunca corrió, si no el barrido. */
export async function triggerSync() {
  const state = await db.getSalesSyncState();
  if (!state || !state.lastSyncAt) return syncMlSales();
  return sweepRecentSales();
}

export async function getSyncState() {
  const state = await db.getSalesSyncState();
  return state || { status: 'idle', lastSyncAt: null, processed: 0, total: 0, phase: null };
}

/** El informe completo para el rango [fromISO, toISO]. Solo lee la base — nunca llama a ML. */
export async function getSalesReport(fromISO, toISO) {
  const { prevFrom, prevTo } = computePreviousPeriod(fromISO, toISO);
  const [rows, topProducts, daily] = await Promise.all([
    db.getSalesOrdersForReport(prevFrom, toISO),
    db.getTopProductsForReport(fromISO, toISO),
    db.getDailySalesForReport(fromISO, toISO),
  ]);
  const base = aggregateSalesReport(rows, { from: fromISO, to: toISO, prevFrom, prevTo });
  return { ...base, topProducts, daily };
}
