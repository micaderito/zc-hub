import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { injectQuery } from '@tanstack/angular-query-experimental';
import { AlertsService, ALERTS_NOTIFICATIONS_QUERY_KEY, StockNotification } from '../../../core/services/alerts.service';
import { SessionService } from '../../../core/services/session.service';
import { ProductThumbComponent } from '../../../shared/components/product-thumb/product-thumb.component';

/** Cómo está el producto HOY respecto del aviso (sale de `stockNow`, que trae `enrich`). */
export interface NowState {
  cls: 'err' | 'warn' | 'ok';
  icon: string;
  text: string;
}

export function nowState(n: StockNotification): NowState | null {
  const now = n.stockNow;
  if (now === null || now === undefined) return null;
  if (now <= 0) return { cls: 'err', icon: 'ti-alert-octagon', text: 'Hoy sin stock' };
  if (now <= n.threshold) return { cls: 'warn', icon: 'ti-alert-triangle', text: `Hoy quedan ${now}` };
  return { cls: 'ok', icon: 'ti-circle-check', text: `Repuesto · hoy ${now}` };
}

/** Rótulo del día ("Hoy", "Ayer" o la fecha) en hora local. */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (diff === 0) return 'Hoy';
  if (diff === 1) return 'Ayer';
  const txt = d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'numeric' });
  return txt.charAt(0).toUpperCase() + txt.slice(1);
}

/**
 * Pestaña "Notificaciones" de Alertas: los avisos agrupados por día, cada uno con la foto del
 * producto, con cuánto avisó y cómo está HOY (para ver de un vistazo si ya se repuso). Pide la
 * bandeja con `enrich` (foto + stock de ahora) con su propia clave de caché: la campanita de la
 * barra sondea sin `enrich` para no leer el snapshot cada minuto.
 */
@Component({
  selector: 'zc-alertas-notificaciones',
  standalone: true,
  imports: [DatePipe, ProductThumbComponent],
  templateUrl: './alertas-notificaciones.component.html',
  styleUrl: './alertas-notificaciones.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlertasNotificacionesComponent {
  private readonly alertsSvc = inject(AlertsService);
  readonly session = inject(SessionService);

  readonly unreadOnly = signal(false);

  readonly query = injectQuery(() => ({
    queryKey: [...ALERTS_NOTIFICATIONS_QUERY_KEY, this.unreadOnly(), 'enrich'],
    queryFn: () => this.alertsSvc.getNotificationsPromise({ unreadOnly: this.unreadOnly(), limit: 100, enrich: true }),
    refetchOnWindowFocus: false,
    staleTime: 30 * 1000,
  }));

  readonly notifications = computed(() => this.query.data()?.notifications ?? []);
  readonly unreadCount = computed(() => this.query.data()?.unreadCount ?? 0);

  /** Avisos agrupados por día, en el orden en que llegan (más nuevos primero). */
  readonly groups = computed(() => {
    const out: { day: string; items: StockNotification[] }[] = [];
    for (const n of this.notifications()) {
      const day = dayLabel(n.createdAt);
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(n);
      else out.push({ day, items: [n] });
    }
    return out;
  });

  readonly nowState = nowState;
  readonly busyId = signal<number | null>(null);
  readonly mutedSkus = signal<Set<string>>(new Set());

  label(n: StockNotification): string {
    return n.productLabel ?? n.sku;
  }

  async markRead(n: StockNotification): Promise<void> {
    if (n.readAt) return;
    await this.run(n.id, () => this.alertsSvc.markNotificationsRead({ ids: [n.id] }));
  }

  async markAllRead(): Promise<void> {
    await this.alertsSvc.markNotificationsRead({ all: true });
  }

  async mute(n: StockNotification): Promise<void> {
    await this.run(n.id, async () => {
      await this.alertsSvc.muteRule(n.sku, 7);
      this.mutedSkus.update((s) => new Set(s).add(n.sku));
    });
  }

  private async run(id: number, action: () => Promise<void>): Promise<void> {
    this.busyId.set(id);
    try {
      await action();
    } finally {
      this.busyId.set(null);
    }
  }
}
