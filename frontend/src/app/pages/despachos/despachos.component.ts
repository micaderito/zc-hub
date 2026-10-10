import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { QueryClient, injectQuery } from '@tanstack/angular-query-experimental';
import {
  DISPATCH_QUERY_KEY,
  DispatchItem,
  DispatchList,
  DispatchPackage,
  DispatchService,
} from '../../core/services/dispatch.service';
import { ProductThumbComponent } from '../../shared/components/product-thumb/product-thumb.component';
import { PhotoLightboxComponent } from '../../shared/components/photo-lightbox/photo-lightbox.component';

export type DispatchTab = 'today' | 'upcoming' | 'all';
export type ChannelFilter = 'all' | 'ml' | 'tn';

export interface DispatchSection {
  key: string;
  icon: string;
  title: string;
  hint: string | null;
  tone: 'err' | 'neutral';
  packages: DispatchPackage[];
}

const AR_TZ = 'America/Argentina/Buenos_Aires';

const LOGISTIC_LABELS: Record<string, string> = {
  drop_off: 'Llevar al correo',
  xd_drop_off: 'Llevar al punto',
  cross_docking: 'Colecta',
  self_service: 'Flex',
  pickup: 'Retiro en el local',
};

function timeAr(iso: string): string {
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

/**
 * Para despachar: paquetes de ML y TN que todavía no salieron. Hoy = atrasados + lo que vence hoy
 * + TN sin enviar (TN no tiene horario límite); Próximos días = lo de ML que vence más adelante,
 * incluidos los "Despachá el X" (envío en espera). Los cancelados recién van arriba de todo para
 * no armarlos ni llevarlos.
 */
@Component({
  selector: 'app-despachos',
  standalone: true,
  imports: [ProductThumbComponent, PhotoLightboxComponent],
  templateUrl: './despachos.component.html',
  styleUrl: './despachos.component.scss',
})
export class DespachosComponent {
  private readonly svc = inject(DispatchService);
  private readonly queryClient = inject(QueryClient);

  readonly tab = signal<DispatchTab>('today');
  readonly channel = signal<ChannelFilter>('all');
  readonly hidePrepared = signal(false);
  readonly refreshing = signal(false);
  readonly errorMsg = signal<string | null>(null);

  /** Tildes/vistos locales mientras viaja el request (update optimista). */
  private readonly preparedOverride = signal(new Map<string, boolean>());
  private readonly seenLocal = signal(new Set<string>());

  /** Reloj para la cuenta regresiva ("faltan 2 h 40 min"). */
  readonly now = signal(Date.now());

  readonly lightbox = signal<{ item: DispatchItem; pkg: DispatchPackage } | null>(null);

  readonly query = injectQuery(() => ({
    queryKey: DISPATCH_QUERY_KEY,
    queryFn: () => this.svc.getList(),
    staleTime: 30_000,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
  }));

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), 30_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
    // Los tildes optimistas viven hasta que llega la lista con el dato ya guardado.
    effect(() => {
      this.query.data();
      untracked(() => { if (this.preparedOverride().size) this.preparedOverride.set(new Map()); });
    }, { allowSignalWrites: true });
  }

  private readonly data = computed<DispatchList | undefined>(() => this.query.data());
  readonly errors = computed(() => this.data()?.errors ?? {});
  readonly generatedAt = computed(() => this.data()?.generatedAt ?? null);

  /** Paquetes con los overrides locales aplicados. */
  private readonly packages = computed<DispatchPackage[]>(() => {
    const overrides = this.preparedOverride();
    const seen = this.seenLocal();
    return (this.data()?.packages ?? [])
      .filter((p) => !(p.cancelled && seen.has(this.key(p))))
      .map((p) => {
        const o = overrides.get(this.key(p));
        if (o === undefined) return p;
        return { ...p, preparedAt: o ? (p.preparedAt ?? new Date().toISOString()) : null };
      });
  });

  private readonly byChannel = computed(() => {
    const ch = this.channel();
    return this.packages().filter((p) => ch === 'all' || p.channel === ch);
  });

  readonly cancelled = computed(() => this.byChannel().filter((p) => p.bucket === 'cancelled'));

  private readonly active = computed(() => {
    const hide = this.hidePrepared();
    const list = this.byChannel().filter((p) => p.bucket !== 'cancelled' && !(hide && p.preparedAt));
    // Preparados al final dentro de cada grupo (el backend ya ordena por horario).
    return [...list.filter((p) => !p.preparedAt), ...list.filter((p) => p.preparedAt)];
  });

  readonly counts = computed(() => {
    const all = this.byChannel().filter((p) => p.bucket !== 'cancelled');
    const pendingToday = all.filter((p) => (p.bucket === 'overdue' || p.bucket === 'today'));
    return {
      overdue: all.filter((p) => p.bucket === 'overdue').length,
      today: pendingToday.length,
      upcoming: all.filter((p) => p.bucket === 'upcoming').length,
      toPrepare: pendingToday.filter((p) => !p.preparedAt).reduce((s, p) => s + p.items.reduce((a, i) => a + i.qty, 0), 0),
      prepared: pendingToday.filter((p) => p.preparedAt).length,
    };
  });

  private readonly todaySections = computed<DispatchSection[]>(() => {
    const list = this.active();
    const sections: DispatchSection[] = [];
    const overdue = list.filter((p) => p.bucket === 'overdue');
    if (overdue.length) {
      sections.push({ key: 'overdue', icon: 'ti-alert-triangle', title: 'Atrasado', hint: 'Se pasó el horario: despachalo cuanto antes', tone: 'err', packages: overdue });
    }
    const mlToday = list.filter((p) => p.channel === 'ml' && p.bucket === 'today');
    const byTime = new Map<string, DispatchPackage[]>();
    for (const p of mlToday) {
      const k = p.deadline && p.deadlineHasTime ? timeAr(p.deadline) : '';
      if (!byTime.has(k)) byTime.set(k, []);
      byTime.get(k)!.push(p);
    }
    for (const [time, pkgs] of [...byTime].sort(([a], [b]) => (a || '99').localeCompare(b || '99'))) {
      const first = pkgs.find((p) => p.deadline)?.deadline ?? null;
      const label = LOGISTIC_LABELS[pkgs[0].logisticType ?? ''] ?? 'Despachar';
      sections.push({
        key: `ml-${time || 'sin-hora'}`,
        icon: 'ti-clock',
        title: time ? `${label} antes de las ${time}` : 'Mercado Libre · despachar hoy',
        hint: first && time ? countdown(first, this.now()) : null,
        tone: 'neutral',
        packages: pkgs,
      });
    }
    const tnToday = list.filter((p) => p.channel === 'tn' && p.bucket === 'today');
    if (tnToday.length) {
      sections.push({ key: 'tn', icon: 'ti-shopping-bag', title: 'Tienda Nube · sin enviar', hint: 'Sin horario límite, los más viejos primero', tone: 'neutral', packages: tnToday });
    }
    return sections;
  });

  private readonly upcomingSections = computed<DispatchSection[]>(() => {
    const byDay = new Map<string, DispatchPackage[]>();
    for (const p of this.active().filter((x) => x.bucket === 'upcoming')) {
      const day = p.bufferedDay ?? p.deadlineDay ?? '9999-12-31';
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day)!.push(p);
    }
    return [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([day, pkgs]) => ({
      key: `day-${day}`,
      icon: 'ti-calendar',
      title: `Despachar el ${dayLabel(day)}`,
      hint: pkgs.some((p) => p.bufferedUntil) ? 'La etiqueta se habilita ese día' : null,
      tone: 'neutral' as const,
      packages: pkgs,
    }));
  });

  readonly sections = computed<DispatchSection[]>(() => {
    switch (this.tab()) {
      case 'today': return this.todaySections();
      case 'upcoming': return this.upcomingSections();
      default: return [...this.todaySections(), ...this.upcomingSections()];
    }
  });

  readonly showCancelled = computed(() => this.tab() !== 'upcoming' && this.cancelled().length > 0);

  key(p: Pick<DispatchPackage, 'channel' | 'saleId'>): string {
    return `${p.channel}:${p.saleId}`;
  }

  async refresh(): Promise<void> {
    this.refreshing.set(true);
    this.errorMsg.set(null);
    try {
      this.queryClient.setQueryData(DISPATCH_QUERY_KEY, await this.svc.getList(true));
    } catch {
      this.errorMsg.set('No se pudo actualizar. Probá de nuevo en un rato.');
    } finally {
      this.refreshing.set(false);
    }
  }

  async togglePrepared(p: DispatchPackage): Promise<void> {
    const k = this.key(p);
    const next = !p.preparedAt;
    this.setOverride(k, next);
    this.errorMsg.set(null);
    try {
      await this.svc.setPrepared(p, next);
      // Se escribe en la caché del query (no refetch): evita que el tilde parpadee hasta que
      // vuelva la lista, y no le pega a ML/TN por un dato que es solo del hub.
      this.queryClient.setQueryData<DispatchList>(DISPATCH_QUERY_KEY, (old) => old && {
        ...old,
        packages: old.packages.map((x) => this.key(x) === k ? { ...x, preparedAt: next ? new Date().toISOString() : null } : x),
      });
    } catch {
      this.setOverride(k, undefined);
      this.errorMsg.set('No se pudo guardar el tilde de preparado.');
    }
  }

  async dismissCancelled(p: DispatchPackage): Promise<void> {
    const k = this.key(p);
    this.seenLocal.update((s) => new Set(s).add(k));
    try {
      await this.svc.markCancelSeen(p);
    } catch {
      this.seenLocal.update((s) => { const n = new Set(s); n.delete(k); return n; });
      this.errorMsg.set('No se pudo guardar. Probá de nuevo.');
    }
  }

  private setOverride(k: string, v: boolean | undefined): void {
    this.preparedOverride.update((m) => {
      const n = new Map(m);
      if (v === undefined) n.delete(k); else n.set(k, v);
      return n;
    });
  }

  openPhoto(pkg: DispatchPackage, item: DispatchItem): void {
    this.lightbox.set({ pkg, item });
  }

  // ── Formato ──

  saleLabel(p: DispatchPackage): string {
    if (p.channel === 'tn') return `Orden #${p.orderNumber ?? p.saleId}`;
    return `Venta #${p.saleId}`;
  }

  saleUrl(p: DispatchPackage): string | null {
    if (p.channel !== 'ml' || !p.orderIds?.length) return null;
    return `https://www.mercadolibre.com.ar/ventas/${p.orderIds[0]}/detalle`;
  }

  shippingLabel(p: DispatchPackage): string | null {
    if (p.channel === 'tn' && p.logisticType !== 'pickup') return p.shippingMethod || 'Envío';
    return LOGISTIC_LABELS[p.logisticType ?? ''] ?? null;
  }

  deadlineLabel(p: DispatchPackage): string | null {
    if (!p.deadline || p.bucket !== 'overdue') return null;
    const today = this.data()?.today ?? '';
    const yesterday = today ? new Date(new Date(`${today}T12:00:00-03:00`).getTime() - 86_400_000).toISOString().slice(0, 10) : '';
    const day = p.deadlineDay === today ? 'hoy' : p.deadlineDay === yesterday ? 'ayer' : dayLabel(p.deadlineDay ?? '');
    return p.deadlineHasTime ? `Venció ${day} ${timeAr(p.deadline)}` : `Venció ${day}`;
  }

  dateTime(iso: string | null | undefined): string {
    if (!iso) return '';
    return new Intl.DateTimeFormat('es-AR', { timeZone: AR_TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
  }

  timeAgo(iso: string | null): string {
    if (!iso) return '';
    const min = Math.max(0, Math.round((this.now() - new Date(iso).getTime()) / 60_000));
    return min < 1 ? 'recién' : `hace ${min} min`;
  }

  todayLabel(): string {
    const today = this.data()?.today;
    return today ? dayLabel(today) : '';
  }

  units(p: DispatchPackage): number {
    return p.items.reduce((s, i) => s + i.qty, 0);
  }
}
