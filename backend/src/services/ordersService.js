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
  getOrderDefaults, setOrderDefaults, setRestockCutoff, listSuppliers, listProductSuppliers,
} from '../db.js';
import { buildStockBySku, effectiveStock, computeShortfall, getRestockList } from './alertsService.js';
import { buildDiscountContext, suppliersOf } from '../lib/discountResolver.js';

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

/**
 * Un producto puede tener un código por proveedor: a la fábrica va el del proveedor VIGENTE
 * (`product_costs.supplier_key`; en un pack, el del primer modelo que tenga uno). Sin vigente, o si
 * el vigente no tiene código, el primero que haya. Puro y testeable.
 */
export function pickVigenteCodes({ skuCodeMap = [], packCodeMap = [], costs = [], packs = [] }) {
  const vigenteBySku = new Map(costs.filter((c) => c.supplierKey).map((c) => [c.sku, c.supplierKey]));
  const pick = (rows, keyOf, vigenteOf) => {
    const byKey = new Map();
    for (const r of rows) {
      const k = keyOf(r);
      const cur = byKey.get(k);
      if (!cur || (r.supplier === vigenteOf(k) && cur.supplier !== vigenteOf(k))) byKey.set(k, r);
    }
    return [...byKey.values()];
  };
  const packVigente = new Map(packs.map((pk) => [pk.id, (pk.skus || []).map((s) => vigenteBySku.get(s)).find(Boolean) ?? null]));
  return {
    skuCodeMap: pick(skuCodeMap, (r) => r.sku, (sku) => vigenteBySku.get(sku) ?? null),
    packCodeMap: pick(packCodeMap, (r) => r.packId, (id) => packVigente.get(id) ?? null),
  };
}

/** Los mapeos de código de UN proveedor (el del pedido), a partir de los de todos. Puro. */
export function codesForSupplier({ skuCodeMap = [], packCodeMap = [] }, supplierKey) {
  return {
    skuCodeMap: skuCodeMap.filter((r) => r.supplier === supplierKey),
    packCodeMap: packCodeMap.filter((r) => r.supplier === supplierKey),
  };
}

/**
 * A qué proveedores se le compra una unidad de compra: la unión de los de sus modelos (una
 * asignación o un código mapeado al pack ya se los suma a todos), el vigente del primer modelo que
 * tenga uno primero. Puro.
 */
export function unitSuppliers(skus, ctx) {
  const out = [];
  for (const sku of skus) for (const k of suppliersOf(sku, ctx)) if (!out.includes(k)) out.push(k);
  const vigente = skus.map((sku) => ctx?.vigenteBySku.get(sku)).find(Boolean) ?? null;
  return { suppliers: vigente ? [vigente, ...out.filter((k) => k !== vigente)] : out, vigente };
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
 *
 * Con `supplierKey` (el proveedor del pedido) quedan solo las unidades que se le compran a ese
 * proveedor —según `discountCtx`: asignación en Precios, código mapeado o vigente— y las que no
 * tienen ningún proveedor (`suppliers: []`, el front las esconde detrás de un filtro). Los códigos
 * que entran ya tienen que ser los de ese proveedor (`codesForSupplier`); el SKU propio del pack
 * (`product_packs.sku`) solo vale si el pack no es de otro proveedor vigente.
 */
export function buildCatalog({
  packs, snapshotData, restockRows, rules, costs, skuCodeMap, packCodeMap, codeDescriptions, depositoBySku, orders,
  supplierKey = null, discountCtx = null,
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

  const finish = (unit, members, modelCount, suppliers) => {
    const key = unit.kind === 'pack' ? unitKey('pack', unit.packId) : unitKey('sku', unit.sku);
    const depositoTotal = members.reduce((a, m) => a + (m.depositoStock ?? 0), 0);
    return {
      key,
      ...unit,
      // Proveedores a los que se le compra (vigente primero) y el vigente, que es el que puso el
      // precio de Precios: si no es el del pedido, el front lo avisa.
      suppliers: suppliers.suppliers,
      priceSupplier: suppliers.vigente,
      description: (unit.code && codeDescriptions.get(unit.code)) || unit.name,
      members,
      alerted: members.some((m) => ACTIVE_ALERT_STATES.has(m.alertState)),
      suggestedQty: suggestPacks(members, unit.unitsPerPack, modelCount),
      depositoStock: depositoTotal || null,
      lastOrder: last.get(key) ?? null,
      pendingOrder: pending.get(key) ?? null,
    };
  };

  const belongs = (sup) => !supplierKey || sup.suppliers.length === 0 || sup.suppliers.includes(supplierKey);

  const units = [];
  const inPack = new Set();
  for (const pack of packs) {
    for (const s of pack.skus || []) inPack.add(s);
    const sup = unitSuppliers(pack.skus || [], discountCtx);
    if (!belongs(sup)) continue;
    const members = (pack.skus || []).map(member);
    const ownCodeOk = !supplierKey || !sup.vigente || sup.vigente === supplierKey;
    units.push(finish({
      kind: 'pack',
      packId: pack.id,
      sku: null,
      name: pack.name,
      code: resolvePackCode(ownCodeOk ? pack : { ...pack, sku: null }, packCodeById, skuCodeBySku),
      unitsPerPack: pack.unitCount,
      mode: pack.mode,
      price: packListPrice(pack, costsBySku),
    }, members, members.length, sup));
  }

  const looseSkus = new Set();
  for (const r of snapshotData?.mlRows || []) if (r.sku && !inPack.has(r.sku)) looseSkus.add(r.sku);
  for (const r of snapshotData?.tnRows || []) if (r.sku && !inPack.has(r.sku)) looseSkus.add(r.sku);
  for (const sku of looseSkus) {
    const sup = unitSuppliers([sku], discountCtx);
    if (!belongs(sup)) continue;
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
    }, [m], 1, sup));
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

/**
 * Catálogo del editor. Con `supplierKey` (el proveedor del pedido): solo lo que se le compra a ese
 * proveedor (+ lo que no tiene ninguno) y con SU código y descripción. Sin él, todo con el código
 * del proveedor vigente de cada producto.
 */
export async function getCatalog({ supplierKey = null } = {}) {
  const [packs, snap, restock, rules, costs, skuCodeMap, packCodeMap, codeDescriptions, depositoBySku, orders, suppliers, assignments] = await Promise.all([
    listPacks(), getAnalysisSnapshot(), getRestockList({ period: 'last-order' }), listStockAlerts(), getAllProductCosts(),
    getSkuCodeMap(null), getPackCodeMap(null), getSupplierCodeDescriptions(supplierKey), getDepositoStockBySku(), listSupplierOrders(),
    listSuppliers(), listProductSuppliers(),
  ]);
  const discountCtx = buildDiscountContext({ suppliers, assignments, packs, skuCodeMap, packCodeMap, costs });
  const codes = supplierKey
    ? codesForSupplier({ skuCodeMap, packCodeMap }, supplierKey)
    : pickVigenteCodes({ skuCodeMap, packCodeMap, costs, packs });
  return buildCatalog({
    packs, snapshotData: snap?.data, restockRows: restock.rows, rules, costs,
    skuCodeMap: codes.skuCodeMap, packCodeMap: codes.packCodeMap,
    codeDescriptions, depositoBySku, orders, supplierKey, discountCtx,
  });
}

/**
 * Proveedores para elegir al crear un pedido, cada uno con el descuento de su config default (el
 * que se precarga en el pedido) y todas sus configs (`profiles`, la default primero), para que el
 * editor del pedido deje elegir otra.
 */
export async function listOrderSuppliers() {
  return (await listSuppliers()).map((s) => {
    const def = s.profiles.find((p) => p.isDefault) ?? null;
    return {
      key: s.key,
      name: s.name,
      profileName: def?.name ?? null,
      discount1: def ? def.discount1 : null,
      discount2: def ? def.discount2 : null,
      profiles: s.profiles.map((p) => ({
        id: p.id, name: p.name, discount1: p.discount1, discount2: p.discount2, isDefault: p.isDefault,
      })),
    };
  });
}

/** Proveedor de un pedido nuevo cuando no se elige ninguno: Punto Cero, si no el primero. */
export const DEFAULT_ORDER_SUPPLIER = 'punto_cero';

const withTotals = (order) => ({ ...order, totals: computeOrderTotals(order) });

export async function listOrders({ status, supplierKey } = {}) {
  const orders = await listSupplierOrders({
    status: ORDER_STATUSES.includes(status) ? status : undefined,
    supplierKey: supplierKey ? String(supplierKey) : undefined,
  });
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

/**
 * Borrador vacío para un proveedor. Los descuentos se precargan con la config default de ese
 * proveedor (la misma cadena que usa Precios: el 1.º sobre la lista, el 2.º sobre lo que queda); sin
 * config, con los descuentos por defecto de Pedidos. Devuelve el pedido, `'unknown_supplier'` o `null`.
 */
export async function createOrder({ name, supplierKey } = {}) {
  const suppliers = await listOrderSuppliers();
  const key = supplierKey
    ? String(supplierKey)
    : (suppliers.find((s) => s.key === DEFAULT_ORDER_SUPPLIER) ?? suppliers[0])?.key ?? DEFAULT_ORDER_SUPPLIER;
  const supplier = suppliers.find((s) => s.key === key);
  if (supplierKey && !supplier) return 'unknown_supplier';
  const defaults = supplier?.discount1 != null ? supplier : await getOrderDefaults();
  const order = await createSupplierOrder({
    name: String(name ?? '').trim() || (supplier ? `Pedido a ${supplier.name}` : 'Pedido nuevo'),
    discount1: defaults.discount1, discount2: defaults.discount2, supplierKey: key,
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
    supplierKey: src.supplierKey ?? DEFAULT_ORDER_SUPPLIER,
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
