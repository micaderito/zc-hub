import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { QueryClient, injectQuery, keepPreviousData } from '@tanstack/angular-query-experimental';
import {
  DISPATCH_NOTES_QUERY_KEY,
  DISPATCH_QUERY_KEY,
  DispatchItem,
  DispatchList,
  DispatchPackage,
  DispatchService,
} from '../../core/services/dispatch.service';
import { ProductThumbComponent } from '../../shared/components/product-thumb/product-thumb.component';
import { PHONE_QUERY, mediaSignal } from '../../shared/utils/media-signal';
import { DespachosPhoneComponent } from './despachos-phone.component';
import { SearchBarComponent } from '../../shared/components/search-bar/search-bar.component';
import * as fmt from './despachos.format';
import { buildSearchIndex, matchesTerms, searchTerms } from './despachos.search';
import { countdown, dayLabel, timeAr } from './despachos.format';

export { countdown, dayLabel } from './despachos.format';

export type DispatchTab = 'today' | 'upcoming' | 'all';
export type ChannelFilter = 'all' | 'ml' | 'tn';

/** Espera entre la última tecla y filtrar. */
export const SEARCH_DEBOUNCE_MS = 200;

export interface DispatchSection {
  key: string;
  icon: string;
  title: string;
  hint: string | null;
  tone: 'err' | 'neutral' | 'ok';
  /** Se puede plegar (Ya despachados): arranca plegada. */
  collapsible?: boolean;
  packages: DispatchPackage[];
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
  imports: [ProductThumbComponent, DespachosPhoneComponent, SearchBarComponent],
  templateUrl: './despachos.component.html',
  styleUrl: './despachos.component.scss',
})
export class DespachosComponent {
  private readonly svc = inject(DispatchService);
  private readonly queryClient = inject(QueryClient);

  /** En el celular la lista es otra (`zc-despachos-phone`): filas compactas + hoja de detalle. */
  readonly phone = mediaSignal(PHONE_QUERY);

  readonly tab = signal<DispatchTab>('today');
  readonly channel = signal<ChannelFilter>('all');
  readonly hidePrepared = signal(false);
  readonly showDispatched = signal(false);
  readonly refreshing = signal(false);
  readonly errorMsg = signal<string | null>(null);

  /**
   * Buscador: lo que está escrito (`searchInput`) y lo que filtra (`search`, con debounce). Filtra
   * en el navegador sobre la lista ya cargada, sin pedirle nada al backend (ver despachos.search.ts).
   * Mientras hay búsqueda, se busca en TODO (Hoy, Próximos días, despachados y cancelados): elegir
   * una pestaña la borra y vuelve a la lista normal.
   */
  readonly searchInput = signal('');
  readonly search = signal('');
  private readonly terms = computed(() => searchTerms(this.search()));
  readonly searching = computed(() => this.terms().length > 0);
  /** La pestaña que se ve: con búsqueda, "Todo". */
  readonly activeTab = computed<DispatchTab>(() => (this.searching() ? 'all' : this.tab()));

  /** Tildes/vistos locales mientras viaja el request (update optimista). */
  private readonly preparedOverride = signal(new Map<string, boolean>());
  private readonly seenLocal = signal(new Set<string>());

  /** Reloj para la cuenta regresiva ("faltan 2 h 40 min"). */
  readonly now = signal(Date.now());

  readonly query = injectQuery(() => ({
    queryKey: DISPATCH_QUERY_KEY,
    queryFn: () => this.svc.getList(),
    staleTime: 30_000,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
  }));

  /**
   * Notas de ML: un pedido a ML por venta, así que van aparte y DESPUÉS de la lista (comparten el
   * limitador de ML: en paralelo la demorarían). La clave lleva `generatedAt`: cada lista nueva
   * (Actualizar, refresco solo) trae sus notas frescas.
   */
  readonly notesQuery = injectQuery(() => {
    const generatedAt = this.query.data()?.generatedAt ?? null;
    return {
      queryKey: [...DISPATCH_NOTES_QUERY_KEY, generatedAt],
      queryFn: () => this.svc.getNotes(),
      enabled: !!generatedAt,
      staleTime: Infinity,
      gcTime: 5 * 60_000,
      // Al actualizar, las notas que ya se ven quedan hasta que llegan las nuevas.
      placeholderData: keepPreviousData,
    };
  });

  /** Las notas de ML todavía no llegaron (la lista ya está a la vista). */
  readonly notesLoading = computed(() => !!this.query.data() && this.notesQuery.isFetching());
  readonly notesFailed = computed(() => this.notesQuery.isError() || (this.notesQuery.data()?.failed ?? 0) > 0);

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), 30_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
    effect((onCleanup) => {
      const value = this.searchInput();
      // Borrar es al instante; escribir espera a que se deje de tipear.
      if (!value.trim()) { this.search.set(''); return; }
      const t = setTimeout(() => this.search.set(value), SEARCH_DEBOUNCE_MS);
      onCleanup(() => clearTimeout(t));
    }, { allowSignalWrites: true });
    // Los tildes optimistas viven hasta que llega la lista con el dato ya guardado.
    effect(() => {
      this.query.data();
      untracked(() => { if (this.preparedOverride().size) this.preparedOverride.set(new Map()); });
    }, { allowSignalWrites: true });
  }

  /**
   * Se está trayendo la lista de nuevo con datos ya en pantalla: el botón "Actualizar" o el
   * refresco solo (cada 5 min, al volver a la pestaña). La primera carga tiene su propio estado.
   */
  readonly busy = computed(() => this.refreshing() || (this.query.isFetching() && !this.query.isLoading()));

  private readonly data = computed<DispatchList | undefined>(() => this.query.data());
  readonly errors = computed(() => this.data()?.errors ?? {});
  readonly generatedAt = computed(() => this.data()?.generatedAt ?? null);

  /** Paquetes con los overrides locales aplicados. */
  private readonly packages = computed<DispatchPackage[]>(() => {
    const overrides = this.preparedOverride();
    const seen = this.seenLocal();
    const mlNotes = this.notesQuery.data()?.notes ?? {};
    return (this.data()?.packages ?? [])
      .filter((p) => !(p.cancelled && seen.has(this.key(p))))
      .map((p) => {
        const withNotes = p.channel === 'ml' && mlNotes[p.saleId] ? { ...p, notes: mlNotes[p.saleId] } : p;
        const o = overrides.get(this.key(p));
        if (o === undefined) return withNotes;
        return { ...withNotes, preparedAt: o ? (p.preparedAt ?? new Date().toISOString()) : null };
      });
  });

  /** Texto normalizado de cada paquete: se arma una vez por lista, no por tecla. */
  private readonly searchIndex = computed(() => buildSearchIndex(this.data()?.packages ?? [], (p) => this.key(p)));

  /** Canal + búsqueda: de acá salen los números, las pestañas y las secciones. */
  private readonly byChannel = computed(() => {
    const ch = this.channel();
    const terms = this.terms();
    const index = this.searchIndex();
    return this.packages().filter((p) => (ch === 'all' || p.channel === ch) && matchesTerms(index.get(this.key(p)), terms));
  });

  /** Cuántos paquetes encontró la búsqueda (todas las secciones, cancelados incluidos). */
  readonly searchCount = computed(() => {
    const hide = this.hidePrepared();
    return this.byChannel().filter((p) => !(hide && p.preparedAt && p.bucket !== 'cancelled' && p.bucket !== 'dispatched')).length;
  });

  setTab(t: DispatchTab): void {
    this.clearSearch();
    this.tab.set(t);
  }

  clearSearch(): void {
    this.searchInput.set('');
    this.search.set('');
  }

  readonly cancelled = computed(() => this.byChannel().filter((p) => p.bucket === 'cancelled'));
  readonly dispatched = computed(() => this.byChannel().filter((p) => p.bucket === 'dispatched'));

  /** Lo que todavía hay que despachar: sin cancelados ni ya despachados. */
  private readonly active = computed(() => {
    const hide = this.hidePrepared();
    // Un preparado queda en su lugar (se pinta de verde): moverlo al final hacía perderlo de vista.
    return this.byChannel().filter((p) => p.bucket !== 'cancelled' && p.bucket !== 'dispatched' && !(hide && p.preparedAt));
  });

  readonly counts = computed(() => {
    const all = this.byChannel().filter((p) => p.bucket !== 'cancelled' && p.bucket !== 'dispatched');
    const pendingToday = all.filter((p) => (p.bucket === 'overdue' || p.bucket === 'today'));
    return {
      overdue: all.filter((p) => p.bucket === 'overdue').length,
      today: pendingToday.length,
      upcoming: all.filter((p) => p.bucket === 'upcoming').length,
      toPrepare: pendingToday.filter((p) => !p.preparedAt).reduce((s, p) => s + p.items.reduce((a, i) => a + i.qty, 0), 0),
      prepared: pendingToday.filter((p) => p.preparedAt).length,
      dispatched: this.dispatched().length,
    };
  });

  private readonly todaySections = computed<DispatchSection[]>(() => {
    const list = this.active();
    const sections: DispatchSection[] = [];
    const overdue = list.filter((p) => p.bucket === 'overdue');
    if (overdue.length) {
      sections.push({ key: 'overdue', icon: 'ti-alert-triangle', title: 'Atrasado', hint: 'Se pasó el horario y todavía no se despachó', tone: 'err', packages: overdue });
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
      sections.push({
        key: `ml-${time || 'sin-hora'}`,
        icon: 'ti-clock',
        title: time ? `Despachar antes de las ${time}` : 'Mercado Libre · despachar hoy',
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
      title: day === '9999-12-31' ? 'Despachar más adelante · fecha a confirmar por ML' : `Despachar el ${dayLabel(day)}`,
      hint: pkgs.some((p) => p.bufferedUntil) ? 'La etiqueta se habilita ese día' : null,
      tone: 'neutral' as const,
      packages: pkgs,
    }));
  });

  private readonly dispatchedSection = computed<DispatchSection[]>(() => {
    const pkgs = this.dispatched();
    if (!pkgs.length) return [];
    return [{
      key: 'dispatched',
      icon: 'ti-circle-check',
      title: `Ya despachados (${pkgs.length})`,
      hint: 'Ya los dejaste en el punto',
      tone: 'ok',
      // Plegada de entrada; buscando no se pliega, si no el resultado no se vería.
      collapsible: !this.searching(),
      packages: pkgs,
    }];
  });

  /** Secciones con cosas por despachar (sin "Ya despachados"): define si se muestra "no hay nada pendiente". */
  readonly pendingSections = computed<DispatchSection[]>(() => {
    switch (this.activeTab()) {
      case 'today': return this.todaySections();
      case 'upcoming': return this.upcomingSections();
      default: return [...this.todaySections(), ...this.upcomingSections()];
    }
  });

  readonly sections = computed<DispatchSection[]>(() =>
    this.activeTab() === 'upcoming' ? this.pendingSections() : [...this.pendingSections(), ...this.dispatchedSection()]);

  isCollapsed(s: DispatchSection): boolean {
    return !!s.collapsible && !this.showDispatched();
  }

  readonly showCancelled = computed(() => this.activeTab() !== 'upcoming' && this.cancelled().length > 0);

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

  // ── Formato ──

  saleLabel(p: DispatchPackage): string { return fmt.saleLabel(p); }
  buyerLabel(p: DispatchPackage): string | null { return fmt.buyerLabel(p); }
  saleUrl(p: DispatchPackage): string | null { return fmt.saleUrl(p); }
  shippingLabel(p: DispatchPackage): string | null { return fmt.shippingLabel(p); }
  dateTime(iso: string | null | undefined): string { return fmt.dateTime(iso); }
  units(p: DispatchPackage): number { return fmt.units(p); }

  /** Lo que hoy es "hoy" según el backend (`YYYY-MM-DD`). */
  readonly today = computed(() => this.data()?.today ?? '');

  deadlineLabel(p: DispatchPackage): string | null {
    const l = fmt.overdueLabel(p, this.today());
    return l && `${l} · sin despachar`;
  }

  purchasedLabel(p: DispatchPackage): string | null {
    return fmt.purchasedLabel(p, this.today());
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
}
