/**
 * Decide si una orden de ML cancelada puede restaurar stock automáticamente.
 *
 * El criterio es "¿la mercadería llegó a salir del depósito?":
 *  - Si el envío nunca se despachó (el comprador canceló antes), el stock nunca dejó de estar
 *    físicamente en la casa → restaurar automáticamente es correcto.
 *  - Si el envío ya salió (despachado, entregado, no entregado, volviendo al vendedor), la
 *    mercadería está en tránsito y el vendedor todavía NO la tiene → es una devolución y el stock
 *    solo se restaura cuando confirma manualmente que le llegó y en qué estado.
 *
 * Ojo con el default: la lista es de estados SEGUROS (nunca despachado), no de estados "de
 * devolución". Cualquier estado desconocido, o no poder consultar el envío, cae del lado
 * conservador (no restaurar). Preferimos una devolución pendiente de más —que la usuaria aprueba
 * y termina restaurando igual— antes que inventar stock que todavía no está en el depósito.
 */

/** Estados de envío en los que la mercadería todavía no salió del depósito del vendedor. */
const NEVER_SHIPPED_STATUSES = new Set([
  'pending',
  'handling',
  'ready_to_ship',
  'to_be_agreed',
  'not_specified',
  'cancelled',
  'canceled'
]);

/**
 * Subestados que implican que el paquete salió y está volviendo (o se perdió/dañó en el camino),
 * aunque el status principal diga otra cosa. Se chequean primero por eso.
 */
const RETURN_SUBSTATUS_RE = /return|not_deliver|delivery_failed|refused|rejected|stale|lost|damag|shipped|receiver_absent/i;

/**
 * @param {object|null} shipment - respuesta de GET /shipments/:id, o null si no se pudo obtener.
 * @returns {{ safe: boolean, reason: string }} safe=true solo si es seguro restaurar stock solo.
 */
export function isSafeToAutoRestore(shipment) {
  if (!shipment || typeof shipment !== 'object') {
    return { safe: false, reason: 'no se pudo obtener el envío' };
  }
  const status = String(shipment.status ?? '').trim().toLowerCase();
  const substatus = String(shipment.substatus ?? '').trim().toLowerCase();

  if (!status) {
    return { safe: false, reason: 'el envío no tiene status' };
  }
  if (substatus && RETURN_SUBSTATUS_RE.test(substatus)) {
    return { safe: false, reason: `envío ${status}/${substatus} (la mercadería salió)` };
  }
  if (NEVER_SHIPPED_STATUSES.has(status)) {
    return { safe: true, reason: `envío ${status}${substatus ? `/${substatus}` : ''} (nunca se despachó)` };
  }
  return { safe: false, reason: `envío ${status}${substatus ? `/${substatus}` : ''} (la mercadería salió)` };
}

/** Extrae el id de envío de una orden de ML (`shipping.id`), o null si la orden no tiene envío. */
export function getShipmentIdFromOrder(order) {
  const id = order?.shipping?.id ?? order?.shipping_id ?? null;
  if (id == null) return null;
  const s = String(id).trim();
  return s && s !== 'null' ? s : null;
}
