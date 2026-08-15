/**
 * Eco de las escrituras de stock que hace el hub.
 *
 * El historial ahora registra los cambios de stock de LOS DOS canales, no solo el que escribe el
 * hub: cuando refrescamos un ítem de ML o un producto de TN en el snapshot, comparamos el stock
 * viejo con el nuevo y cada diferencia se guarda como una línea del historial (ver
 * `recordStockDiff` en `conflictsService.js`). Eso es lo que permite ver el descuento que hizo la
 * plataforma por su cuenta al vender, o una edición hecha desde el panel de ML/TN.
 *
 * Pero ese mismo diff también vería los cambios que escribió el hub — que ya están en el historial,
 * anotados por el flujo que los hizo (venta, devolución, cambio manual). Registrarlos otra vez los
 * contaría dos veces. Por eso cada escritura propia deja un "eco": canal + ítem + el valor que
 * acabamos de escribir. Si un diff coincide con un eco, no se registra y el eco se consume.
 *
 * El eco se anota apenas se escribe (no cuando el parche del snapshot termina): el parche espera al
 * lock del snapshot —y a un crawl en curso, que tarda decenas de segundos—, y en esa ventana el
 * webhook `items`/`product/updated` del canal puede llegar primero y hacer el diff.
 *
 * Vence a los 2 minutos para que un eco que nunca se cruzó con su diff (porque el canal no avisó, o
 * porque el diff ya lo había visto) no tape un cambio externo real que más tarde deje el stock en
 * ese mismo valor.
 */

export const STOCK_ECHO_TTL_MS = 2 * 60_000;

/** key → { stock, at }. Solo memoria: si el proceso se reinicia, a lo sumo se registra un cambio de más. */
const echoes = new Map();

/** Clave de una variación de ML. `variationId` null/'' = el ítem entero (sin variaciones o todas). */
export function mlStockEchoKey(itemId, variationId) {
  const vid = variationId == null || variationId === '' ? '*' : String(variationId);
  return `ml:${itemId}:${vid}`;
}

/** Clave de una variante de TN. */
export function tnStockEchoKey(productId, variantId) {
  return `tn:${productId}:${variantId}`;
}

function purgeExpired(now) {
  for (const [k, v] of echoes) {
    if (now - v.at > STOCK_ECHO_TTL_MS) echoes.delete(k);
  }
}

/** Anota que el hub acaba de escribir `stock` en ese ítem/variante. */
export function rememberStockWrite(key, stock) {
  const now = Date.now();
  purgeExpired(now);
  echoes.set(key, { stock: Number(stock), at: now });
}

/**
 * ¿Este cambio de stock lo escribió el hub? Si sí, consume el eco y devuelve true.
 * Se prueba la clave exacta y la del ítem entero (una escritura sin variación las afecta a todas).
 */
export function consumeStockEcho(key, stock) {
  const now = Date.now();
  purgeExpired(now);
  const candidates = [key];
  const m = /^ml:([^:]+):/.exec(key);
  if (m) candidates.push(`ml:${m[1]}:*`);
  for (const k of candidates) {
    const echo = echoes.get(k);
    if (echo && echo.stock === Number(stock)) {
      echoes.delete(k);
      return true;
    }
  }
  return false;
}

export function __resetStockEchoesForTests() {
  echoes.clear();
}
