/**
 * Por qué se canceló una orden de ML, y si esa cancelación puede restaurar stock sola.
 *
 * ML no siempre devuelve la unidad a la publicación cuando cancela una orden. El caso claro es la
 * cancelación pedida por el vendedor: si la cancelaste vos —típicamente porque el producto no
 * estaba— la unidad no existe, ML deja su stock como está y sumarla en Tienda Nube desalinea los
 * dos canales (incidente 2026-08-11: TN quedó en 3, ML en 2, y el stock real era 2).
 *
 * Estas cancelaciones no se resuelven solas: quedan como devolución pendiente para que la usuaria
 * confirme. Además de no inventar stock, eso las hace visibles — el camino automático no dejaba
 * más rastro que una línea en el historial.
 */

/**
 * Normaliza el motivo de cancelación. ML lo manda en `cancel_detail`; en algunos flujos viene
 * dentro de `status_detail` como objeto (cuando es string es solo un código de estado, no un
 * motivo, y esta función devuelve null).
 * @returns {{ requestedBy: string|null, code: string|null, group: string|null, description: string|null }|null}
 */
export function getCancelDetail(order) {
  const raw = order?.cancel_detail
    ?? (order?.status_detail && typeof order.status_detail === 'object' ? order.status_detail : null);
  if (!raw || typeof raw !== 'object') return null;

  const norm = (v) => {
    const s = String(v ?? '').trim();
    return s ? s : null;
  };
  const detail = {
    requestedBy: norm(raw.requested_by ?? raw.requestedBy)?.toLowerCase() ?? null,
    code: norm(raw.code)?.toLowerCase() ?? null,
    group: norm(raw.group)?.toLowerCase() ?? null,
    description: norm(raw.description),
  };
  const hasSomething = detail.requestedBy || detail.code || detail.group || detail.description;
  return hasSomething ? detail : null;
}

/**
 * Motivos que dicen explícitamente que la unidad no está. Se chequean aparte de `requested_by`
 * porque no todos los payloads traen quién canceló, y "sin stock" ya es señal suficiente.
 */
const OUT_OF_STOCK_RE = /out.?of.?stock|stock.?out|sin.?stock|no.?stock|falta.?de.?stock/i;

/**
 * ¿Esta cancelación tiene que pasar por confirmación manual en vez de restaurar stock sola?
 *
 * Sin motivo en el payload devuelve `false`: la mayoría de las cancelaciones (pago rechazado,
 * arrepentimiento del comprador antes del despacho) no traen `cancel_detail` y tienen que
 * resolverse solas. Esas quedan cubiertas por el espejo, que igual verifica contra ML.
 *
 * @returns {{ manual: boolean, reason: string|null }}
 */
export function needsManualReview(order) {
  const detail = getCancelDetail(order);
  if (!detail) return { manual: false, reason: null };

  const label = detail.description || detail.code || 'sin motivo';
  if (detail.requestedBy === 'seller') {
    return { manual: true, reason: `cancelada por el vendedor (${label})` };
  }
  const text = `${detail.code ?? ''} ${detail.group ?? ''} ${detail.description ?? ''}`;
  if (OUT_OF_STOCK_RE.test(text)) {
    return { manual: true, reason: `cancelada por falta de stock (${label})` };
  }
  return { manual: false, reason: null };
}
