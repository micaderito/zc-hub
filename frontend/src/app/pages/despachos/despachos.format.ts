import { DispatchPackage } from '../../core/services/dispatch.service';

/** Formato compartido entre la vista de escritorio y la del celular de Para despachar. */

export const AR_TZ = 'America/Argentina/Buenos_Aires';

/** Logística fuera de lo habitual. Llevar al correo/punto es lo de siempre: no se muestra. */
const LOGISTIC_LABELS: Record<string, string> = {
  cross_docking: 'Colecta',
  self_service: 'Flex',
  pickup: 'Retiro en el local',
};

export function timeAr(iso: string): string {
  return new Intl.DateTimeFormat('es-AR', { timeZone: AR_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}

/** "viernes 10/10" a partir de un `YYYY-MM-DD`. */
export function dayLabel(dayKey: string): string {
  const d = new Date(`${dayKey}T12:00:00-03:00`);
  const weekday = new Intl.DateTimeFormat('es-AR', { timeZone: AR_TZ, weekday: 'long' }).format(d);
  const dm = new Intl.DateTimeFormat('es-AR', { timeZone: AR_TZ, day: '2-digit', month: '2-digit' }).format(d);
  return `${weekday} ${dm}`;
}

/** "faltan 2 h 40 min" / "faltan 25 min" / null si ya pasó. */
export function countdown(deadlineIso: string, now: number): string | null {
  const ms = new Date(deadlineIso).getTime() - now;
  if (ms <= 0) return null;
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `faltan ${h} h ${m} min` : `faltan ${m} min`;
}

/** "hoy" / "ayer" / "miércoles 05/11" para un `YYYY-MM-DD`, contra el `today` del backend. */
function relativeDay(dayKey: string, today: string): string {
  const yesterday = today ? new Date(new Date(`${today}T12:00:00-03:00`).getTime() - 86_400_000).toISOString().slice(0, 10) : '';
  return dayKey === today ? 'hoy' : dayKey === yesterday ? 'ayer' : dayLabel(dayKey);
}

export function saleLabel(p: DispatchPackage): string {
  if (p.channel === 'tn') return `Orden #${p.orderNumber ?? p.saleId}`;
  return `Venta #${p.saleId}`;
}

export function saleUrl(p: DispatchPackage): string | null {
  if (p.channel !== 'ml' || !p.orderIds?.length) return null;
  return `https://www.mercadolibre.com.ar/ventas/${p.orderIds[0]}/detalle`;
}

export function shippingLabel(p: DispatchPackage): string | null {
  if (p.channel === 'tn' && p.logisticType !== 'pickup') return p.shippingMethod || 'Envío';
  return LOGISTIC_LABELS[p.logisticType ?? ''] ?? null;
}

/** "Venció hoy 13:00" (solo atrasados). */
export function overdueLabel(p: DispatchPackage, today: string): string | null {
  if (!p.deadline || p.bucket !== 'overdue') return null;
  const day = relativeDay(p.deadlineDay ?? '', today);
  return p.deadlineHasTime ? `Venció ${day} ${timeAr(p.deadline)}` : `Venció ${day}`;
}

/** Cuándo se hizo la compra: "hoy 14:32", "ayer 09:10" o "miércoles 05/11 18:40" (hora argentina). */
export function purchasedLabel(p: DispatchPackage, today: string): string | null {
  if (!p.createdAt || Number.isNaN(new Date(p.createdAt).getTime())) return null;
  const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: AR_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(p.createdAt));
  return `${relativeDay(dayKey, today)} ${timeAr(p.createdAt)}`;
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('es-AR', { timeZone: AR_TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}

export function units(p: DispatchPackage): number {
  return p.items.reduce((s, i) => s + i.qty, 0);
}
