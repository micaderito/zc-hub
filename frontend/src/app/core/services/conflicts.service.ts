import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams, HttpHeaders } from '@angular/common/http';
import { Observable, Subject } from 'rxjs';
import { lastValueFrom } from 'rxjs';
import { QueryClient } from '@tanstack/angular-query-experimental';
import { ApiService } from './api.service';

/** Query key del análisis de conflictos; invalidar en cada add/edit/delete. */
export const CONFLICTS_ANALYSIS_QUERY_KEY = ['conflicts', 'analysis'] as const;

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

@Injectable({ providedIn: 'root' })
export class ConflictsService {
  private readonly queryClient = inject(QueryClient);

  /** Emite cuando hubo una mutación; compatibilidad con código que no use TanStack. */
  private readonly analysisInvalidated = new Subject<void>();
  readonly analysisInvalidated$: Observable<void> = this.analysisInvalidated.asObservable();

  constructor(
    private http: HttpClient,
    private api: ApiService
  ) {}

  /** Llamar después de agregar/editar/borrar (link, update-sku, update-prices, etc.) para invalidar caché y refrescar. */
  invalidateAnalysis(): void {
    this.queryClient.invalidateQueries({ queryKey: CONFLICTS_ANALYSIS_QUERY_KEY });
    this.analysisInvalidated.next();
  }

  /** Cabeceras para que el navegador no use caché en este GET. */
  private static readonly NO_CACHE_HEADERS = new HttpHeaders({
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Pragma: 'no-cache'
  });

  /**
   * Obtiene el análisis de conflictos (Observable). Para caché con TanStack Query usar getAnalysisPromise().
   */
  getAnalysis(_forceRefresh = false): Observable<ConflictAnalysis> {
    const params = new HttpParams().set('_t', String(Date.now()));
    return this.http.get<ConflictAnalysis>(`${this.api.baseUrl}/conflicts`, {
      params,
      headers: ConflictsService.NO_CACHE_HEADERS
    });
  }

  /** Promesa del análisis; usar en queryFn de TanStack Query (misma queryKey = caché compartida). */
  getAnalysisPromise(): Promise<ConflictAnalysis> {
    return lastValueFrom(this.getAnalysis());
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
  }) {
    return this.http.post<{ ok: boolean; ml: boolean; tn: boolean }>(
      `${this.api.baseUrl}/conflicts/update-prices`,
      {
        itemId: params.itemId,
        variationId: params.variationId || undefined,
        productId: params.productId,
        variantId: params.variantId,
        priceML: params.priceML,
        priceTN: params.priceTN,
        stockML: params.stockML,
        stockTN: params.stockTN
      }
    );
  }
}
