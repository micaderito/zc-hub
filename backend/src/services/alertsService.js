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

/** Map<sku, {packId, name, unitCount, mode}> a partir de listPacks(). */
export function buildSkuPackIndex(packs) {
  const map = new Map();
  for (const pack of packs || []) {
    for (const sku of pack.skus || []) {
      map.set(sku, { packId: pack.id, name: pack.name, unitCount: pack.unitCount, mode: pack.mode });
    }
  }
  return map;
}

/**
 * Cantidad sugerida a pedir, en packs cuando el SKU tiene uno y en unidades sueltas si no. Es un
 * default editable, no un cálculo que la app imponga: unidades faltantes = `max(umbral*2 - stock, 1)`,
 * y de ahí `packs = ceil(faltante / unitCount)` si hay pack.
 */
export function computeSuggestedQty({ threshold, stockEffective, pack }) {
  const shortfall = Math.max(threshold * 2 - (stockEffective ?? 0), 1);
  if (pack) return { unit: 'packs', qty: Math.ceil(shortfall / pack.unitCount) };
  return { unit: 'unidades', qty: shortfall };
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
 * el stock de hoy (para decidir Sigue bajo / Sin stock / Ya repuesto) y con el pack (para que el
 * front agrupe y sume packs).
 */
export async function getRestockList({ period = 'last-order' } = {}) {
  let since = null;
  if (period === '30d') since = new Date(Date.now() - THIRTY_DAYS_MS).toISOString();
  else if (period === 'last-order') since = await getRestockCutoff();
  // period === 'all' (o cualquier otro valor): since queda null → todo el historial.

  const [candidates, packs, snap] = await Promise.all([
    listRestockCandidates(since),
    listPacks(),
    getAnalysisSnapshot(),
  ]);
  const stockBySku = buildStockBySku(snap?.data);
  const packBySku = buildSkuPackIndex(packs);

  const rows = candidates.map((c) => {
    const entry = stockBySku.get(c.sku);
    const effective = effectiveStock(entry);
    const pack = packBySku.get(c.sku) || null;
    const state = effective == null ? 'unknown'
      : effective <= 0 ? 'out'
      : effective <= c.threshold ? 'still-low'
      : 'restocked';
    return {
      sku: c.sku,
      productLabel: c.productLabel,
      firstTriggeredAt: c.firstTriggeredAt,
      timesTriggered: c.timesTriggered,
      threshold: c.threshold,
      stockMl: entry?.ml ?? null,
      stockTn: entry?.tn ?? null,
      stockEffective: effective,
      state,
      pack,
      suggested: computeSuggestedQty({ threshold: c.threshold, stockEffective: effective ?? 0, pack }),
    };
  });

  return { rows, cutoff: since };
}

/** "Marcar pedido como hecho": cierra el período desde ahora. No borra reglas ni notificaciones. */
export async function closeRestockPeriod() {
  return setRestockCutoff(new Date().toISOString());
}
