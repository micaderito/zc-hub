/** Helpers puros que comparten las pestañas de Historial y cola (escritorio y celular). */
import { AuditSource, PendingMlTask, SyncAuditRow } from '../../core/services/sync.service';

/** Mensaje de un error de HttpClient: el `{ error }` del backend, si no el de la request, si no `fallback`. */
export function errorMessage(e: unknown, fallback: string): string {
  const err = e as { error?: { error?: string }; message?: string } | null | undefined;
  return err?.error?.error || err?.message || fallback;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
}

export function channelLabel(ch: string): string {
  return ch === 'mercadolibre' ? 'Mercado Libre' : 'Tienda Nube';
}

/** Etiqueta del origen de un movimiento del historial. */
export function auditSourceLabel(source: AuditSource): string {
  if (source === 'manual') return 'Manual';
  if (source === 'cancelacion') return 'Cancelación';
  if (source === 'devolucion') return 'Devolución';
  if (source === 'externo') return 'Externo';
  return 'Venta';
}

/**
 * Revertir deshace el descuento que hizo una venta. Un cambio manual no tiene venta detrás ni
 * cantidad que deshacer: se corrige volviendo a fijar el stock desde Precio y stock. Tampoco se
 * revierte lo que movió la plataforma por su cuenta (actor 'plataforma'): esa fila es el registro
 * de lo que hizo ML/TN, no una escritura nuestra que se pueda deshacer. El backend también lo
 * rechaza; esto evita ofrecer un botón que solo puede fallar.
 */
export function canRevertAudit(row: SyncAuditRow): boolean {
  return row.source !== 'manual' && row.actor !== 'plataforma';
}

export function revertTitle(row: SyncAuditRow): string {
  const verb = row.stockAfter > row.stockBefore ? 'Descontar' : 'Sumar';
  return `${verb} ${row.quantity} de nuevo en ${channelLabel(row.updatedChannel)}`;
}

/** Se puede reintentar a mano: falló, o quedó trabada con el lock vencido. */
export function canRetryTask(task: PendingMlTask): boolean {
  return task.status === 'failed' || task.stuck === true;
}

export function taskKindLabel(kind: PendingMlTask['kind']): string {
  switch (kind) {
    case 'stock_ml': return 'Stock ML';
    case 'stock_ml_set': return 'Stock ML';
    case 'sku_ml': return 'SKU ML';
    case 'sku_tn': return 'SKU TN';
    case 'price_ml': return 'Precio ML';
    case 'stock_probe': return 'Releer stock';
    default: return kind;
  }
}

export function taskStatusLabel(task: PendingMlTask): string {
  if (task.stuck) return 'Trabada';
  switch (task.status) {
    case 'pending': return 'Pendiente';
    case 'processing': return 'En proceso';
    case 'failed': return 'Falló';
    default: return task.status;
  }
}

export function taskChangeLabel(task: PendingMlTask): string {
  if (task.kind === 'stock_ml') {
    if (task.targetQty == null) return '—';
    const sign = task.targetQty > 0 ? '+' : '';
    return `${sign}${task.targetQty} u.`;
  }
  // stock_ml_set fija el stock a un valor absoluto (no es un delta como stock_ml).
  if (task.kind === 'stock_ml_set') {
    return task.targetQty != null ? `→ ${task.targetQty} u.` : '—';
  }
  if (task.kind === 'price_ml') {
    return task.targetPrice != null ? `$${task.targetPrice.toLocaleString('es-AR')}` : '—';
  }
  // stock_probe no cambia nada: solo lee para completar el historial.
  if (task.kind === 'stock_probe') return 'Solo lectura';
  return task.targetSku ? `SKU → ${task.targetSku}` : '—';
}

/** Mensaje después de revisar los reclamos en ML (`POST /sync/returns/fetch`). */
export function returnsFetchMessage(r: { created: number; skipped: number; claimsChecked: number; mlBusy?: boolean }): string {
  if (r.mlBusy) return 'Mercado Libre está saturado en este momento. Probá de nuevo en un minuto.';
  if (r.created > 0 || r.skipped > 0)
    return `Se revisaron ${r.claimsChecked} reclamos. Se agregaron ${r.created} ítems${r.skipped > 0 ? ` (${r.skipped} ya estaban)` : ''}.`;
  if (r.claimsChecked === 0) return 'No hay reclamos recientes con devolución en ML.';
  return 'Lista actualizada.';
}
