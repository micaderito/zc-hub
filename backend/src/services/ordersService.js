/**
 * Pedidos al proveedor (página /pedidos). Ver CLAUDE.md → "Pedidos al proveedor" y
 * docs/plans/2026-10-08-pedidos-proveedor-design.md.
 *
 * Las alertas SUGIEREN, la usuaria decide: el catálogo (`getCatalog`) muestra cada unidad de compra
 * —siempre un pack: el pack del hub, o el bulto de Precios para un SKU sin pack— con su stock, el
 * depósito, la alerta, el último pedido y lo que ya está en camino, y nada entra solo al pedido.
 *
 * Los helpers puros (resolución de código/precio, sugerencia, totales, duplicado) se exportan para
 * testearlos sin base de datos; el resto es pegamento con db.js.
 */
import {
  listPacks, getAnalysisSnapshot, getAllProductCosts, getSkuCodeMap, getPackCodeMap,
  getSupplierCodeDescriptions, getDepositoStockBySku, listStockAlerts,
  listSupplierOrders, getSupplierOrder, createSupplierOrder, updateSupplierOrderDraft,
  placeSupplierOrder, receiveSupplierOrder, deleteSupplierOrderDraft,
  getOrderDefaults, setOrderDefaults, setRestockCutoff,
} from '../db.js';
import { buildStockBySku, effectiveStock, computeShortfall, getRestockList } from './alertsService.js';

const ACTIVE_ALERT_STATES = new Set(['still-low', 'out']);
const ORDER_STATUSES = ['borrador', 'pendiente', 'recibido'];
const LINE_KINDS = new Set(['pack', 'sku', 'free']);
const LINE_ORIGINS = new Set(['alerta', 'manual', 'copia', 'libre']);

export const unitKey = (kind, id) => `${kind}:${id}`;

/** Precio de lista por unidad de un costo de Precios (antes de descuentos), o `null` si no hay bulto cargado. */
export function listUnitPrice(cost) {
  if (!cost || !(cost.bulkPrice > 0) || !(cost.bulkQty > 0)) return null;
  return cost.bulkPrice / cost.bulkQty;
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Precio de lista de UN pack: el precio por unidad del primer modelo con bulto cargado en Precios ×
 * las unidades del pack. (Cuando el pack tiene código propio, `applyListCosts` vuelca el mismo costo
 * a todos sus modelos, así que da igual cuál se tome.)
 */
export function packListPrice(pack, costsBySku) {
  for (const sku of pack.skus || []) {
    const unit = listUnitPrice(costsBySku.get(sku));
    if (unit != null) return round2(unit * pack.unitCount);
  }
  return null;
}

/**
 * Código del proveedor para un pack: el mapeado en Precios (`pack_code_map`), si no el SKU propio
 * del pack (`product_packs.sku`, que es el código que el proveedor le pone al pack armado), y si el
 * pack es de un solo modelo, el código mapeado de ese modelo.
 */
export function resolvePackCode(pack, packCodeById, skuCodeBySku) {
  return packCodeById.get(pack.id)
    ?? pack.sku
    ?? ((pack.skus || []).length === 1 ? skuCodeBySku.get(pack.skus[0]) : null)
    ?? null;
}

/** Nombre legible de un SKU a partir del snapshot (título de ML con variante, si no el de TN). */
function buildLabelBySku(snapshotData) {
  const map = new Map();
  for (const r of snapshotData?.mlRows || []) {
    if (r.sku && !map.has(r.sku)) map.set(r.sku, r.variationName ? `${r.title} (${r.variationName})` : r.title);
  }
  for (const r of snapshotData?.tnRows || []) {
    if (r.sku && !map.has(r.sku)) map.set(r.sku, [r.productName, r.variantName].filter(Boolean).join(' · ') || r.sku);
  }
  return map;
}

/**
 * Packs sugeridos para una unidad de compra: el modelo con alerta activa que más falta para llegar
 * al umbral manda, dividido por cuántas unidades de ESE modelo trae cada pack (mismo criterio que
 * computePackSuggestedQty en alertsService). `null` si ningún modelo tiene alerta activa.
 */
export function suggestPacks(members, unitsPerPack, modelCount) {
  const active = members.filter((m) => ACTIVE_ALERT_STATES.has(m.alertState));
  if (!active.length) return null;
  const maxShortfall = Math.max(...active.map((m) => computeShortfall(m.threshold, m.stockEffective)));
  const unitsPerModel = Math.max(1, Math.floor(unitsPerPack / Math.max(1, modelCount)));
  return Math.max(1, Math.ceil(maxShortfall / unitsPerModel));
}

/**
 * Último pedido y pedido en camino por unidad de compra, a partir de los pedidos (más nuevos
 * primero). Los borradores no cuentan: todavía no se pidieron.
 */
export function buildOrderHistoryIndex(orders) {
  const last = new Map();
  const pending = new Map();
  for (const o of orders) {
    if (o.status === 'borrador') continue;
    for (const l of o.lines) {
      const key = l.kind === 'pack' ? unitKey('pack', l.packId) : l.kind === 'sku' ? unitKey('sku', l.sku) : null;
      if (!key) continue;
      if (!last.has(key)) last.set(key, { orderId: o.id, orderName: o.name, date: o.orderedAt ?? o.createdAt, qty: l.qty });
      if (o.status === 'pendiente' && !pending.has(key)) pending.set(key, { orderId: o.id, orderName: o.name });
    }
  }
  return { last, pending };
}

/**
 * Arma el catálogo de unidades de compra. PURO: entra todo lo leído de la base y sale la lista.
 * Cada pack del hub es una unidad; cada SKU del snapshot que no está en ningún pack es otra (su
 * "pack" es el bulto cargado en Precios, 1 unidad si no hay).
 */
export function buildCatalog({
  packs, snapshotData, restockRows, rules, costs, skuCodeMap, packCodeMap, codeDescriptions, depositoBySku, orders,
}) {
  const stockBySku = buildStockBySku(snapshotData);
  const labelBySku = buildLabelBySku(snapshotData);
  const costsBySku = new Map(costs.map((c) => [c.sku, c]));
  const skuCodeBySku = new Map(skuCodeMap.map((m) => [m.sku, m.code]));
  const packCodeById = new Map(packCodeMap.map((m) => [m.packId, m.code]));
  const restockBySku = new Map(restockRows.map((r) => [r.sku, r]));
  const ruleBySku = new Map(rules.map((r) => [r.sku, r]));
  const { last, pending } = buildOrderHistoryIndex(orders);

  const member = (sku) => {
    const entry = stockBySku.get(sku);
    const restock = restockBySku.get(sku);
    const rule = ruleBySku.get(sku);
    return {
      sku,
      label: labelBySku.get(sku) ?? rule?.productLabel ?? restock?.productLabel ?? sku,
      stockMl: entry?.ml ?? null,
      stockTn: entry?.tn ?? null,
      stockEffective: effectiveStock(entry),
      depositoStock: depositoBySku.get(sku) ?? null,
      threshold: rule?.threshold ?? restock?.threshold ?? null,
      // Estado de "Para reponer" desde el último pedido; sin fila, solo se sabe si tiene regla.
      alertState: restock?.state ?? (rule ? 'watching' : null),
    };
  };

  const finish = (unit, members, modelCount) => {
    const key = unit.kind === 'pack' ? unitKey('pack', unit.packId) : unitKey('sku', unit.sku);
    const depositoTotal = members.reduce((a, m) => a + (m.depositoStock ?? 0), 0);
    return {
      key,
      ...unit,
      description: (unit.code && codeDescriptions.get(unit.code)) || unit.name,
      members,
      alerted: members.some((m) => ACTIVE_ALERT_STATES.has(m.alertState)),
      suggestedQty: suggestPacks(members, unit.unitsPerPack, modelCount),
      depositoStock: depositoTotal || null,
      lastOrder: last.get(key) ?? null,
      pendingOrder: pending.get(key) ?? null,
    };
  };

  const units = [];
  const inPack = new Set();
  for (const pack of packs) {
    for (const s of pack.skus || []) inPack.add(s);
    const members = (pack.skus || []).map(member);
    units.push(finish({
      kind: 'pack',
      packId: pack.id,
      sku: null,
      name: pack.name,
      code: resolvePackCode(pack, packCodeById, skuCodeBySku),
      unitsPerPack: pack.unitCount,
      mode: pack.mode,
      price: packListPrice(pack, costsBySku),
    }, members, members.length));
  }

  const looseSkus = new Set();
  for (const r of snapshotData?.mlRows || []) if (r.sku && !inPack.has(r.sku)) looseSkus.add(r.sku);
  for (const r of snapshotData?.tnRows || []) if (r.sku && !inPack.has(r.sku)) looseSkus.add(r.sku);
  for (const sku of looseSkus) {
    const cost = costsBySku.get(sku);
    const m = member(sku);
    units.push(finish({
      kind: 'sku',
      packId: null,
      sku,
      name: m.label,
      code: skuCodeBySku.get(sku) ?? null,
      unitsPerPack: cost?.bulkQty > 0 ? cost.bulkQty : 1,
      mode: 'bulk',
      price: cost?.bulkPrice > 0 && cost?.bulkQty > 0 ? round2(cost.bulkPrice) : null,
    }, [m], 1));
  }

  return units.sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

/**
 * Totales de un pedido: subtotal de lista (solo líneas con precio), el primer descuento sobre el
 * subtotal y el segundo sobre lo que queda (25% y después 5% sobre el total, por defecto).
 */
export function computeOrderTotals(order) {
  const lines = order.lines || [];
  const priced = lines.filter((l) => l.unitPrice != null);
  const subtotal = round2(priced.reduce((a, l) => a + l.qty * l.unitPrice, 0));
  const afterDiscount1 = round2(subtotal * (1 - (order.discount1 || 0) / 100));
  const total = round2(afterDiscount1 * (1 - (order.discount2 || 0) / 100));
  return {
    lineCount: lines.length,
    packs: lines.reduce((a, l) => a + l.qty, 0),
    subtotal,
    discount1Amount: round2(subtotal - afterDiscount1),
    discount2Amount: round2(afterDiscount1 - total),
    total,
    missingPrices: lines.length - priced.length,
  };
}

/** Precio actual de Precios por clave de unidad (`pack:N` / `sku:X`). */
export function buildPriceIndex(packs, costs) {
  const costsBySku = new Map(costs.map((c) => [c.sku, c]));
  const map = new Map();
  for (const pack of packs) map.set(unitKey('pack', pack.id), packListPrice(pack, costsBySku));
  for (const c of costs) {
    if (c.bulkPrice > 0 && c.bulkQty > 0) map.set(unitKey('sku', c.sku), round2(c.bulkPrice));
  }
  return map;
}

/** Las líneas que siguen a Precios (`priceSource: 'precios'`) toman el precio de hoy; las editadas a mano no se tocan. */
export function refreshLinePrices(lines, priceIndex) {
  return lines.map((l) => {
    if (l.kind === 'free' || l.priceSource !== 'precios') return l;
    const key = l.kind === 'pack' ? unitKey('pack', l.packId) : unitKey('sku', l.sku);
    return { ...l, unitPrice: priceIndex.get(key) ?? null };
  });
}

/**
 * Líneas para un pedido nuevo a partir de otro. `mode: 'missing'` copia solo lo que no llegó (con
 * la cantidad faltante); `'all'` copia todo. Se pierde lo recibido y el origen pasa a 'copia'.
 */
export function buildDuplicateLines(order, mode = 'all') {
  const out = [];
  for (const l of order.lines || []) {
    let qty = l.qty;
    if (mode === 'missing') {
      qty = l.qty - (l.receivedQty ?? 0);
      if (qty <= 0) continue;
    }
    out.push({
      kind: l.kind, packId: l.packId, sku: l.sku, code: l.code, description: l.description, detail: l.detail,
      qty, unitPrice: l.unitPrice, priceSource: l.priceSource, unitsPerPack: l.unitsPerPack,
      origin: l.kind === 'free' ? 'libre' : 'copia', receivedQty: null,
    });
  }
  return out;
}

const pct = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
};

/**
 * Valida el cuerpo de un PUT de borrador. Devuelve `{ value }` normalizado o `{ error }`.
 */
export function sanitizeOrderInput(body) {
  const name = String(body?.name ?? '').trim();
  if (!name) return { error: 'El pedido necesita un nombre' };
  const discount1 = pct(body?.discount1);
  const discount2 = pct(body?.discount2);
  if (discount1 == null || discount2 == null) return { error: 'Los descuentos tienen que estar entre 0 y 100' };
  if (!Array.isArray(body?.lines)) return { error: 'lines tiene que ser una lista' };
  const lines = [];
  for (const raw of body.lines) {
    const kind = raw?.kind;
    if (!LINE_KINDS.has(kind)) return { error: `Tipo de línea inválido: ${kind}` };
    const qty = Number(raw.qty);
    if (!Number.isInteger(qty) || qty < 1) return { error: 'Cada línea tiene que pedir al menos 1 pack' };
    if (kind === 'pack' && !Number.isInteger(Number(raw.packId))) return { error: 'Línea de pack sin packId' };
    if (kind === 'sku' && !String(raw.sku ?? '').trim()) return { error: 'Línea de producto sin SKU' };
    const price = raw.unitPrice === '' || raw.unitPrice == null ? null : Number(raw.unitPrice);
    if (price != null && (!Number.isFinite(price) || price < 0)) return { error: 'Precio inválido' };
    lines.push({
      kind,
      packId: kind === 'pack' ? Number(raw.packId) : null,
      sku: kind === 'sku' ? String(raw.sku).trim() : null,
      code: String(raw.code ?? '').trim().slice(0, 128),
      description: String(raw.description ?? '').trim().slice(0, 512),
      detail: String(raw.detail ?? '').trim().slice(0, 1024),
      qty,
      unitPrice: price,
      // Un ítem libre siempre es a mano: no hay nada en Precios que seguir.
      priceSource: kind === 'free' ? 'manual' : raw.priceSource === 'manual' ? 'manual' : 'precios',
      unitsPerPack: Number.isInteger(Number(raw.unitsPerPack)) && Number(raw.unitsPerPack) > 0 ? Number(raw.unitsPerPack) : null,
      origin: LINE_ORIGINS.has(raw.origin) ? raw.origin : kind === 'free' ? 'libre' : 'manual',
    });
  }
  return { value: { name: name.slice(0, 256), note: String(body?.note ?? '').slice(0, 4000), discount1, discount2, lines } };
}

// ── Pegamento con la base ─────────────────────────────────────────────────────

export async function getCatalog() {
  const [packs, snap, restock, rules, costs, skuCodeMap, packCodeMap, codeDescriptions, depositoBySku, orders] = await Promise.all([
    listPacks(), getAnalysisSnapshot(), getRestockList({ period: 'last-order' }), listStockAlerts(), getAllProductCosts(),
    getSkuCodeMap(), getPackCodeMap(), getSupplierCodeDescriptions(), getDepositoStockBySku(), listSupplierOrders(),
  ]);
  return buildCatalog({
    packs, snapshotData: snap?.data, restockRows: restock.rows, rules, costs, skuCodeMap, packCodeMap,
    codeDescriptions, depositoBySku, orders,
  });
}

const withTotals = (order) => ({ ...order, totals: computeOrderTotals(order) });

export async function listOrders({ status } = {}) {
  const orders = await listSupplierOrders({ status: ORDER_STATUSES.includes(status) ? status : undefined });
  return orders.map(withTotals);
}

/** Un pedido; si es borrador, las líneas "de Precios" se actualizan al precio de hoy. */
export async function getOrder(id) {
  const order = await getSupplierOrder(id);
  if (!order) return null;
  if (order.status !== 'borrador') return withTotals(order);
  const [packs, costs] = await Promise.all([listPacks(), getAllProductCosts()]);
  return withTotals({ ...order, lines: refreshLinePrices(order.lines, buildPriceIndex(packs, costs)) });
}

export async function createOrder({ name } = {}) {
  const defaults = await getOrderDefaults();
  const order = await createSupplierOrder({
    name: String(name ?? '').trim() || 'Pedido nuevo', discount1: defaults.discount1, discount2: defaults.discount2,
  });
  return order && withTotals(order);
}

export async function saveDraft(id, value) {
  const r = await updateSupplierOrderDraft(id, value);
  return typeof r === 'string' || !r ? r : withTotals(r);
}

/** Borrador → pendiente. Corre el corte de alertas, como el viejo "Marcar pedido como hecho". */
export async function placeOrder(id) {
  const ok = await placeSupplierOrder(id);
  if (ok) await setRestockCutoff(new Date().toISOString());
  return ok;
}

export async function receiveOrder(id, received, opts) {
  const r = await receiveSupplierOrder(id, received, opts);
  return typeof r === 'string' || !r ? r : withTotals(r);
}

/**
 * Pedido nuevo a partir de otro. `status: 'pendiente'` es "Repetir y marcar como pedido" (también
 * corre el corte de alertas). Las líneas que siguen a Precios toman el precio de hoy.
 */
export async function duplicateOrder(id, { mode = 'all', status = 'borrador' } = {}) {
  const src = await getSupplierOrder(id);
  if (!src) return null;
  const [packs, costs] = await Promise.all([listPacks(), getAllProductCosts()]);
  const lines = refreshLinePrices(buildDuplicateLines(src, mode), buildPriceIndex(packs, costs));
  const created = await createSupplierOrder({
    name: mode === 'missing' ? `Faltantes de ${src.name}` : `${src.name} (copia)`,
    status, discount1: src.discount1, discount2: src.discount2, note: src.note, basedOnId: src.id, lines,
  });
  if (created && status === 'pendiente') await setRestockCutoff(new Date().toISOString());
  return created && withTotals(created);
}

export async function deleteDraft(id) {
  return deleteSupplierOrderDraft(id);
}

export async function getSettings() {
  return getOrderDefaults();
}

export async function saveSettings(body) {
  const discount1 = pct(body?.discount1);
  const discount2 = pct(body?.discount2);
  if (discount1 == null || discount2 == null) return { error: 'Los descuentos tienen que estar entre 0 y 100' };
  await setOrderDefaults({ discount1, discount2 });
  return { value: { discount1, discount2 } };
}
