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
}
