import { Component, inject, effect, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { CurrencyInputDirective } from '../../directives/currency-input.directive';
import {
  ConflictsService,
  CONFLICTS_ANALYSIS_QUERY_KEY,
  ConflictAnalysis,
  MlRow,
  TnRow,
  mlLabel,
  tnLabel,
  matchSearchByTokens
} from '../../core/services/conflicts.service';
import { injectQuery } from '@tanstack/angular-query-experimental';

@Component({
  selector: 'app-precio-stock',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, CurrencyInputDirective],
  templateUrl: './precio-stock.component.html',
  styleUrl: './precio-stock.component.scss'
})
export class PrecioStockComponent {
  private readonly conflicts = inject(ConflictsService);

  readonly analysisQuery = injectQuery(() => ({
    queryKey: CONFLICTS_ANALYSIS_QUERY_KEY,
    queryFn: () => this.conflicts.getAnalysisPromise(),
    refetchOnWindowFocus: false,
    /** No refetch al entrar si los datos son recientes. Tras 1 h se consideran viejos y puede refetchear al volver. */
    staleTime: 60 * 60 * 1000
  }));

  analysis = computed<ConflictAnalysis | null>(() => this.analysisQuery.data() ?? null);
  loading = computed(() => this.analysisQuery.isLoading());
  /** true cuando hay refetch en segundo plano (ej. tras actualizar precios/stock) */
  fetching = computed(() => this.analysisQuery.isFetching());
  error = computed<string | null>(() => {
    if (!this.analysisQuery.isError() || !this.analysisQuery.error()) return null;
    const err = this.analysisQuery.error() as { error?: { error?: string }; message?: string };
    return err?.error?.error ?? err?.message ?? 'Error al cargar.';
  });

  /** Por par: valores editables para precios y para el input de sincronizar stock */
  pairPrices: Map<string, { priceML: number; priceTN: number; syncStock: number }> = new Map();
  /** Valores guardados recientemente: se muestran sin hacer refetch a ML (evita 429). Se limpia al hacer "Actualizar lista". */
  localOverrides = signal<Map<string, { stock?: number; priceML?: number; priceTN?: number }>>(new Map());
  /** IDs de pares con actualización en cola o en proceso (Sincronizar / Actualizar precios). */
  savingPairIds = signal<Set<string>>(new Set());
  saveError: string | null = null;

  /** Cantidad de actualizaciones pendientes (en cola o guardando). */
  pendingUpdatesCount = computed(() => this.savingPairIds().size);

  isPairPending(pair: { ml: MlRow; tn: TnRow }): boolean {
    return this.savingPairIds().has(this.getPairId(pair));
  }

  /** 'all' | 'mismatch' | 'synced' | 'no-stock' | 'with-stock' */
  stockFilter = signal<'all' | 'mismatch' | 'synced' | 'no-stock' | 'with-stock'>('all');

  /** Búsqueda por título, SKU o nombre de variante (ML o TN). */
  searchQuery = signal('');

  protected mlLabel = mlLabel;
  protected tnLabel = tnLabel;

  private pairMatchesSearch(pair: { ml: MlRow; tn: TnRow }, q: string): boolean {
    const searchable =
      [pair.ml.title, pair.tn.productName, pair.ml.sku ?? pair.tn.sku, pair.ml.variationName, pair.tn.variantName]
        .filter(Boolean)
        .join(' ');
    return matchSearchByTokens(q, searchable);
  }

  /** Lista de pares según filtro de stock y búsqueda. */
  protected filteredMatched = computed(() => {
    const a = this.analysis();
    const matched = a?.matched ?? [];
    const filter = this.stockFilter();
    let list = matched;
    if (filter === 'mismatch') list = matched.filter((pair) => !this.isStockSynced(pair));
    else if (filter === 'synced') list = matched.filter((pair) => this.isStockSynced(pair));
    else if (filter === 'no-stock') list = matched.filter((pair) => this.hasNoStock(pair));
    else if (filter === 'with-stock') list = matched.filter((pair) => this.hasStock(pair));
    const q = this.searchQuery().trim().toLowerCase();
    if (q) list = list.filter((pair) => this.pairMatchesSearch(pair, q));
    return list;
  });

  /** Cantidad de pares con stock distinto entre ML y TN. */
  protected mismatchCount = computed(() => {
    const matched = this.analysis()?.matched ?? [];
    return matched.filter((pair) => !this.isStockSynced(pair)).length;
  });

  /** Cantidad de pares con mismo stock en ML y TN. */
  protected syncedCount = computed(() => {
    const matched = this.analysis()?.matched ?? [];
    return matched.filter((pair) => this.isStockSynced(pair)).length;
  });

  /** Cantidad de pares con stock 0 en al menos un canal. */
  protected noStockCount = computed(() => {
    const matched = this.analysis()?.matched ?? [];
    return matched.filter((pair) => this.hasNoStock(pair)).length;
  });

  /** Cantidad de pares con stock en ambos canales. */
  protected withStockCount = computed(() => {
    const matched = this.analysis()?.matched ?? [];
    return matched.filter((pair) => this.hasStock(pair)).length;
  });

  constructor() {
    effect(() => {
      if (this.analysis()) this.initPairPrices();
    });
  }

  refreshAnalysis(): void {
    this.localOverrides.set(new Map());
    this.conflicts.invalidateAnalysis();
  }

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
    this.savingPairIds.update((s) => {
      const n = new Set(s);
      n.add(pairId);
      return n;
    });
  }

  private removePendingPair(pairId: string): void {
    this.savingPairIds.update((s) => {
      const n = new Set(s);
      n.delete(pairId);
      return n;
    });
  }

  getPairId(pair: { ml: MlRow; tn: TnRow }): string {
    return `${pair.ml.itemId}:${pair.ml.variationId ?? ''}:${pair.tn.productId}:${pair.tn.variantId}`;
  }

  private initPairPrices(): void {
    this.pairPrices = new Map();
    const matched = this.analysis()?.matched;
    if (!matched) return;
    for (const pair of matched) {
      const id = this.getPairId(pair);
      const mlStock = pair.ml.stock ?? 0;
      const tnStock = pair.tn.stock ?? 0;
      this.pairPrices.set(id, {
        priceML: pair.ml.price ?? 0,
        priceTN: pair.tn.price ?? 0,
        syncStock: Math.min(mlStock, tnStock)
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
    const ml = this.getDisplayStock(pair, 'ml');
    const tn = this.getDisplayStock(pair, 'tn');
    return ml === tn;
  }

  /** true si al menos un canal tiene stock 0. */
  hasNoStock(pair: { ml: MlRow; tn: TnRow }): boolean {
    const ml = this.getDisplayStock(pair, 'ml');
    const tn = this.getDisplayStock(pair, 'tn');
    return ml === 0 || tn === 0;
  }

  /** true si ambos canales tienen stock > 0. */
  hasStock(pair: { ml: MlRow; tn: TnRow }): boolean {
    const ml = this.getDisplayStock(pair, 'ml');
    const tn = this.getDisplayStock(pair, 'tn');
    return ml > 0 && tn > 0;
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
      priceTN: p.priceTN
    }).subscribe({
      next: () => {
        this.removePendingPair(id);
        this.setLocalOverride(id, { priceML: p.priceML, priceTN: p.priceTN });
        const cur = this.pairPrices.get(id);
        if (cur) {
          cur.priceML = p.priceML;
          cur.priceTN = p.priceTN;
        }
        this.conflicts.updatePairInCache(id, { priceML: p.priceML, priceTN: p.priceTN });
      },
      error: (e) => {
        this.removePendingPair(id);
        this.saveError = e.error?.error || e.message || 'No se pudieron actualizar los precios.';
      }
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
      stockTN: stock
    }).subscribe({
      next: () => {
        this.removePendingPair(id);
        this.setLocalOverride(id, { stock });
        const cur = this.pairPrices.get(id);
        if (cur) cur.syncStock = stock;
        this.conflicts.updatePairInCache(id, { stock });
      },
      error: (e) => {
        this.removePendingPair(id);
        this.saveError = e.error?.error || e.message || 'No se pudo sincronizar el stock.';
      }
    });
  }
}
