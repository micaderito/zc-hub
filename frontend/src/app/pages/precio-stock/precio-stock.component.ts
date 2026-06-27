import { Component, inject, effect, signal, computed, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { toSignal, toObservable } from '@angular/core/rxjs-interop';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';
import {
  ConflictsService,
  ConflictAnalysis,
  MlRow,
  TnRow,
  getPairId,
} from '../../core/services/conflicts.service';
import { injectQuery } from '@tanstack/angular-query-experimental';
import { SearchBarComponent } from '../../shared/components/search-bar/search-bar.component';
import { PaginationComponent } from '../../shared/components/pagination/pagination.component';
import { StockFilterTabsComponent, StockFilter } from './components/stock-filter-tabs/stock-filter-tabs.component';
import { PairCardComponent, PairPrices } from './components/pair-card/pair-card.component';

const PAGE_SIZE = 25;
const ANALYSIS_BASE_KEY = ['conflicts', 'analysis'] as const;

@Component({
  selector: 'app-precio-stock',
  standalone: true,
  imports: [RouterLink, SearchBarComponent, PaginationComponent, StockFilterTabsComponent, PairCardComponent],
  templateUrl: './precio-stock.component.html',
  styleUrl: './precio-stock.component.scss'
})
export class PrecioStockComponent {
  private readonly conflicts = inject(ConflictsService);

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
  }));

  analysis = computed<ConflictAnalysis | null>(() => this.analysisQuery.data() ?? null);
  loading = computed(() => this.analysisQuery.isLoading());
  fetching = computed(() => this.analysisQuery.isFetching());
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
  saveError: string | null = null;

  pendingUpdatesCount = computed(() => this.savingPairIds().size);

  isPairPending(pair: { ml: MlRow; tn: TnRow }): boolean {
    return this.savingPairIds().has(getPairId(pair));
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

  refreshAnalysis(): void {
    this.localOverrides.set(new Map());
    this.conflicts.invalidateAnalysis();
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
    const id = getPairId(pair);
    const p = this.getPairPrices(pair);
    if (p.priceML <= 0 && p.priceTN <= 0) {
      this.saveError = 'Ingresá al menos un precio mayor a 0.';
      return;
    }
    this.saveError = null;
    this.addPendingPair(id);
    this.conflicts.updatePricesAndStock({
      itemId: pair.ml.itemId,
      variationId: pair.ml.variationId,
      productId: pair.tn.productId,
      variantId: pair.tn.variantId,
      priceML: p.priceML,
      priceTN: p.priceTN,
    }).subscribe({
      next: () => {
        this.removePendingPair(id);
        this.setLocalOverride(id, { priceML: p.priceML, priceTN: p.priceTN });
        const cur = this.pairPrices.get(id);
        if (cur) { cur.priceML = p.priceML; cur.priceTN = p.priceTN; }
        this.conflicts.updatePairInCache(id, { priceML: p.priceML, priceTN: p.priceTN }, this.currentQueryKey);
      },
      error: (e) => {
        this.removePendingPair(id);
        this.saveError = e.error?.error || e.message || 'No se pudieron actualizar los precios.';
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
      next: () => {
        this.removePendingPair(id);
        this.setLocalOverride(id, { stock });
        const cur = this.pairPrices.get(id);
        if (cur) cur.syncStock = stock;
        this.conflicts.updatePairInCache(id, { stock }, this.currentQueryKey);
      },
      error: (e) => {
        this.removePendingPair(id);
        this.saveError = e.error?.error || e.message || 'No se pudo sincronizar el stock.';
      },
    });
  }

  protected getPairId = getPairId;
}
