import { Component, inject, signal, computed, effect, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { toSignal, toObservable } from '@angular/core/rxjs-interop';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';
import { injectQuery } from '@tanstack/angular-query-experimental';
import {
  AlertsService,
  ALERTS_RULES_QUERY_KEY,
  ALERTS_RESTOCK_QUERY_KEY,
  ALERTS_NOTIFICATIONS_QUERY_KEY,
  ALERTS_UNWATCHED_QUERY_KEY,
  StockAlertRule,
  RestockRow,
  RestockPeriod,
  UnwatchedProduct,
  RestockPackRef,
  restockStateLabel,
} from '../../core/services/alerts.service';
import { ConflictsService, mlLabel } from '../../core/services/conflicts.service';
import { TabsComponent, TabDef } from '../../shared/components/tabs/tabs.component';
import { SearchBarComponent } from '../../shared/components/search-bar/search-bar.component';
import { ConfirmDialogComponent } from '../../shared/components/confirm-dialog/confirm-dialog.component';

type Tab = 'reponer' | 'notificaciones' | 'sin-alertas' | 'reglas';

interface RestockGroup {
  pack: RestockPackRef;
  rows: RestockRow[];
}

/** Resultado del buscador de productos (para vigilar uno nuevo). */
interface ProductOption {
  sku: string;
  label: string;
  thumbnail: string | null;
}

@Component({
  selector: 'app-alertas',
  standalone: true,
  imports: [CommonModule, FormsModule, TabsComponent, SearchBarComponent, ConfirmDialogComponent],
  templateUrl: './alertas.component.html',
  styleUrl: './alertas.component.scss',
})
export class AlertasComponent {
  private readonly alertsSvc = inject(AlertsService);
  private readonly conflicts = inject(ConflictsService);
  private readonly route = inject(ActivatedRoute);

  readonly activeTab = signal<Tab>('reponer');
  protected readonly restockStateLabel = restockStateLabel;

  onTabChange(key: string): void {
    this.activeTab.set(key as Tab);
  }

  /**
   * Atajo desde Productos: /alertas?tab=reglas&sku=XXX abre directo en Reglas con el SKU
   * precargado en el buscador (si ya hay una regla, la abre para editar solo — ver el effect
   * de más abajo; si no, queda listo para pegarlo en "Vigilar un producto nuevo").
   */
  private readonly queryParams = toSignal(this.route.queryParamMap, { initialValue: null });

  /* ══════════════════════════ Para reponer ══════════════════════════ */

  readonly restockPeriod = signal<RestockPeriod>('last-order');
  readonly restockSearch = signal('');
  readonly restockView = signal<'pack' | 'flat'>('pack');

  readonly restockQuery = injectQuery(() => ({
    queryKey: [...ALERTS_RESTOCK_QUERY_KEY, this.restockPeriod()],
    queryFn: () => this.alertsSvc.getRestockPromise(this.restockPeriod()),
    refetchOnWindowFocus: false,
    staleTime: 60 * 1000,
  }));

  readonly restockLoading = computed(() => this.restockQuery.isLoading());
  readonly restockRows = computed(() => this.restockQuery.data()?.rows ?? []);
  readonly restockCutoff = computed(() => this.restockQuery.data()?.cutoff ?? null);

  readonly filteredRestockRows = computed(() => {
    const q = this.restockSearch().trim().toLowerCase();
    const rows = this.restockRows();
    if (!q) return rows;
    return rows.filter((r) =>
      r.sku.toLowerCase().includes(q) ||
      (r.productLabel || '').toLowerCase().includes(q) ||
      (r.pack?.name || '').toLowerCase().includes(q)
    );
  });

  /** Filas agrupadas por pack (vista "Por pack") + las que se piden sueltas. */
  readonly restockGroups = computed<{ groups: RestockGroup[]; noPack: RestockRow[] }>(() => {
    const byPack = new Map<number, RestockGroup>();
    const noPack: RestockRow[] = [];
    for (const r of this.filteredRestockRows()) {
      if (r.pack) {
        let g = byPack.get(r.pack.packId);
        if (!g) { g = { pack: r.pack, rows: [] }; byPack.set(r.pack.packId, g); }
        g.rows.push(r);
      } else {
        noPack.push(r);
      }
    }
    const groups = [...byPack.values()].sort((a, b) => a.pack.name.localeCompare(b.pack.name, 'es'));
    return { groups, noPack };
  });

  /** Vista "Lista plana": una fila por producto, la más urgente primero. */
  readonly restockFlatRows = computed(() => {
    const rank: Record<string, number> = { out: 0, 'still-low': 1, unknown: 2, restocked: 3 };
    return [...this.filteredRestockRows()].sort((a, b) => {
      const byState = (rank[a.state] ?? 9) - (rank[b.state] ?? 9);
      if (byState !== 0) return byState;
      return (a.stockEffective ?? 0) - (b.stockEffective ?? 0);
    });
  });

  readonly restockTotals = computed(() => {
    const { groups, noPack } = this.restockGroups();
    let packs = 0, looseUnits = 0, units = 0;
    for (const g of groups) {
      const qty = g.pack.suggestedPacks?.qty ?? 0;
      packs += qty;
      units += qty * g.pack.unitCount;
      for (const r of g.rows) {
        if (r.suggested) { looseUnits += r.suggested.qty; units += r.suggested.qty; }
      }
    }
    for (const r of noPack) {
      if (r.suggested) { looseUnits += r.suggested.qty; units += r.suggested.qty; }
    }
    return { packs, looseUnits, units };
  });

  /** Ajusta a mano la sugerencia de un modelo puntual (SKU sin pack, o un extra dentro de un pack). */
  async updateRowSuggested(row: RestockRow, value: number | string | null): Promise<void> {
    const qty = value === null || value === undefined || value === '' ? null : Number(value);
    if (qty != null && (!Number.isFinite(qty) || qty < 0)) return;
    await this.alertsSvc.saveRestockOverride('sku', row.sku, qty);
  }

  /** Ajusta a mano cuántos packs completos pedir de un pack (pisa la sugerencia calculada). */
  async updatePackSuggested(pack: RestockPackRef, value: number | string | null): Promise<void> {
    const qty = value === null || value === undefined || value === '' ? null : Number(value);
    if (qty != null && (!Number.isFinite(qty) || qty < 0)) return;
    await this.alertsSvc.saveRestockOverride('pack', String(pack.packId), qty);
  }

  /** Saca del pedido en curso una fila ya repuesta; vuelve sola si el SKU dispara otra alerta. */
  async dismissRestockRow(row: RestockRow): Promise<void> {
    await this.alertsSvc.dismissRestockRow(row.sku);
  }

  readonly showCloseConfirm = signal(false);
  readonly closingPeriod = signal(false);

  async confirmClosePeriod(): Promise<void> {
    this.closingPeriod.set(true);
    try {
      await this.alertsSvc.closeRestockPeriod();
      this.showCloseConfirm.set(false);
    } finally {
      this.closingPeriod.set(false);
    }
  }

  /** Respeta la vista activa: agrupado por pack, o el listado completo de "Lista plana". */
  copyRestockList(): void {
    const lines = this.restockView() === 'pack' ? this.buildPackCopyLines() : this.buildFlatCopyLines();
    navigator.clipboard?.writeText(lines.join('\n')).catch(() => {});
  }

  private buildPackCopyLines(): string[] {
    const lines: string[] = [];
    for (const g of this.restockGroups().groups) {
      const qty = g.pack.suggestedPacks?.qty ?? 0;
      lines.push(`${g.pack.name}${g.pack.sku ? ` (${g.pack.sku})` : ''} — ${qty} pack${qty === 1 ? '' : 's'}`);
      for (const r of g.rows) {
        if (r.suggested) lines.push(`  ${r.productLabel ?? r.sku} (${r.sku}) — ${r.suggested.qty} extra`);
      }
    }
    for (const r of this.restockGroups().noPack) {
      if (r.suggested) lines.push(`${r.productLabel ?? r.sku} (${r.sku}) — ${r.suggested.qty} ${r.suggested.unit}`);
    }
    return lines;
  }

  private buildFlatCopyLines(): string[] {
    return this.restockFlatRows().map((r) => {
      const qty = r.suggested ? `${r.suggested.qty} ${r.suggested.unit}` : r.pack ? `ver pack ${r.pack.name}` : '—';
      return `${r.productLabel ?? r.sku} (${r.sku}) — ${qty}`;
    });
  }

  /* ══════════════════════════ Notificaciones ══════════════════════════ */

  readonly notifUnreadOnly = signal(false);

  readonly notificationsQuery = injectQuery(() => ({
    queryKey: [...ALERTS_NOTIFICATIONS_QUERY_KEY, this.notifUnreadOnly()],
    queryFn: () => this.alertsSvc.getNotificationsPromise({ unreadOnly: this.notifUnreadOnly(), limit: 100 }),
    refetchOnWindowFocus: false,
    staleTime: 30 * 1000,
  }));

  readonly notifications = computed(() => this.notificationsQuery.data()?.notifications ?? []);
  readonly unreadCount = computed(() => this.notificationsQuery.data()?.unreadCount ?? 0);

  async markNotificationRead(id: number): Promise<void> {
    await this.alertsSvc.markNotificationsRead({ ids: [id] });
  }

  async markAllNotificationsRead(): Promise<void> {
    await this.alertsSvc.markNotificationsRead({ all: true });
  }

  async muteFromNotification(sku: string): Promise<void> {
    await this.alertsSvc.muteRule(sku, 7);
  }

  /* ══════════════════════════ Sin alertas ══════════════════════════ */

  readonly unwatchedQuery = injectQuery(() => ({
    queryKey: ALERTS_UNWATCHED_QUERY_KEY,
    queryFn: () => this.alertsSvc.getUnwatchedPromise(),
    refetchOnWindowFocus: false,
    staleTime: 30 * 1000,
  }));

  readonly unwatchedLoading = computed(() => this.unwatchedQuery.isLoading());
  readonly unwatchedProducts = computed(() => this.unwatchedQuery.data()?.products ?? []);
  readonly unwatchedSearch = signal('');

  readonly filteredUnwatched = computed(() => {
    const q = this.unwatchedSearch().trim().toLowerCase();
    const rows = this.unwatchedProducts();
    if (!q) return rows;
    return rows.filter((r) =>
      r.sku.toLowerCase().includes(q) ||
      (r.productLabel || '').toLowerCase().includes(q) ||
      (r.pack?.name || '').toLowerCase().includes(q)
    );
  });

  /** Manda a Reglas con el producto ya tildado en "Vigilar productos" — solo falta el umbral. */
  configureAlert(product: UnwatchedProduct): void {
    this.selectedNewSkus.set(new Map([
      [product.sku, { sku: product.sku, label: product.productLabel ?? product.sku, thumbnail: product.thumbnail }],
    ]));
    this.newRuleQuery.set(product.sku);
    this.activeTab.set('reglas');
  }

  /* ══════════════════════════ Reglas ══════════════════════════ */

  readonly rulesQuery = injectQuery(() => ({
    queryKey: ALERTS_RULES_QUERY_KEY,
    queryFn: () => this.alertsSvc.getRulesPromise(),
    refetchOnWindowFocus: false,
    staleTime: 30 * 1000,
  }));

  readonly rules = computed(() => this.rulesQuery.data()?.rules ?? []);
  readonly rulesSearch = signal('');

  readonly filteredRules = computed(() => {
    const q = this.rulesSearch().trim().toLowerCase();
    const rules = this.rules();
    if (!q) return rules;
    return rules.filter((r) =>
      r.sku.toLowerCase().includes(q) ||
      (r.productLabel || '').toLowerCase().includes(q) ||
      (r.pack?.name || '').toLowerCase().includes(q)
    );
  });

  readonly editingSku = signal<string | null>(null);
  readonly editThreshold = signal(0);
  readonly savingRule = signal(false);

  constructor() {
    // Buscar una regla y dejar UNA sola coincidencia abre esa fila para editarla.
    effect(() => {
      const q = this.rulesSearch().trim();
      const matches = this.filteredRules();
      untracked(() => {
        if (q && matches.length === 1) {
          this.startEdit(matches[0]);
        } else if (!q) {
          this.editingSku.set(null);
        }
      });
    });

    // Atajo desde Productos: /alertas?tab=reglas&sku=XXX abre directo en Reglas con el SKU
    // precargado en el buscador (dispara el effect de arriba si ya hay una regla; si no, queda
    // listo para pegarlo en "Vigilar un producto nuevo").
    effect(() => {
      const params = this.queryParams();
      if (!params) return;
      const tab = params.get('tab');
      const sku = params.get('sku');
      untracked(() => {
        if (tab === 'reglas' || tab === 'reponer' || tab === 'notificaciones' || tab === 'sin-alertas') this.activeTab.set(tab);
        if (sku) {
          this.rulesSearch.set(sku);
          this.newRuleQuery.set(sku);
        }
      });
    });
  }

  startEdit(rule: StockAlertRule): void {
    this.editingSku.set(rule.sku);
    this.editThreshold.set(rule.threshold);
  }

  cancelEdit(): void {
    this.editingSku.set(null);
  }

  async saveEdit(rule: StockAlertRule): Promise<void> {
    if (!Number.isFinite(this.editThreshold()) || this.editThreshold() < 0) return;
    this.savingRule.set(true);
    try {
      await this.alertsSvc.saveRule(rule.sku, this.editThreshold(), rule.productLabel ?? undefined);
      this.editingSku.set(null);
    } finally {
      this.savingRule.set(false);
    }
  }

  readonly deletingSku = signal<string | null>(null);

  isMuted(rule: StockAlertRule): boolean {
    return !!rule.mutedUntil && new Date(rule.mutedUntil).getTime() > Date.now();
  }

  async deleteRule(sku: string): Promise<void> {
    await this.alertsSvc.deleteRule(sku);
    this.deletingSku.set(null);
  }

  readonly newRuleQuery = signal('');
  readonly selectedNewSkus = signal<Map<string, ProductOption>>(new Map());
  newThreshold = 3;
  readonly addingRule = signal(false);
  addError: string | null = null;

  /** Debounce para no pegarle al backend en cada tecla (mismo patrón que el resto de la app). */
  private readonly debouncedNewRuleQuery = toSignal(
    toObservable(this.newRuleQuery).pipe(debounceTime(300), distinctUntilChanged()),
    { initialValue: '' }
  );

  /** Busca entre los productos matcheados (ML+TN por SKU), por título o SKU. */
  readonly newRuleSearchQuery = injectQuery(() => ({
    queryKey: ['alertas', 'product-search', this.debouncedNewRuleQuery()],
    queryFn: async (): Promise<ProductOption[]> => {
      const q = this.debouncedNewRuleQuery().trim();
      const analysis = await this.conflicts.getAnalysisPromise({ tab: 'coincidencias', search: q, limit: 15 });
      return (analysis.matched ?? [])
        .filter((pair) => !!(pair.sku || pair.ml.sku))
        .map((pair) => ({
          sku: (pair.sku || pair.ml.sku)!,
          label: mlLabel(pair.ml),
          thumbnail: pair.ml.thumbnail ?? pair.tn.thumbnail ?? null,
        }));
    },
    enabled: this.debouncedNewRuleQuery().trim().length >= 2,
    refetchOnWindowFocus: false,
    staleTime: 30 * 1000,
  }));

  readonly newRuleSearchLoading = computed(() => this.newRuleSearchQuery.isFetching());

  /** Resultados sin los que ya tienen una regla — para eso está la tabla de abajo, no esta alta. */
  readonly newRuleSearchResults = computed<ProductOption[]>(() => {
    const withRule = new Set(this.rules().map((r) => r.sku));
    return (this.newRuleSearchQuery.data() ?? []).filter((opt) => !withRule.has(opt.sku));
  });

  isNewRuleSelected(sku: string): boolean {
    return this.selectedNewSkus().has(sku);
  }

  toggleNewRuleSelected(opt: ProductOption): void {
    this.selectedNewSkus.update((m) => {
      const next = new Map(m);
      next.has(opt.sku) ? next.delete(opt.sku) : next.set(opt.sku, opt);
      return next;
    });
  }

  /** Agrega la misma regla (mismo umbral) a todos los productos tildados, de una. */
  async addSelectedRules(): Promise<void> {
    const options = [...this.selectedNewSkus().values()];
    if (!options.length) { this.addError = 'Buscá y tildá al menos un producto.'; return; }
    if (!Number.isFinite(this.newThreshold) || this.newThreshold < 0) { this.addError = 'El umbral tiene que ser 0 o más.'; return; }
    this.addingRule.set(true);
    this.addError = null;
    try {
      await Promise.all(options.map((opt) => this.alertsSvc.saveRule(opt.sku, this.newThreshold, opt.label)));
      this.selectedNewSkus.set(new Map());
      this.newRuleQuery.set('');
      this.newThreshold = 3;
    } catch (e: unknown) {
      const err = e as { error?: { error?: string }; message?: string };
      this.addError = err?.error?.error || err?.message || 'No se pudieron guardar algunas reglas.';
    } finally {
      this.addingRule.set(false);
    }
  }

  /* ══════════════════════════ Tabs ══════════════════════════ */

  readonly tabs = computed<TabDef[]>(() => {
    const reponerCount = this.restockRows().length;
    const unread = this.unreadCount();
    const unwatchedCount = this.unwatchedProducts().length;
    return [
      { key: 'reponer', label: 'Para reponer', count: reponerCount, countVariant: reponerCount ? 'warn' : undefined },
      { key: 'notificaciones', label: 'Notificaciones', count: unread, countVariant: unread ? 'warn' : undefined },
      { key: 'sin-alertas', label: 'Sin alertas', count: unwatchedCount, countVariant: unwatchedCount ? 'warn' : undefined },
      { key: 'reglas', label: 'Reglas', count: this.rules().length },
    ];
  });
}
