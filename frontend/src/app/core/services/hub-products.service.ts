import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { lastValueFrom } from 'rxjs';
import { ApiService } from './api.service';

/**
 * Estado de un producto del hub (ver backend/src/services/hubProductsService.js):
 * - `orphan`: alguna variante está en un solo canal o no tiene SKU (no se sincroniza);
 * - `duplicate`: un SKU se repite en un mismo canal (no se sabe cuál es el par de cuál);
 * - `desync`: todo vinculado pero el stock no coincide;
 * - `only_ml` / `only_tn`: publicado en un solo canal;
 * - `linked`: todo vinculado y con el mismo stock.
 */
export type HubStatus = 'orphan' | 'duplicate' | 'desync' | 'only_ml' | 'only_tn' | 'linked';

/** Fila de la lista de productos del hub. */
export interface HubProductSummary {
  key: string;
  name: string;
  thumbnail: string | null;
  status: HubStatus;
  mlCount: number;
  tnCount: number;
  variantCount: number;
  mlStock: number;
  tnStock: number;
  /** Edición abierta (Publicaciones → Editar) que todavía no se guardó ni descartó. */
  edit?: HubOpenEdit | null;
}

export interface HubOpenEdit {
  id: string;
  status: 'editing' | 'saving';
  updatedAt: string;
}

export interface HubProductList {
  rows: HubProductSummary[];
  total: number;
  counts: Record<HubStatus | 'all', number>;
  mlConnected: boolean;
  tnConnected: boolean;
  /** Fecha (ms) de la foto del catálogo que se usó. */
  at: number | null;
}

/** Publicación de ML dentro de un producto del hub. `format` define cómo se edita (ver CLAUDE.md). */
export interface HubMlPublication {
  itemId: string;
  title: string;
  format: 'legacy' | 'up' | 'simple';
  familyName: string | null;
  soldQuantity: number | null;
  status: string | null;
  thumbnail: string | null;
  variantCount: number;
}

export interface HubTnPublication {
  productId: number;
  name: string;
  thumbnail: string | null;
  variantCount: number;
}

/** Fila cruda del catálogo de ML (una por variación), tal como la guarda el snapshot. */
export interface HubMlVariant {
  itemId: string;
  variationId: string | null;
  variationName: string | null;
  title: string;
  sku: string | null;
  price: number;
  stock: number;
  thumbnail: string | null;
}

export interface HubTnVariant {
  productId: number;
  variantId: number;
  variantName: string | null;
  productName: string;
  sku: string | null;
  price: number;
  stock: number;
  thumbnail: string | null;
}

/** Una variante del producto, unida por SKU. Una punta en null = no está en ese canal. */
export interface HubVariantRow {
  sku: string | null;
  ml: HubMlVariant | null;
  tn: HubTnVariant | null;
  duplicate: boolean;
}

export interface HubProductDetail {
  key: string;
  name: string;
  thumbnail: string | null;
  status: HubStatus;
  ml: HubMlPublication[];
  tn: HubTnPublication[];
  rows: HubVariantRow[];
  variantCount: number;
  mlStock: number;
  tnStock: number;
  edit?: HubOpenEdit | null;
}

/** Variante sin par en el otro canal, ofrecida en el picker de "Vincular". */
export interface LinkCandidate {
  channel: 'ml' | 'tn';
  itemId?: string;
  variationId?: string | null;
  productId?: number;
  variantId?: number;
  name: string;
  variant: string | null;
  sku: string | null;
  stock: number;
  thumbnail: string | null;
}

export interface LinkRequest {
  sku: string;
  ml: { itemId: string; variationId?: string | null };
  tn: { productId: number; variantId: number };
}

@Injectable({ providedIn: 'root' })
export class HubProductsService {
  private readonly http = inject(HttpClient);
  private readonly api = inject(ApiService);

  list(opts: { search?: string; status?: string; limit?: number; offset?: number; refresh?: boolean } = {}): Promise<HubProductList> {
    let params = new HttpParams();
    if (opts.search) params = params.set('search', opts.search);
    if (opts.status) params = params.set('status', opts.status);
    if (opts.limit != null) params = params.set('limit', String(opts.limit));
    if (opts.offset != null) params = params.set('offset', String(opts.offset));
    if (opts.refresh) params = params.set('refresh', '1');
    return lastValueFrom(this.http.get<HubProductList>(`${this.api.baseUrl}/hub-products`, { params }));
  }

  get(key: string): Promise<HubProductDetail> {
    return lastValueFrom(this.http.get<HubProductDetail>(`${this.api.baseUrl}/hub-products/${encodeURIComponent(key)}`));
  }

  linkCandidates(channel: 'ml' | 'tn', search = ''): Promise<LinkCandidate[]> {
    let params = new HttpParams().set('channel', channel);
    if (search) params = params.set('search', search);
    return lastValueFrom(this.http.get<LinkCandidate[]>(`${this.api.baseUrl}/hub-products/link-candidates`, { params }));
  }

  link(body: LinkRequest): Promise<{ ok: boolean; sku: string; pendingMl: boolean }> {
    return lastValueFrom(this.http.post<{ ok: boolean; sku: string; pendingMl: boolean }>(`${this.api.baseUrl}/hub-products/link`, body));
  }
}
