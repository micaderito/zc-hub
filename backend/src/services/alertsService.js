/**
 * Alertas de stock bajo. La usuaria elige a mano qué SKU vigilar y con qué umbral (nunca hay
 * default global, ver CLAUDE.md). Se dispara con `min(stock ML, stock TN)`: como el hub espeja el
 * stock, casi siempre son iguales; si difieren, manda el canal más bajo. Si el SKU solo existe en
 * un canal, ese canal es el valor; si no existe en ninguno, la regla no se evalúa (no se inventa
 * un 0 con un GET extra).
 *
 * `evaluateStockAlerts` se engancha en `storeSnapshot()` de conflictsService.js (fire-and-forget,
 * ver ahí el porqué): cada vez que el snapshot cambia -venta, edición manual, reconcile- las reglas
 * se re-evalúan contra las filas nuevas. También se llama a mano tras crear/editar una regla, para
 * que dispare en la primera pasada si el producto ya estaba bajo el umbral.
 */

import {
  listStockAlerts, setStockAlertState, insertStockNotification,
  listStockNotifications, countUnreadNotifications,
  getRestockCutoff, setRestockCutoff, listRestockCandidates,
  listPacks, getAnalysisSnapshot,
  listRestockOverrides, setRestockOverride, clearRestockOverrides,
  listRestockDismissed, setRestockDismissed, clearRestockDismissed,
  getDepositoStockBySku,
} from '../db.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Map<sku, {ml, tn}> con el stock mínimo por canal, recorriendo las filas crudas del snapshot. */
export function buildStockBySku(snapshotData) {
  const map = new Map();
  const upd = (sku, channel, stock) => {
    if (!sku) return;
    const val = Number.isFinite(stock) ? Number(stock) : null;
    if (val == null) return;
    const entry = map.get(sku) || { ml: null, tn: null };
    entry[channel] = entry[channel] == null ? val : Math.min(entry[channel], val);
    map.set(sku, entry);
  };
  for (const r of snapshotData?.mlRows || []) upd(r.sku, 'ml', r.stock);
  for (const r of snapshotData?.tnRows || []) upd(r.sku, 'tn', r.stock);
  return map;
}

/** min(ML, TN); si falta uno de los dos, vale el otro; `null` si el SKU no está en ninguno. */
export function effectiveStock(entry) {
  if (!entry) return null;
  const { ml, tn } = entry;
  if (ml == null && tn == null) return null;
  if (ml == null) return tn;
  if (tn == null) return ml;
  return Math.min(ml, tn);
}

/** Map<sku, {packId, name, sku, unitCount, mode, modelCount}> a partir de listPacks(). `modelCount` es el total de modelos del pack (no solo los que hoy están en "Para reponer"). */
export function buildSkuPackIndex(packs) {
  const map = new Map();
  for (const pack of packs || []) {
    const modelCount = (pack.skus || []).length;
    for (const memberSku of pack.skus || []) {
      map.set(memberSku, { packId: pack.id, name: pack.name, sku: pack.sku ?? null, unitCount: pack.unitCount, mode: pack.mode, modelCount });
    }
  }
  return map;
}

/** Unidades que faltan para llegar al umbral de un SKU (nunca menos de 1). */
export function computeShortfall(threshold, stockEffective) {
  return Math.max(threshold - (stockEffective ?? 0), 1);
}

/** Cantidad sugerida a pedir para un SKU sin pack: unidades sueltas. Default editable (ver CLAUDE.md). */
export function computeSuggestedQty({ threshold, stockEffective }) {
  return { unit: 'unidades', qty: computeShortfall(threshold, stockEffective) };
}

/**
 * Cantidad de packs sugerida para cubrir TODO el pack de una: se toma el mayor faltante entre los
 * SKUs del pack que dispararon alerta —el de menor stock manda, porque pedir de más para ese
 * modelo también cubre a los demás— y se divide por cuántas unidades de ESE modelo trae cada pack.
 *
 * Esas unidades por modelo son `floor(unitCount / modelCount)`: un pack surtido reparte sus
 * `unitCount` unidades entre TODOS los modelos del pack (no solo los que hoy están bajos), a partes
 * iguales — un pack de 8 con 3 modelos trae ~2,6 de cada uno, así que se cuentan 2 (piso, nunca
 * menos de 1) para no sobreestimar. Con `modelCount === unitCount` (un modelo por unidad) da 1, y
 * con un pack `single` (un solo modelo) da `unitCount` — mismo cálculo para los dos `mode`.
 */
export function computePackSuggestedQty(members, pack) {
  if (!pack || !members?.length) return null;
  const maxShortfall = Math.max(...members.map((m) => computeShortfall(m.threshold, m.stockEffective)));
  const unitsPerModel = Math.max(1, Math.floor(pack.unitCount / (pack.modelCount || 1)));
  return { unit: 'packs', qty: Math.max(1, Math.ceil(maxShortfall / unitsPerModel)) };
}

/**
 * Evalúa todas las reglas contra un snapshot crudo ({ mlRows, tnRows }). Con histéresis: solo
 * inserta notificación en la transición ok→triggered; mientras siga bajo el umbral no repite, y al
 * subir estrictamente por encima vuelve a 'ok' sin avisar. `muted_until` vigente actualiza el
 * estado igual, pero no inserta notificación.
 */
export async function evaluateStockAlerts(snapshotData) {
  const rules = await listStockAlerts();
  if (!rules.length) return;
  const stockBySku = buildStockBySku(snapshotData);
  const now = Date.now();

  for (const rule of rules) {
    const entry = stockBySku.get(rule.sku);
    const effective = effectiveStock(entry);
    if (effective == null) continue;

    const triggered = effective <= rule.threshold;
    const muted = !!(rule.mutedUntil && new Date(rule.mutedUntil).getTime() > now);

    if (triggered && rule.state !== 'triggered') {
      const flipped = await setStockAlertState(rule.sku, 'triggered', { expectedState: rule.state });
      if (flipped && !muted) {
        await insertStockNotification({
          sku: rule.sku,
          productLabel: rule.productLabel,
          threshold: rule.threshold,
          stockMl: entry?.ml ?? null,
          stockTn: entry?.tn ?? null,
          stockEffective: effective,
        });
      }
    } else if (!triggered && rule.state === 'triggered') {
      await setStockAlertState(rule.sku, 'ok', { expectedState: 'triggered' });
    }
  }
}

/** Evalúa contra el snapshot vivo (la mejor foto que hay sin gastar un GET extra). */
export async function evaluateStockAlertsNow() {
  const snap = await getAnalysisSnapshot();
  if (!snap?.data) return;
  await evaluateStockAlerts(snap.data);
}

/** Reglas + stock de hoy + pack, para la tabla de la pestaña Reglas. */
export async function getRulesWithStock() {
  const [rules, packs, snap] = await Promise.all([listStockAlerts(), listPacks(), getAnalysisSnapshot()]);
  const stockBySku = buildStockBySku(snap?.data);
  const packBySku = buildSkuPackIndex(packs);
  return rules.map((rule) => {
    const entry = stockBySku.get(rule.sku);
    return {
      ...rule,
      stockMl: entry?.ml ?? null,
      stockTn: entry?.tn ?? null,
      stockEffective: effectiveStock(entry),
      pack: packBySku.get(rule.sku) || null,
    };
  });
}

/**
 * Productos matcheados (mismo SKU en ML y TN — el mismo universo que "Vigilar producto nuevo" en
 * la pestaña Reglas) que todavía no tienen una regla de alerta. Para la pestaña "Sin alertas".
 */
export async function getUnwatchedProducts() {
  const [rules, packs, snap] = await Promise.all([listStockAlerts(), listPacks(), getAnalysisSnapshot()]);
  const withRule = new Set(rules.map((r) => r.sku));
  const stockBySku = buildStockBySku(snap?.data);
  const packBySku = buildSkuPackIndex(packs);

  const mlBySku = new Map();
  for (const r of snap?.data?.mlRows || []) {
    if (r.sku && !mlBySku.has(r.sku)) mlBySku.set(r.sku, r);
  }
  const tnSkus = new Set((snap?.data?.tnRows || []).map((r) => r.sku).filter(Boolean));

  const products = [];
  for (const [sku, r] of mlBySku) {
    if (withRule.has(sku) || !tnSkus.has(sku)) continue;
    const entry = stockBySku.get(sku);
    products.push({
      sku,
      productLabel: r.variationName ? `${r.title} (${r.variationName})` : r.title,
      thumbnail: r.thumbnail ?? null,
      stockMl: entry?.ml ?? null,
      stockTn: entry?.tn ?? null,
      stockEffective: effectiveStock(entry),
      pack: packBySku.get(sku) || null,
    });
  }
  return products.sort((a, b) => (a.productLabel || a.sku).localeCompare(b.productLabel || b.sku, 'es'));
}

/** Bandeja de notificaciones (pestaña Notificaciones + cajón lateral) con el contador de no leídas. */
export async function getNotificationsInbox({ unreadOnly = false, limit = 50, offset = 0 } = {}) {
  const [{ rows, total }, unreadCount] = await Promise.all([
    listStockNotifications({ unreadOnly, limit, offset }),
    countUnreadNotifications(),
  ]);
  return { notifications: rows, total, unreadCount };
}

/**
 * Lista "Para reponer": agrupa stock_notifications por SKU desde el corte del período, cruzado con
 * el stock de hoy (para decidir Sigue bajo / Sin stock / Ya repuesto), con el pack (para que el
 * front agrupe), con los ajustes manuales guardados (restock_order_overrides), con el stock del
 * Depósito Marañón (para saber si ya hay unidades a mano antes de pedirle más al proveedor) y con
 * los descartes manuales (restock_dismissed — ver más abajo).
 *
 * La sugerencia se calcula distinto según haya pack o no (ver computeSuggestedQty/
 * computePackSuggestedQty): un SKU sin pack sugiere unidades sueltas; un SKU CON pack no trae
 * sugerencia propia (queda vacía, editable a mano para un pedido puntual de ese modelo) — la
 * sugerencia real es la del PACK completo, repetida en `pack.suggestedPacks` de cada fila que
 * pertenece a ese pack, para que agrupar por pack en el front sea trivial.
 */
export async function getRestockList({ period = 'last-order' } = {}) {
  let since = null;
  if (period === '30d') since = new Date(Date.now() - THIRTY_DAYS_MS).toISOString();
  else if (period === 'last-order') since = await getRestockCutoff();
  // period === 'all' (o cualquier otro valor): since queda null → todo el historial.

  const [allCandidates, packs, snap, overrides, dismissed, depositoBySku] = await Promise.all([
    listRestockCandidates(since),
    listPacks(),
    getAnalysisSnapshot(),
    listRestockOverrides(),
    listRestockDismissed(),
    getDepositoStockBySku(),
  ]);
  const stockBySku = buildStockBySku(snap?.data);
  const packBySku = buildSkuPackIndex(packs);

  // Un SKU descartado (ya repuesto, sacado a mano del pedido) no se muestra salvo que haya vuelto
  // a disparar una alerta NUEVA después del descarte — así un yo-yo de stock no lo esconde para
  // siempre.
  const candidates = allCandidates.filter((c) => {
    const dismissedAt = dismissed.get(c.sku);
    if (!dismissedAt) return true;
    return new Date(c.lastTriggeredAt).getTime() > new Date(dismissedAt).getTime();
  });

  const base = candidates.map((c) => {
    const entry = stockBySku.get(c.sku);
    const effective = effectiveStock(entry);
    const pack = packBySku.get(c.sku) || null;
    const state = effective == null ? 'unknown'
      : effective <= 0 ? 'out'
      : effective <= c.threshold ? 'still-low'
      : 'restocked';
    return { c, entry, effective, pack, state };
  });

  // Un solo faltante por pack: el mayor entre los SKUs del pack que están en esta lista.
  const packInfoById = new Map();
  const packMembersById = new Map();
  for (const { c, effective, pack } of base) {
    if (!pack) continue;
    packInfoById.set(pack.packId, pack);
    const members = packMembersById.get(pack.packId) || [];
    members.push({ threshold: c.threshold, stockEffective: effective ?? 0 });
    packMembersById.set(pack.packId, members);
  }
  const packSuggestedById = new Map();
  for (const [packId, pack] of packInfoById) {
    const override = overrides.get(`pack:${packId}`);
    packSuggestedById.set(
      packId,
      override != null ? { unit: 'packs', qty: override } : computePackSuggestedQty(packMembersById.get(packId), pack)
    );
  }

  const rows = base.map(({ c, entry, effective, pack, state }) => {
    const skuOverride = overrides.get(`sku:${c.sku}`);
    const suggested = pack
      ? (skuOverride != null ? { unit: 'unidades', qty: skuOverride } : null)
      : (skuOverride != null ? { unit: 'unidades', qty: skuOverride } : computeSuggestedQty({ threshold: c.threshold, stockEffective: effective ?? 0 }));
    return {
      sku: c.sku,
      productLabel: c.productLabel,
      firstTriggeredAt: c.firstTriggeredAt,
      timesTriggered: c.timesTriggered,
      threshold: c.threshold,
      stockMl: entry?.ml ?? null,
      stockTn: entry?.tn ?? null,
      stockEffective: effective,
      depositoStock: depositoBySku.get(c.sku) ?? null,
      state,
      pack: pack ? { ...pack, suggestedPacks: packSuggestedById.get(pack.packId) } : null,
      suggested,
    };
  });

  return { rows, cutoff: since };
}

/** Guarda el ajuste manual de "a pedir" para un SKU o un pack (ver restock_order_overrides). */
export async function saveRestockOverride({ targetType, targetId, qty }) {
  return setRestockOverride(targetType, targetId, qty);
}

/**
 * Descarta (o restaura) una fila de "Para reponer" a mano — típicamente porque ya se repuso y no
 * se la quiere en el pedido en curso (ver restock_dismissed en db.js: vuelve sola si el SKU
 * dispara otra alerta después del descarte).
 */
export async function setRestockRowDismissed(sku, dismissed) {
  return setRestockDismissed(sku, dismissed);
}

/**
 * "Marcar pedido como hecho": cierra el período desde ahora y limpia los ajustes manuales y los
 * descartes — son del pedido que se acaba de hacer, no una config permanente. No borra reglas ni
 * notificaciones.
 */
export async function closeRestockPeriod() {
  await clearRestockOverrides();
  await clearRestockDismissed();
  return setRestockCutoff(new Date().toISOString());
}
