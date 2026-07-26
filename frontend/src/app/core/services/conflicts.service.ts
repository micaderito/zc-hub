import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams, HttpHeaders } from '@angular/common/http';
import { Observable, Subject } from 'rxjs';
import { lastValueFrom } from 'rxjs';
import { QueryClient } from '@tanstack/angular-query-experimental';
import { ApiService } from './api.service';
import { StockFilter } from '../../pages/precio-stock/components/stock-filter-tabs/stock-filter-tabs.component';

/** Debounce (ms) antes de refetch tras invalidar: varios "Sincronizar"/"Actualizar" seguidos = un solo GET. */
const REFETCH_DEBOUNCE_MS = 600;

/** Query key del análisis de conflictos; invalidar en cada add/edit/delete. */
export const CONFLICTS_ANALYSIS_QUERY_KEY = ['conflicts', 'analysis'] as const;

/** Identificador único de un par ML–TN (mismo que PrecioStockComponent.getPairId). */
export function getPairId(pair: { ml: MlRow; tn: TnRow }): string {
  return `${pair.ml.itemId}:${pair.ml.variationId ?? ''}:${pair.tn.productId}:${pair.tn.variantId}`;
}

/** Una tarea de ML todavía en cola (pending/processing), tal como la devuelve /sync/active-tasks. */
export interface ActiveMlTask {
  kind: string;
  itemId: string;
  variationId: string | null;
}

export interface ActiveTasksResponse {
  tasks: ActiveMlTask[];
}

/** Tipos de tarea que mueven stock en ML: son las que pueden explicar un "stock distinto" transitorio. */
const STOCK_TASK_KINDS = ['stock_ml_set', 'stock_ml'];

/** Clave ítem+variación, para cruzar una tarea en cola con la fila del par que le corresponde. */
export function getMlTaskKey(itemId: string, variationId: string | null | undefined): string {
  return `${itemId}:${variationId ?? ''}`;
}

/**
 * Claves de los ítems/variaciones con un cambio de STOCK todavía en cola. Solo tareas de stock:
 * una tarea de precio en vuelo no explica que los stocks difieran, así que no debe tapar el badge.
 */
export function stockTaskKeys(tasks: ActiveMlTask[]): Set<string> {
  return new Set(
    tasks
      .filter(t => STOCK_TASK_KINDS.includes(t.kind))
      .map(t => getMlTaskKey(t.itemId, t.variationId))
  );
}

export interface MlRow {
  type: 'ml';
  itemId: string;
  variationId: string | null;
  /** Nombre legible de la variante (ej. "Negro · A4") cuando hay attribute_combinations */
  variationName?: string | null;
  title: string;
  sku: string | null;
  hasSku: boolean;
  /** Precio actual en ML */
  price?: number;
  /** Stock actual en ML */
  stock?: number;
  thumbnail?: string | null;
}

export interface TnRow {
  type: 'tn';
  productId: number;
  variantId: number;
  /** Nombre legible de la variante (ej. "A4 · Raya") desde values */
  variantName?: string | null;
  productName: string;
  sku: string | null;
  hasSku: boolean;
  /** Precio actual en TN */
  price?: number;
  /** Stock actual en TN */
  stock?: number;
  thumbnail?: string | null;
}

export interface ConflictAnalysis {
  mlConnected: boolean;
  tnConnected: boolean;
  /** true cuando el token de ML venció y el refresh falló; hay que reconectar desde Inicio */
  mlAuthError?: boolean;
  summary: {
    totalML?: number;
    totalTN?: number;
    matched: number;
    onlyML: number;
    onlyTN: number;
    noSkuML: number;
    noSkuTN: number;
    duplicateSkuML: number;
    duplicateSkuTN: number;
    resolved: number;
  };
  /** Pares con mismo SKU en ambos; los del mapeo pueden tener sku aunque ML aún no lo muestre */
  matched: { ml: MlRow; tn: TnRow; sku?: string }[];
  onlyML: MlRow[];
  onlyTN: TnRow[];
  noSkuML: MlRow[];
  noSkuTN: TnRow[];
  duplicateSkuML: { sku: string; items: MlRow[] }[];
  duplicateSkuTN: { sku: string; items: TnRow[] }[];
  mappings: unknown[];
  /** Metadata de paginación del backend (el backend siempre la incluye, incluso para tabs sin paginado real) */
  paging: { page: number; limit: number; total: number; pages: number };
  /** Totales por filtro de stock (del full dataset, no de la página actual) */
  stockSummary?: { total: number; mismatch: number; synced: number; noStock: number; withStock: number };
  /** Stock total (unidades) y cantidad de productos que matchean el filtro/búsqueda activos */
  stockTotal?: { units: number; products: number };
}

/** Etiqueta legible para una fila ML (título + nombre de variante). */
export function mlLabel(row: MlRow): string {
  if (!row.variationId) return row.title;
  const varLabel = (row.variationName || '').trim();
  return varLabel ? `${row.title} (${varLabel})` : `${row.title} (var. ${row.variationId})`;
}

/** Etiqueta legible para una fila TN (producto + nombre de variante). */
export function tnLabel(row: TnRow): string {
  const varLabel = (row.variantName || '').trim();
  return varLabel ? `${row.productName} (${varLabel})` : `${row.productName} – Var ${row.variantId}`;
}

/**
 * Indica si el texto buscable contiene todas las palabras del query (cada token debe aparecer).
 * Ej: query "rep a5 cuad" coincide con "repuesto a5 removible cuadriculado".
 */
export function matchSearchByTokens(searchQuery: string, searchableText: string): boolean {
  const q = searchQuery.trim().toLowerCase();
  if (!q) return true;
  const text = (searchableText || '').toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  return tokens.every((t) => text.includes(t));
}

/** Buckets de stock que alimentan los chips de arriba; replica la lógica de GET /conflicts en el backend. */
function stockCategories(mlStock: number, tnStock: number) {
  return {
    mismatch: mlStock !== tnStock,
    synced: mlStock === tnStock,
    noStock: mlStock === 0 || tnStock === 0,
    withStock: mlStock > 0 && tnStock > 0,
  };
}

/** Si un par con este stock pertenece al filtro activo; replica el filtro server-side de GET /conflicts. */
function matchesStockFilter(filter: StockFilter, mlStock: number, tnStock: number): boolean {
  if (filter === 'mismatch') return mlStock !== tnStock;
  if (filter === 'synced') return mlStock === tnStock;
  if (filter === 'no-stock') return mlStock === 0 || tnStock === 0;
  if (filter === 'with-stock') return mlStock > 0 && tnStock > 0;
  return true; // 'all'
}

@Injectable({ providedIn: 'root' })
export class ConflictsService {
  private readonly queryClient = inject(QueryClient);

  /** Emite cuando hubo una mutación; compatibilidad con código que no use TanStack. */
  private readonly analysisInvalidated = new Subject<void>();
  readonly analysisInvalidated$: Observable<void> = this.analysisInvalidated.asObservable();

  private refetchTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private http: HttpClient,
    private api: ApiService
  ) {}

  /** Invalida la caché y dispara un refetch. Con debounce: varios clics seguidos = un solo GET. */
  invalidateAnalysis(): void {
    this.analysisInvalidated.next();
    if (this.refetchTimeout !== null) clearTimeout(this.refetchTimeout);
    this.refetchTimeout = setTimeout(() => {
      this.refetchTimeout = null;
      this.queryClient.invalidateQueries({ queryKey: CONFLICTS_ANALYSIS_QUERY_KEY });
    }, REFETCH_DEBOUNCE_MS);
  }

  /**
   * Actualiza en caché solo el par recién guardado. No hace refetch: así evitamos
   * disparar ~14 requests a ML por cada "Sincronizar"/"Actualizar" (doc ML: distribuir requisiciones).
   * La UI muestra el cambio al instante vía overrides locales en el componente.
   *
   * Cuando `updates.stock` viene seteado, además ajusta localmente los chips de arriba
   * (`stockSummary` y `stockTotal`, ver GET /conflicts en el backend para la lógica que replica)
   * y, si se pasa el `filter` activo, saca el par de la lista visible cuando deja de pertenecer a
   * ese filtro (ej.: estando en "Stock distinto", sincronizar un par lo pasa a "Mismo stock" y debe
   * desaparecer).
   * @param queryKey - Query key exacto de la página actual; si no se provee, se intenta con el key base.
   */
  updatePairInCache(
    pairId: string,
    updates: { stock?: number; priceML?: number; priceTN?: number },
    queryKey?: readonly unknown[],
    filter?: StockFilter
  ): void {
    const key = queryKey ?? CONFLICTS_ANALYSIS_QUERY_KEY;
    const prev = this.queryClient.getQueryData<ConflictAnalysis>(key as unknown[]);
    if (!prev?.matched) return;

    const target = prev.matched.find((pair) => getPairId(pair) === pairId);
    if (!target) return;

    const oldMl = target.ml.stock ?? 0;
    const oldTn = target.tn.stock ?? 0;
    const newMl = updates.stock !== undefined ? updates.stock : oldMl;
    const newTn = updates.stock !== undefined ? updates.stock : oldTn;

    let matched = prev.matched.map((pair) => {
      if (getPairId(pair) !== pairId) return pair;
      const ml = updates.stock !== undefined ? { ...pair.ml, stock: updates.stock } : pair.ml;
      const tn = updates.stock !== undefined ? { ...pair.tn, stock: updates.stock } : pair.tn;
      const ml2 = updates.priceML !== undefined ? { ...ml, price: updates.priceML } : ml;
      const tn2 = updates.priceTN !== undefined ? { ...tn, price: updates.priceTN } : tn;
      return { ...pair, ml: ml2, tn: tn2 };
    });

    let stockSummary = prev.stockSummary;
    let stockTotal = prev.stockTotal;
    let paging = prev.paging;

    if (updates.stock !== undefined) {
      if (stockSummary) {
        const oldCat = stockCategories(oldMl, oldTn);
        const newCat = stockCategories(newMl, newTn);
        stockSummary = {
          total: stockSummary.total,
          mismatch: stockSummary.mismatch + (Number(newCat.mismatch) - Number(oldCat.mismatch)),
          synced: stockSummary.synced + (Number(newCat.synced) - Number(oldCat.synced)),
          noStock: stockSummary.noStock + (Number(newCat.noStock) - Number(oldCat.noStock)),
          withStock: stockSummary.withStock + (Number(newCat.withStock) - Number(oldCat.withStock)),
        };
      }

      const droppedByFilter = !!filter && filter !== 'all' && !matchesStockFilter(filter, newMl, newTn);

      // stockTotal (chip "N unidades en stock · M productos") usa el mismo criterio que el backend:
      // el mínimo entre canales por par (stock realmente vendible), sumado sobre el filtro activo.
      if (stockTotal) {
        const oldUnits = Math.min(oldMl, oldTn);
        const newUnits = Math.min(newMl, newTn);
        stockTotal = droppedByFilter
          ? { units: Math.max(0, stockTotal.units - oldUnits), products: Math.max(0, stockTotal.products - 1) }
          : { units: stockTotal.units - oldUnits + newUnits, products: stockTotal.products };
      }

      if (droppedByFilter) {
        matched = matched.filter((pair) => getPairId(pair) !== pairId);
        if (paging) {
          const total = Math.max(0, paging.total - 1);
          paging = { ...paging, total, pages: Math.max(1, Math.ceil(total / paging.limit)) };
        }
      }
    }

    this.queryClient.setQueryData<ConflictAnalysis>(key as unknown[], { ...prev, matched, stockSummary, stockTotal, paging });
    this.analysisInvalidated.next();
  }

  /**
   * Actualiza en caché el precio ML de TODAS las variaciones de un mismo ítem.
   * Se usa cuando ML aplica el precio a todas las variaciones (ítems legacy con variaciones),
   * así las otras filas del mismo ítem reflejan el nuevo precio sin refetch.
   */
  updateItemVariationsPriceInCache(itemId: string, priceML: number, queryKey?: readonly unknown[]): void {
    const key = queryKey ?? CONFLICTS_ANALYSIS_QUERY_KEY;
    const prev = this.queryClient.getQueryData<ConflictAnalysis>(key as unknown[]);
    if (!prev?.matched) return;
    const matched = prev.matched.map((pair) =>
      pair.ml.itemId === itemId ? { ...pair, ml: { ...pair.ml, price: priceML } } : pair
    );
    this.queryClient.setQueryData<ConflictAnalysis>(key as unknown[], { ...prev, matched });
    this.analysisInvalidated.next();
  }

  /**
   * Actualiza en caché el precio TN de TODAS las variantes de un mismo producto.
   * Se usa cuando el usuario elige aplicar el precio TN a todas las variantes (a diferencia
   * de ML, en TN esto es una elección del usuario, no una obligación de la API).
   */
  updateProductVariantsPriceInCache(productId: number, priceTN: number, queryKey?: readonly unknown[]): void {
    const key = queryKey ?? CONFLICTS_ANALYSIS_QUERY_KEY;
    const prev = this.queryClient.getQueryData<ConflictAnalysis>(key as unknown[]);
    if (!prev?.matched) return;
    const matched = prev.matched.map((pair) =>
      pair.tn.productId === productId ? { ...pair, tn: { ...pair.tn, price: priceTN } } : pair
    );
    this.queryClient.setQueryData<ConflictAnalysis>(key as unknown[], { ...prev, matched });
    this.analysisInvalidated.next();
  }

  /** Cabeceras para que el navegador no use caché en este GET. */
  private static readonly NO_CACHE_HEADERS = new HttpHeaders({
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Pragma: 'no-cache'
  });

  /**
   * Obtiene el análisis de conflictos (Observable). Para caché con TanStack Query usar getAnalysisPromise().
   * Soporta paginación y filtros opcionales; sin params devuelve página 1 con 25 resultados.
   */
  getAnalysis(opts?: { page?: number; limit?: number; filter?: string; search?: string; tab?: string; refresh?: boolean }): Observable<ConflictAnalysis> {
    let params = new HttpParams().set('_t', String(Date.now()));
    if (opts?.page != null)   params = params.set('page', String(opts.page));
    if (opts?.limit != null)  params = params.set('limit', String(opts.limit));
    if (opts?.filter)         params = params.set('filter', opts.filter);
    if (opts?.search)         params = params.set('search', opts.search);
    if (opts?.tab)            params = params.set('tab', opts.tab);
    if (opts?.refresh)        params = params.set('refresh', '1');
    return this.http.get<ConflictAnalysis>(`${this.api.baseUrl}/conflicts`, {
      params,
      headers: ConflictsService.NO_CACHE_HEADERS
    });
  }

  /** Promesa del análisis; usar en queryFn de TanStack Query (misma queryKey = caché compartida). */
  getAnalysisPromise(opts?: { page?: number; limit?: number; filter?: string; search?: string; tab?: string; refresh?: boolean }): Promise<ConflictAnalysis> {
    return lastValueFrom(this.getAnalysis(opts));
  }

  /**
   * Botón "actualizar": fuerza un crawl real a ML/TN (repuebla el snapshot del backend) y después
   * refetch de las queries de la vista actual, que ya leen del snapshot fresco. A diferencia de
   * invalidateAnalysis() (que solo refetch del snapshot), esto sí vuelve a consultar los canales.
   */
  async forceRefresh(): Promise<void> {
    try {
      await this.getAnalysisPromise({ page: 1, limit: 25, refresh: true });
    } finally {
      this.invalidateAnalysis();
    }
  }

  updateSku(channel: 'mercadolibre' | 'tiendanube', sku: string, payload: {
    itemId?: string;
    variationId?: string;
    productId?: number;
    variantId?: number;
  }) {
    return this.http.post<{ ok: boolean }>(`${this.api.baseUrl}/conflicts/update-sku`, {
      channel,
      sku: sku.trim(),
      ...payload
    });
  }

  linkManually(body: {
    sku: string;
    mercadolibre: { itemId: string; variationId?: string };
    tiendanube: { productId: number; variantId: number };
    priceML?: number;
    priceTN?: number;
  }) {
    return this.http.post<{ ok: boolean; sku: string; persisted?: { ml?: boolean; tn?: boolean } }>(`${this.api.baseUrl}/conflicts/link`, body);
  }

  /** Actualizar precios y/o stock en ML y TN (pueden ser distintos). */
  updatePricesAndStock(params: {
    itemId: string;
    variationId?: string | null;
    productId: number;
    variantId: number;
    priceML: number;
    priceTN: number;
    stockML?: number;
    stockTN?: number;
    /** true: aplicar priceTN a todas las variantes del producto TN (elección del usuario, no obligación de la API). */
    applyTnToAllVariants?: boolean;
  }) {
    return this.http.post<{ ok: boolean; mlTaskId?: number; mlStockTaskId?: number; ml: boolean; tn: boolean }>(
      `${this.api.baseUrl}/conflicts/update-prices`,
      {
        itemId: params.itemId,
        variationId: params.variationId || undefined,
        productId: params.productId,
        variantId: params.variantId,
        priceML: params.priceML,
        priceTN: params.priceTN,
        stockML: params.stockML,
        stockTN: params.stockTN,
        applyTnToAllVariants: params.applyTnToAllVariants || undefined
      }
    );
  }

  /** Estado puntual de una tarea ML (para polling). */
  getTaskStatus(taskId: number) {
    return this.http.get<{ id: number; status: string; lastError?: string | null }>(
      `${this.api.baseUrl}/conflicts/task/${taskId}`
    );
  }

  /**
   * Tareas todavía en cola. Sirve para saber qué filas están esperando al worker: sin esto, una
   * escritura encolada se ve idéntica a un conflicto real (el estado local se pierde al navegar).
   */
  getActiveTasks() {
    return this.http.get<ActiveTasksResponse>(`${this.api.baseUrl}/sync/active-tasks`);
  }
}
