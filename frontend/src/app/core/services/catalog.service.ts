import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { lastValueFrom } from 'rxjs';
import { ApiService } from './api.service';

/** Categoría existente de Tienda Nube (para el multi-select). */
export interface TnCategory {
  id: number;
  name: string;
  parent: number | null;
  subcategories: number[];
  /** Breadcrumb "Padre › Hija" para mostrar la jerarquía en el desplegable. */
  path: string;
}

/** Categoría raíz de Mercado Libre (solo id + name). */
export interface MlCategoryRef {
  id: string;
  name: string;
}

/** Detalle de una categoría de ML para navegar el árbol. */
export interface MlCategoryNode {
  id: string;
  name: string;
  path_from_root: MlCategoryRef[];
  children_categories: MlCategoryRef[];
  /** true = categoría hoja (publicable). */
  leaf: boolean;
  listing_allowed: boolean;
  /** Máximo de fotos por publicación (settings.max_pictures_per_item; fallback 12). */
  max_pictures: number;
  /** Máximo de fotos por variación (settings.max_pictures_per_item_var; fallback 10). */
  max_pictures_per_var: number;
}

/** Sugerencia del predictor de categoría de ML (siempre hoja). */
export interface MlCategoryPrediction {
  domain_id: string;
  domain_name: string;
  category_id: string;
  category_name: string;
  attributes: { id: string; name: string; value_id?: string; value_name?: string }[];
}

/** Atributo de categoría de ML normalizado por el backend. */
export interface MlCategoryAttribute {
  id: string;
  name: string;
  valueType: string;
  required: boolean;
  /** true = tag `conditional_required` de ML: obligatorio solo si su disparador está completo. */
  conditionalRequired?: boolean;
  /** true = candidato a EJE de variante (COLOR, SIZE…): ML lo permite variar dentro de una familia. */
  allowVariations?: boolean;
  allowedValues: { id: string; name: string }[];
  allowedUnits?: string[];
  defaultUnit?: string;
}

/** Resultado por canal de publicar un producto. */
export interface PublishChannelResult {
  channel: 'ml' | 'tn';
  status: 'ok' | 'error';
  detail: string;
}

export interface PublishResponse {
  results: PublishChannelResult[];
}

/** Fila del panel "Mis borradores" (GET /drafts) — sin el draft completo, pesado para una lista. */
export interface DraftSummary {
  id: string;
  name: string | null;
  sku: string | null;
  status: 'draft' | 'publishing' | 'published' | 'partial' | 'error';
  createdAt: string;
  updatedAt: string;
}

/** Historial resumido de un job para el detalle de un borrador (GET /drafts/:id). */
export interface PublishJobSummary {
  id: string;
  draftId: string;
  channels: string;
  status: 'pending' | 'processing' | 'done' | 'error' | 'cancelled';
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

/** Un borrador completo (GET /drafts/:id) con su historial de jobs. */
export interface DraftDetail extends DraftSummary {
  draft: unknown; // ProductDraft — no se tipa acá para no crear una dependencia circular con product-draft.model
  jobs: PublishJobSummary[];
}

/** Unidad publicada dentro de un job (un ítem ML, un producto TN) — el progreso granular. */
export interface PublishUnit {
  channel: 'ml' | 'tn';
  unitKey: string;
  seq: number;
  status: 'pending' | 'ok' | 'error';
  externalId: string | null;
  detail: string | null;
  updatedAt: string;
}

export interface PublishJobDetail {
  job: PublishJobSummary;
  units: PublishUnit[];
}

/** Imagen subida al store temporal del backend. */
export interface UploadedImage {
  id: string;
  name: string;
  mime: string;
  size: number;
}

/** SEO generado con IA (ya recortado a los límites de TN: 70 / 320). */
export interface GeneratedSeo {
  seoTitle: string;
  seoDescription: string;
  /** Etiquetas de búsqueda, como string separado por comas (formato que espera TN). */
  tags: string;
}

/** Comisiones de ML para un precio (cuánto recibe el vendedor). */
export interface MlListingPrices {
  currency_id: string;
  sale_fee_amount: number;
  listing_fee_amount: number;
  percentage_fee: number | null;
  net: number;
}

@Injectable({ providedIn: 'root' })
export class CatalogService {
  private http = inject(HttpClient);
  private api = inject(ApiService);

  /* ---------- Tienda Nube ---------- */

  getTiendaNubeCategories(): Promise<TnCategory[]> {
    return lastValueFrom(
      this.http.get<TnCategory[]>(`${this.api.baseUrl}/products/categories/tiendanube`)
    );
  }

  /* ---------- Mercado Libre ---------- */

  getMlRootCategories(): Promise<MlCategoryRef[]> {
    return lastValueFrom(
      this.http.get<MlCategoryRef[]>(`${this.api.baseUrl}/products/categories/mercadolibre/roots`)
    );
  }

  getMlCategory(id: string): Promise<MlCategoryNode> {
    return lastValueFrom(
      this.http.get<MlCategoryNode>(`${this.api.baseUrl}/products/categories/mercadolibre/${encodeURIComponent(id)}`)
    );
  }

  getMlCategoryAttributes(id: string): Promise<MlCategoryAttribute[]> {
    return lastValueFrom(
      this.http.get<MlCategoryAttribute[]>(
        `${this.api.baseUrl}/products/categories/mercadolibre/${encodeURIComponent(id)}/attributes`
      )
    );
  }

  predictMlCategory(title: string): Promise<MlCategoryPrediction[]> {
    const q = encodeURIComponent(title.trim());
    return lastValueFrom(
      this.http.get<MlCategoryPrediction[]>(`${this.api.baseUrl}/products/categories/mercadolibre/predict?q=${q}`)
    );
  }

  /** Genera SEO (título + meta descripción) con IA a partir de los datos del producto. */
  generateSeo(input: { name: string; description?: string; brand?: string; category?: string }): Promise<GeneratedSeo> {
    return lastValueFrom(this.http.post<GeneratedSeo>(`${this.api.baseUrl}/products/seo`, input));
  }

  /** Comisiones de ML para un precio (cuánto recibe el vendedor). */
  getMlListingPrices(price: number, categoryId: string, listingTypeId: string): Promise<MlListingPrices> {
    const params = new URLSearchParams({ price: String(price) });
    if (categoryId) params.set('category_id', categoryId);
    if (listingTypeId) params.set('listing_type_id', listingTypeId);
    return lastValueFrom(
      this.http.get<MlListingPrices>(`${this.api.baseUrl}/products/ml/listing-prices?${params.toString()}`)
    );
  }

  /* ---------- Imágenes ---------- */

  /**
   * Sube el archivo original tal cual (sin pasar por base64/JSON): el body es el propio `File` y
   * el nombre va en un header. Evita el `JSON.stringify` de un data URL de varios MB, que es lo
   * que trababa la página al cargar muchas fotos a la vez.
   */
  uploadImageFile(file: File): Promise<UploadedImage> {
    const headers = { 'Content-Type': file.type || 'application/octet-stream', 'X-Image-Filename': encodeURIComponent(file.name) };
    return lastValueFrom(this.http.post<UploadedImage>(`${this.api.baseUrl}/products/images`, file, { headers }));
  }

  /**
   * Guarda la miniatura (la que generó el worker) junto al original ya subido. Sirve para que al
   * restaurar un borrador el preview sea de ~40 KB y no el archivo de varios MB.
   */
  uploadThumb(id: string, blob: Blob): Promise<{ ok: boolean }> {
    const headers = { 'Content-Type': blob.type || 'image/jpeg' };
    return lastValueFrom(
      this.http.post<{ ok: boolean }>(`${this.api.baseUrl}/products/images/${id}/thumb`, blob, { headers })
    );
  }

  /** Sube una imagen (base64) al store temporal del backend y devuelve su id. */
  uploadImage(file: { filename: string; mime: string; data: string }): Promise<UploadedImage> {
    return lastValueFrom(this.http.post<UploadedImage>(`${this.api.baseUrl}/products/images`, file));
  }

  /** Descarta una imagen temporal del backend. */
  deleteImage(id: string): Promise<{ ok: boolean }> {
    return lastValueFrom(this.http.delete<{ ok: boolean }>(`${this.api.baseUrl}/products/images/${id}`));
  }

  /* ---------- Publicar en ambos canales ---------- */

  publishProduct(payload: unknown): Promise<PublishResponse> {
    return lastValueFrom(this.http.post<PublishResponse>(`${this.api.baseUrl}/products`, payload));
  }

  /* ---------- Borradores + publicación en background ---------- */

  listDrafts(): Promise<DraftSummary[]> {
    return lastValueFrom(this.http.get<DraftSummary[]>(`${this.api.baseUrl}/products/drafts`));
  }

  createDraft(body: { name?: string; sku?: string; draft: unknown }): Promise<{ id: string }> {
    return lastValueFrom(this.http.post<{ id: string }>(`${this.api.baseUrl}/products/drafts`, body));
  }

  getDraft(id: string): Promise<DraftDetail> {
    return lastValueFrom(this.http.get<DraftDetail>(`${this.api.baseUrl}/products/drafts/${id}`));
  }

  updateDraft(id: string, body: { name?: string; sku?: string; draft: unknown }): Promise<{ ok: boolean }> {
    return lastValueFrom(this.http.put<{ ok: boolean }>(`${this.api.baseUrl}/products/drafts/${id}`, body));
  }

  deleteDraft(id: string): Promise<{ ok: boolean }> {
    return lastValueFrom(this.http.delete<{ ok: boolean }>(`${this.api.baseUrl}/products/drafts/${id}`));
  }

  /** Encola la publicación de un borrador. Devuelve el id del job para pollear su progreso. */
  publishDraft(id: string, payload: unknown, channels?: ('ml' | 'tn')[]): Promise<{ jobId: string }> {
    return lastValueFrom(this.http.post<{ jobId: string }>(`${this.api.baseUrl}/products/drafts/${id}/publish`, { payload, channels }));
  }

  getPublishJob(jobId: string): Promise<PublishJobDetail> {
    return lastValueFrom(this.http.get<PublishJobDetail>(`${this.api.baseUrl}/products/jobs/${jobId}`));
  }

  retryPublishJob(jobId: string): Promise<{ ok: boolean }> {
    return lastValueFrom(this.http.post<{ ok: boolean }>(`${this.api.baseUrl}/products/jobs/${jobId}/retry`, {}));
  }

  cancelPublishJob(jobId: string): Promise<{ ok: boolean }> {
    return lastValueFrom(this.http.post<{ ok: boolean }>(`${this.api.baseUrl}/products/jobs/${jobId}/cancel`, {}));
  }

  deletePublishJob(jobId: string): Promise<{ ok: boolean }> {
    return lastValueFrom(this.http.delete<{ ok: boolean }>(`${this.api.baseUrl}/products/jobs/${jobId}`));
  }
}
