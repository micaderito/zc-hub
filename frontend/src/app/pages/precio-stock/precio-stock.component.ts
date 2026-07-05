import { Component, inject, effect, signal, computed, untracked, DestroyRef } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { toSignal, toObservable, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { debounceTime, distinctUntilChanged, switchMap, takeUntil } from 'rxjs/operators';
import { timer, Subject } from 'rxjs';
import {
  ConflictsService,
  ConflictAnalysis,
  MlRow,
  TnRow,
  getPairId,
} from '../../core/services/conflicts.service';
import { injectQuery, keepPreviousData } from '@tanstack/angular-query-experimental';
import { SearchBarComponent } from '../../shared/components/search-bar/search-bar.component';
import { PaginationComponent } from '../../shared/components/pagination/pagination.component';
import { ConfirmDialogComponent } from '../../shared/components/confirm-dialog/confirm-dialog.component';
import { StockFilterTabsComponent, StockFilter } from './components/stock-filter-tabs/stock-filter-tabs.component';
import { PairCardComponent, PairPrices } from './components/pair-card/pair-card.component';

const PAGE_SIZE = 25;
const ANALYSIS_BASE_KEY = ['conflicts', 'analysis'] as const;

@Component({
  selector: 'app-precio-stock',
  standalone: true,
  imports: [RouterLink, CurrencyPipe, SearchBarComponent, PaginationComponent, ConfirmDialogComponent, StockFilterTabsComponent, PairCardComponent],
  templateUrl: './precio-stock.component.html',
  styleUrl: './precio-stock.component.scss'
})
export class PrecioStockComponent {
  private readonly conflicts = inject(ConflictsService);
  private readonly destroyRef = inject(DestroyRef);

  readonly currentPage = signal(1);
  readonly stockFilter = signal<StockFilter>('all');
  readonly searchQuery = signal('');

  readonly debouncedSearch = toSignal(
    toObservable(this.searchQuery).pipe(debounceTime(350), distinctUntilChanged()),
    { initialValue: '' }
  );

  private get currentQueryKey() {
    return [...ANALYSIS_BASE_KEY, this.currentPage(), this.stockFilter(), this.debouncedSearch()] as const;
  }

  readonly analysisQuery = injectQuery(() => ({
    queryKey: [...ANALYSIS_BASE_KEY, this.currentPage(), this.stockFilter(), this.debouncedSearch()],
    queryFn: () => this.conflicts.getAnalysisPromise({
      page: this.currentPage(),
      limit: PAGE_SIZE,
      filter: this.stockFilter(),
      search: this.debouncedSearch() || undefined,
    }),
    refetchOnWindowFocus: false,
    staleTime: 60 * 60 * 1000,
    placeholderData: keepPreviousData,
  }));

  analysis = computed<ConflictAnalysis | null>(() => this.analysisQuery.data() ?? null);
  loading = computed(() => this.analysisQuery.isLoading());
  fetching = computed(() => this.analysisQuery.isFetching());
  /** Refresh manual en curso (crawl a los canales): el force va por fuera de la query, así que
   *  lo trackeamos aparte para mostrar el loading del botón desde el click y no solo al final. */
  readonly refreshing = signal(false);
  readonly busy = computed(() => this.fetching() || this.refreshing());
  error = computed<string | null>(() => {
    if (!this.analysisQuery.isError() || !this.analysisQuery.error()) return null;
    const err = this.analysisQuery.error() as { error?: { error?: string }; message?: string };
    return err?.error?.error ?? err?.message ?? 'Error al cargar.';
  });

  protected currentPagePairs = computed(() => this.analysis()?.matched ?? []);
  protected paging = computed(() =>
    this.analysis()?.paging ?? { page: 1, limit: PAGE_SIZE, total: 0, pages: 1 }
  );
  protected stockSummary = computed(() => this.analysis()?.stockSummary);
  protected stockTotal = computed(() => this.analysis()?.stockTotal);

  collapsedPairs = signal<Set<string>>(new Set());

  isPairCollapsed(pair: { ml: MlRow; tn: TnRow }): boolean {
    return this.collapsedPairs().has(getPairId(pair));
  }

  togglePair(pair: { ml: MlRow; tn: TnRow }): void {
    const id = getPairId(pair);
    this.collapsedPairs.update(s => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  allCollapsed = computed(() => {
    const pairs = this.currentPagePairs();
    if (!pairs.length) return false;
    const collapsed = this.collapsedPairs();
    return pairs.every(p => collapsed.has(getPairId(p)));
  });

  toggleAll(): void {
    if (this.allCollapsed()) {
      this.collapsedPairs.set(new Set());
    } else {
      this.collapsedPairs.set(new Set(this.currentPagePairs().map(p => getPairId(p))));
    }
  }

  pairPrices: Map<string, PairPrices> = new Map();
  localOverrides = signal<Map<string, { stock?: number; priceML?: number; priceTN?: number }>>(new Map());
  savingPairIds = signal<Set<string>>(new Set());
  pairErrors = signal<Map<string, string>>(new Map());
  saveError: string | null = null;

  private readonly pollStop = new Map<string, Subject<void>>();

  pendingUpdatesCount = computed(() => this.savingPairIds().size);

  isPairPending(pair: { ml: MlRow; tn: TnRow }): boolean {
    return this.savingPairIds().has(getPairId(pair));
  }

  getPairError(pair: { ml: MlRow; tn: TnRow }): string | null {
    return this.pairErrors().get(getPairId(pair)) ?? null;
  }

  private setPairError(pairId: string, msg: string): void {
    this.pairErrors.update(m => { const n = new Map(m); n.set(pairId, msg); return n; });
  }

  clearPairError(pairId: string): void {
    this.pairErrors.update(m => { const n = new Map(m); n.delete(pairId); return n; });
  }

  constructor() {
    effect(() => {
      this.stockFilter();
      this.debouncedSearch();
      untracked(() => this.currentPage.set(1));
    });

    effect(() => {
      if (this.analysis()) this.initPairPrices();
    });
  }

  async refreshAnalysis(): Promise<void> {
    if (this.refreshing()) return;
    this.localOverrides.set(new Map());
    this.refreshing.set(true);
    try {
      await this.conflicts.forceRefresh();
    } finally {
      this.refreshing.set(false);
    }
  }

  goToPage(page: number): void {
    const { pages } = this.paging();
    if (page >= 1 && page <= pages) this.currentPage.set(page);
  }

  getDisplayStock(pair: { ml: MlRow; tn: TnRow }, channel: 'ml' | 'tn'): number {
    const id = getPairId(pair);
    const ov = this.localOverrides().get(id);
    if (ov?.stock !== undefined) return ov.stock;
    return channel === 'ml' ? (pair.ml.stock ?? 0) : (pair.tn.stock ?? 0);
  }

  private setLocalOverride(pairId: string, updates: { stock?: number; priceML?: number; priceTN?: number }): void {
    const next = new Map(this.localOverrides());
    next.set(pairId, { ...next.get(pairId), ...updates });
    this.localOverrides.set(next);
  }

  private addPendingPair(pairId: string): void {
    this.savingPairIds.update(s => { const n = new Set(s); n.add(pairId); return n; });
  }

  private removePendingPair(pairId: string): void {
    this.savingPairIds.update(s => { const n = new Set(s); n.delete(pairId); return n; });
  }

  /** Otras filas de la página actual que comparten el mismo producto TN (variantes hermanas). */
  private tnSiblingPairs(pair: { ml: MlRow; tn: TnRow }): { ml: MlRow; tn: TnRow }[] {
    return this.currentPagePairs().filter(p => p.tn.productId === pair.tn.productId);
  }

  /**
   * Pares afectados por un update de precio. En variaciones ML (legacy) el precio se aplica a
   * todas las variaciones del ítem sí o sí, así que se bloquean todas las filas del mismo itemId.
   * En TN el "aplicar a todas las variantes" es una elección del usuario (applyTnAll), así que
   * solo se bloquean las filas hermanas cuando esa elección fue confirmada.
   */
  private pairIdsForPriceUpdate(pair: { ml: MlRow; tn: TnRow }, applyTnAll: boolean): string[] {
    const ids = new Set<string>([getPairId(pair)]);
    if (pair.ml.variationId) {
      for (const p of this.currentPagePairs()) {
        if (p.ml.itemId === pair.ml.itemId) ids.add(getPairId(p));
      }
    }
    if (applyTnAll) {
      for (const p of this.tnSiblingPairs(pair)) ids.add(getPairId(p));
    }
    return [...ids];
  }

  private addPricePending(pair: { ml: MlRow; tn: TnRow }, applyTnAll: boolean): void {
    for (const id of this.pairIdsForPriceUpdate(pair, applyTnAll)) this.addPendingPair(id);
  }

  private removePricePending(pair: { ml: MlRow; tn: TnRow }, applyTnAll: boolean): void {
    for (const id of this.pairIdsForPriceUpdate(pair, applyTnAll)) this.removePendingPair(id);
  }

  private initPairPrices(): void {
    for (const pair of this.analysis()?.matched ?? []) {
      const id = getPairId(pair);
      if (this.pairPrices.has(id)) continue;
      this.pairPrices.set(id, {
        priceML: pair.ml.price ?? 0,
        priceTN: pair.tn.price ?? 0,
        syncStock: Math.min(pair.ml.stock ?? 0, pair.tn.stock ?? 0),
      });
    }
  }

  getPairPrices(pair: { ml: MlRow; tn: TnRow }): PairPrices {
    const id = getPairId(pair);
    let p = this.pairPrices.get(id);
    if (!p) {
      p = {
        priceML: pair.ml.price ?? 0,
        priceTN: pair.tn.price ?? 0,
        syncStock: Math.min(pair.ml.stock ?? 0, pair.tn.stock ?? 0),
      };
      this.pairPrices.set(id, p);
    }
    return p;
  }

  updatePrices(pair: { ml: MlRow; tn: TnRow }): void {
    const p = this.getPairPrices(pair);
    if (p.priceML <= 0 && p.priceTN <= 0) {
      this.saveError = 'Ingresá al menos un precio mayor a 0.';
      return;
    }
    const priceMLChanged = p.priceML > 0 && Number(p.priceML) !== Number(pair.ml.price ?? 0);
    const priceTNChanged = p.priceTN > 0 && Number(p.priceTN) !== Number(pair.tn.price ?? 0);

    // ML no permite precio distinto por variación en ítems con variaciones (legacy):
    // aplicar el precio ML afecta a TODAS las variaciones. Si el precio ML cambió y es una
    // variación, pedir confirmación (modal de Mercado Libre) antes de seguir.
    if (priceMLChanged && pair.ml.variationId) {
      this.confirmPriceAllML.set({ pair, priceML: p.priceML, priceTN: p.priceTN, priceTNChanged });
      return;
    }
    this.continueAfterMlConfirmation(pair, p.priceML, p.priceTN, priceTNChanged);
  }

  /**
   * Segundo paso, independiente del de ML: en TN el precio SÍ se puede fijar por variante
   * (no hay limitación de la API), así que si el precio TN cambió le preguntamos al usuario
   * si quiere aplicarlo a todas las variantes del producto TN o solo a la variante editada
   * (modal separado y con el nombre de la plataforma explícito, distinto del de ML).
   */
  private continueAfterMlConfirmation(pair: { ml: MlRow; tn: TnRow }, priceML: number, priceTN: number, priceTNChanged: boolean): void {
    if (priceTNChanged && this.tnSiblingPairs(pair).length > 1) {
      this.confirmPriceAllTN.set({ pair, priceML, priceTN });
      return;
    }
    this.doUpdatePrices(pair, priceML, priceTN, false);
  }

  /** Confirmación pendiente de aplicar el precio ML a todas las variaciones de un ítem (Mercado Libre). */
  confirmPriceAllML = signal<{ pair: { ml: MlRow; tn: TnRow }; priceML: number; priceTN: number; priceTNChanged: boolean } | null>(null);

  confirmApplyPriceToAllML(): void {
    const c = this.confirmPriceAllML();
    if (!c) return;
    this.confirmPriceAllML.set(null);
    this.continueAfterMlConfirmation(c.pair, c.priceML, c.priceTN, c.priceTNChanged);
  }

  cancelApplyPriceToAllML(): void {
    this.confirmPriceAllML.set(null);
  }

  /** Confirmación pendiente de aplicar el precio TN a todas las variantes de un producto (Tienda Nube). */
  confirmPriceAllTN = signal<{ pair: { ml: MlRow; tn: TnRow }; priceML: number; priceTN: number } | null>(null);

  confirmApplyPriceToAllTN(): void {
    const c = this.confirmPriceAllTN();
    if (!c) return;
    this.confirmPriceAllTN.set(null);
    this.doUpdatePrices(c.pair, c.priceML, c.priceTN, true);
  }

  /** El usuario eligió aplicar el precio TN solo a la variante que editó, no a las demás. */
  applyPriceOnlyThisVariantTN(): void {
    const c = this.confirmPriceAllTN();
    if (!c) return;
    this.confirmPriceAllTN.set(null);
    this.doUpdatePrices(c.pair, c.priceML, c.priceTN, false);
  }

  private doUpdatePrices(pair: { ml: MlRow; tn: TnRow }, priceML: number, priceTN: number, applyTnAll: boolean): void {
    const id = getPairId(pair);
    this.saveError = null;
    this.clearPairError(id);
    this.addPricePending(pair, applyTnAll);
    this.conflicts.updatePricesAndStock({
      itemId: pair.ml.itemId,
      variationId: pair.ml.variationId,
      productId: pair.tn.productId,
      variantId: pair.tn.variantId,
      priceML,
      priceTN,
      applyTnToAllVariants: applyTnAll,
    }).subscribe({
      next: (res) => {
        if (res.mlTaskId) {
          // Precio ML encolado: mantener pending y hacer polling hasta que el worker confirme
          this.pollMlTask(pair, res.mlTaskId, { priceML, priceTN }, applyTnAll);
        } else {
          this.removePricePending(pair, applyTnAll);
          this.applyPricesLocally(pair, { priceML, priceTN }, applyTnAll);
        }
      },
      error: (e) => {
        this.removePricePending(pair, applyTnAll);
        this.setPairError(id, e.error?.error || e.message || 'No se pudieron actualizar los precios.');
      },
    });
  }

  /**
   * Refleja en la UI el resultado de un update de precio.
   * - Si el par ML es una variación, ML aplicó el precio a TODAS las variaciones del ítem
   *   (legacy), así que propagamos el nuevo precio ML a todas las filas del mismo itemId.
   * - Si el usuario eligió aplicar el precio TN a todas las variantes (applyTnAll), propagamos
   *   el nuevo precio TN a todas las filas del mismo producto TN.
   */
  private applyPricesLocally(pair: { ml: MlRow; tn: TnRow }, prices: { priceML: number; priceTN: number }, applyTnAll: boolean): void {
    const id = getPairId(pair);
    this.setLocalOverride(id, prices);
    const cur = this.pairPrices.get(id);
    if (cur) { cur.priceML = prices.priceML; cur.priceTN = prices.priceTN; }
    this.conflicts.updatePairInCache(id, prices, this.currentQueryKey);

    if (pair.ml.variationId) {
      // Precio aplicado a todas las variaciones del ítem: actualizar las demás filas.
      this.conflicts.updateItemVariationsPriceInCache(pair.ml.itemId, prices.priceML, this.currentQueryKey);
      for (const other of this.currentPagePairs()) {
        if (other.ml.itemId !== pair.ml.itemId) continue;
        const oid = getPairId(other);
        this.setLocalOverride(oid, { priceML: prices.priceML });
        const oc = this.pairPrices.get(oid);
        if (oc) oc.priceML = prices.priceML;
      }
    }

    if (applyTnAll) {
      // Precio TN aplicado a todas las variantes del producto: actualizar las demás filas.
      this.conflicts.updateProductVariantsPriceInCache(pair.tn.productId, prices.priceTN, this.currentQueryKey);
      for (const other of this.tnSiblingPairs(pair)) {
        const oid = getPairId(other);
        this.setLocalOverride(oid, { priceTN: prices.priceTN });
        const oc = this.pairPrices.get(oid);
        if (oc) oc.priceTN = prices.priceTN;
      }
    }
  }

  private pollMlTask(pair: { ml: MlRow; tn: TnRow }, taskId: number, intendedPrices: { priceML: number; priceTN: number }, applyTnAll: boolean): void {
    const pairId = getPairId(pair);
    this.pollStop.get(pairId)?.next();
    const stop$ = new Subject<void>();
    this.pollStop.set(pairId, stop$);

    timer(1500, 2000).pipe(
      switchMap(() => this.conflicts.getTaskStatus(taskId)),
      takeUntil(stop$),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: (task) => {
        if (task.status === 'done') {
          stop$.next();
          this.pollStop.delete(pairId);
          this.removePricePending(pair, applyTnAll);
          this.applyPricesLocally(pair, intendedPrices, applyTnAll);
        } else if (task.status === 'failed') {
          stop$.next();
          this.pollStop.delete(pairId);
          this.removePricePending(pair, applyTnAll);
          this.setPairError(pairId, task.lastError || 'Error al actualizar el precio en Mercado Libre.');
        }
      },
      error: () => {
        stop$.next();
        this.pollStop.delete(pairId);
        this.removePricePending(pair, applyTnAll);
        this.setPairError(pairId, 'No se pudo verificar el estado de la actualización en ML.');
      },
    });
  }

  syncStock(pair: { ml: MlRow; tn: TnRow }): void {
    const id = getPairId(pair);
    const p = this.getPairPrices(pair);
    const stock = Math.max(0, Math.floor(p.syncStock));
    this.saveError = null;
    this.addPendingPair(id);
    this.conflicts.updatePricesAndStock({
      itemId: pair.ml.itemId,
      variationId: pair.ml.variationId,
      productId: pair.tn.productId,
      variantId: pair.tn.variantId,
      priceML: 0,
      priceTN: 0,
      stockML: stock,
      stockTN: stock,
    }).subscribe({
      next: (res) => {
        if (res.mlStockTaskId) {
          // El stock ML quedó encolado (se aplica en segundo plano, con reintentos ante 429):
          // esperar a que el worker confirme antes de reflejarlo como sincronizado.
          this.pollMlStockTask(pair, res.mlStockTaskId, stock);
        } else {
          this.removePendingPair(id);
          this.applyStockLocally(pair, stock);
        }
      },
      error: (e) => {
        this.removePendingPair(id);
        this.saveError = e.error?.error || e.message || 'No se pudo sincronizar el stock.';
      },
    });
  }

  private applyStockLocally(pair: { ml: MlRow; tn: TnRow }, stock: number): void {
    const id = getPairId(pair);
    this.setLocalOverride(id, { stock });
    const cur = this.pairPrices.get(id);
    if (cur) cur.syncStock = stock;
    this.conflicts.updatePairInCache(id, { stock }, this.currentQueryKey, this.stockFilter());
  }

  private pollMlStockTask(pair: { ml: MlRow; tn: TnRow }, taskId: number, stock: number): void {
    const pairId = getPairId(pair);
    const pollKey = `${pairId}::stock`;
    this.pollStop.get(pollKey)?.next();
    const stop$ = new Subject<void>();
    this.pollStop.set(pollKey, stop$);

    timer(1500, 2000).pipe(
      switchMap(() => this.conflicts.getTaskStatus(taskId)),
      takeUntil(stop$),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: (task) => {
        if (task.status === 'done') {
          stop$.next();
          this.pollStop.delete(pollKey);
          this.removePendingPair(pairId);
          this.applyStockLocally(pair, stock);
        } else if (task.status === 'failed') {
          stop$.next();
          this.pollStop.delete(pollKey);
          this.removePendingPair(pairId);
          this.saveError = task.lastError || 'Mercado Libre no pudo actualizar el stock.';
        }
      },
      error: () => {
        stop$.next();
        this.pollStop.delete(pollKey);
        this.removePendingPair(pairId);
        this.saveError = 'No se pudo verificar el estado de la actualización de stock en ML.';
      },
    });
  }

  protected getPairId = getPairId;
}
