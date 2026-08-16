import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ApiService } from './api.service';

export interface MappingEntry {
  sku: string;
  mercadolibre: { itemId: string; variationId?: string } | null;
  tiendanube: { productId: number; variantId: number } | null;
  priceML: number;
  priceTN: number;
  lastSync?: string;
}

/** Una opción del catálogo ML/TN: SKU + nombre legible + foto, ya deduplicado por SKU. */
export interface CatalogOption {
  sku: string;
  label: string;
  thumbnail: string | null;
}

@Injectable({ providedIn: 'root' })
export class MappingService {
  constructor(
    private http: HttpClient,
    private api: ApiService
  ) {}

  getAll() {
    return this.http.get<MappingEntry[]>(`${this.api.baseUrl}/mapping`);
  }

  create(entry: Partial<MappingEntry>) {
    return this.http.post<{ ok: boolean; sku: string }>(`${this.api.baseUrl}/mapping`, entry);
  }

  update(sku: string, entry: Partial<MappingEntry>) {
    return this.http.put<{ ok: boolean }>(`${this.api.baseUrl}/mapping/${encodeURIComponent(sku)}`, entry);
  }

  delete(sku: string) {
    return this.http.delete<{ ok: boolean }>(`${this.api.baseUrl}/mapping/${encodeURIComponent(sku)}`);
  }

  getMercadoLibreSources() {
    return this.http.get<CatalogOption[]>(`${this.api.baseUrl}/mapping/sources/mercadolibre`);
  }

  getTiendaNubeSources() {
    return this.http.get<CatalogOption[]>(`${this.api.baseUrl}/mapping/sources/tiendanube`);
  }
}
