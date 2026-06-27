import { Component, inject, effect, signal, computed, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { toSignal, toObservable } from '@angular/core/rxjs-interop';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';
import { CurrencyInputDirective } from '../../directives/currency-input.directive';
import {
  ConflictsService,
  ConflictAnalysis,
  MlRow,
  TnRow,
  mlLabel,
  tnLabel,
} from '../../core/services/conflicts.service';
import { injectQuery } from '@tanstack/angular-query-experimental';

const PAGE_SIZE = 25;
const ANALYSIS_BASE_KEY = ['conflicts', 'analysis'] as const;

@Component({
  selector: 'app-precio-stock',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, CurrencyInputDirective],
  templateUrl: './precio-stock.component.html',
  styleUrl: './precio-stock.component.scss'
})
export class PrecioStockComponent {
  private readonly conflicts = inject(ConflictsService);

  readonly PAGE_SIZE = PAGE_SIZE;

  readonly currentPage = signal(1);
  readonly stockFilter = signal<'all' | 'mismatch' | 'synced' | 'no-stock' | 'with-stock'>('all');
  readonly searchQuery = signal('');

  /** Búsqueda con debounce de 350 ms para no disparar un request por cada tecla. */
  readonly debouncedSearch = toSignal(
    toObservable(this.searchQuery).pipe(debounceTime(350), distinctUntilChanged()),
    { initialValue: '' }
  );

  /** Query key de la página actual; usado para actualizar la caché después de guardar. */
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

  /** Pares de la página actual (filtrados y paginados por el backend). */
  protected currentPagePairs = computed(() => this.analysis()?.matched ?? []);

  /** Metadata de paginación. */
  protected paging = computed(() =>
    this.analysis()?.paging ?? { page: 1, limit: PAGE_SIZE, total: 0, pages: 1 }
  );

  /** Resumen de stock para los tabs (total completo, independiente del filtro activo). */
  protected stockSummary = computed(() => this.analysis()?.stockSummary);

  /** IDs de cards colapsadas. */
  collapsedPairs = signal<Set<string>>(new Set());

  isPairCollapsed(pair: { ml: MlRow; tn: TnRow }): boolean {
    return this.collapsedPairs().has(this.getPairId(pair));
  }

  togglePair(pair: { ml: MlRow; tn: TnRow }): void {
    const id = this.getPairId(pair);
    this.collapsedPairs.update(s => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  /** true si todas las cards de la página están colapsadas. */
  allCollapsed = computed(() => {
    const pairs = this.currentPagePairs();
    if (!pairs.length) return false;
    const collapsed = this.collapsedPairs();
    return pairs.every(p => collapsed.has(this.getPairId(p)));
  });

  toggleAll(): void {
    if (this.allCollapsed()) {
      this.collapsedPairs.set(new Set());
    } else {
      this.collapsedPairs.set(new Set(this.currentPagePairs().map(p => this.getPairId(p))));
    }
  }

  /** Por par: valores editables para precios y para el input de sincronizar stock */
  pairPrices: Map<string, { priceML: number; priceTN: number; syncStock: number }> = new Map();
  /** Valores guardados recientemente: se muestran sin hacer refetch a ML (evita 429). Se limpia al hacer "Actualizar lista". */
  localOverrides = signal<Map<string, { stock?: number; priceML?: number; priceTN?: number }>>(new Map());
  /** IDs de pares con actualización en cola o en proceso. */
  savingPairIds = signal<Set<string>>(new Set());
  saveError: string | null = null;

  pendingUpdatesCount = computed(() => this.savingPairIds().size);

  isPairPending(pair: { ml: MlRow; tn: TnRow }): boolean {
    return this.savingPairIds().has(this.getPairId(pair));
  }

  protected mlLabel = mlLabel;
  protected tnLabel = tnLabel;

  constructor() {
    // Resetear a página 1 cuando cambia el filtro o la búsqueda debounced.
    effect(() => {
      this.stockFilter();
      this.debouncedSearch();
      untracked(() => this.currentPage.set(1));
    });

    // Inicializar precios/stock editables cuando llegan nuevos datos.
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
  prevPage(): void { this.goToPage(this.currentPage() - 1); }
  nextPage(): void { this.goToPage(this.currentPage() + 1); }

  /** Stock a mostrar para ML o TN; usa override si acabamos de sincronizar (sin refetch). */
  getDisplayStock(pair: { ml: MlRow; tn: TnRow }, channel: 'ml' | 'tn'): number {
    const id = this.getPairId(pair);
    const ov = this.localOverrides().get(id);
    if (ov?.stock !== undefined) return ov.stock;
    return channel === 'ml' ? (pair.ml.stock ?? 0) : (pair.tn.stock ?? 0);
  }

  private setLocalOverride(pairId: string, updates: { stock?: number; priceML?: number; priceTN?: number }): void {
    const prev = this.localOverrides();
    const next = new Map(prev);
    const cur = next.get(pairId) ?? {};
    next.set(pairId, { ...cur, ...updates });
    this.localOverrides.set(next);
  }

  private addPendingPair(pairId: string): void {
    this.savingPairIds.update((s) => { const n = new Set(s); n.add(pairId); return n; });
  }

  private removePendingPair(pairId: string): void {
    this.savingPairIds.update((s) => { const n = new Set(s); n.delete(pairId); return n; });
  }

  getPairId(pair: { ml: MlRow; tn: TnRow }): string {
    return `${pair.ml.itemId}:${pair.ml.variationId ?? ''}:${pair.tn.productId}:${pair.tn.variantId}`;
  }

  private initPairPrices(): void {
    const matched = this.analysis()?.matched;
    if (!matched) return;
    for (const pair of matched) {
      const id = this.getPairId(pair);
      if (this.pairPrices.has(id)) continue;
      const mlStock = pair.ml.stock ?? 0;
      const tnStock = pair.tn.stock ?? 0;
      this.pairPrices.set(id, {
        priceML: pair.ml.price ?? 0,
        priceTN: pair.tn.price ?? 0,
        syncStock: Math.min(mlStock, tnStock),
      });
    }
  }

  getPairPrices(pair: { ml: MlRow; tn: TnRow }): { priceML: number; priceTN: number; syncStock: number } {
    const id = this.getPairId(pair);
    let p = this.pairPrices.get(id);
    if (!p) {
      const mlStock = pair.ml.stock ?? 0;
      const tnStock = pair.tn.stock ?? 0;
      p = { priceML: pair.ml.price ?? 0, priceTN: pair.tn.price ?? 0, syncStock: Math.min(mlStock, tnStock) };
      this.pairPrices.set(id, p);
    }
    return p;
  }

  isStockSynced(pair: { ml: MlRow; tn: TnRow }): boolean {
    return this.getDisplayStock(pair, 'ml') === this.getDisplayStock(pair, 'tn');
  }

  hasNoStock(pair: { ml: MlRow; tn: TnRow }): boolean {
    return this.getDisplayStock(pair, 'ml') === 0 || this.getDisplayStock(pair, 'tn') === 0;
  }

  updatePrices(pair: { ml: MlRow; tn: TnRow }): void {
    const id = this.getPairId(pair);
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
    const id = this.getPairId(pair);
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
}
