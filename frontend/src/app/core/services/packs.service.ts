import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { lastValueFrom } from 'rxjs';
import { QueryClient } from '@tanstack/angular-query-experimental';
import { ApiService } from './api.service';

/** Query key de los packs; invalidar tras cualquier alta/edición/borrado o reasignación de SKU. */
export const PACKS_QUERY_KEY = ['products', 'packs'] as const;

/** Un producto dentro de un pack, con su stock de hoy (para el detalle al abrir la tarjeta). */
export interface PackProduct {
  sku: string;
  label: string;
  thumbnail: string | null;
  stockMl: number | null;
  stockTn: number | null;
  stockEffective: number | null;
}

/** Un pack: la unidad de compra al proveedor (ver CLAUDE.md). `sku` es el código propio del pack, opcional y distinto del de sus modelos. */
export interface Pack {
  id: number;
  name: string;
  sku: string | null;
  unitCount: number;
  mode: 'assorted' | 'single';
  products: PackProduct[];
}

@Injectable({ providedIn: 'root' })
export class PacksService {
  private http = inject(HttpClient);
  private api = inject(ApiService);
  private queryClient = inject(QueryClient);

  private invalidate(): void {
    this.queryClient.invalidateQueries({ queryKey: PACKS_QUERY_KEY });
  }

  getPacksPromise(): Promise<{ packs: Pack[] }> {
    return lastValueFrom(this.http.get<{ packs: Pack[] }>(`${this.api.baseUrl}/products/packs`));
  }

  /** Devuelve el id del pack creado, para poder asignarle productos de una. */
  async createPack(data: { name: string; unitCount: number; mode: 'assorted' | 'single'; sku?: string | null }): Promise<number> {
    const res = await lastValueFrom(this.http.post<{ ok: boolean; id: number }>(`${this.api.baseUrl}/products/packs`, data));
    this.invalidate();
    return res.id;
  }

  async updatePack(id: number, data: { name: string; unitCount: number; mode: 'assorted' | 'single'; sku?: string | null }): Promise<void> {
    await lastValueFrom(this.http.put<{ ok: boolean }>(`${this.api.baseUrl}/products/packs/${id}`, data));
    this.invalidate();
  }

  async deletePack(id: number): Promise<void> {
    await lastValueFrom(this.http.delete<{ ok: boolean }>(`${this.api.baseUrl}/products/packs/${id}`));
    this.invalidate();
  }

  /** Mueve un SKU a un pack, o lo saca ("sin pack") con `packId: null`. */
  async setSkuPack(sku: string, packId: number | null): Promise<void> {
    await lastValueFrom(
      this.http.put<{ ok: boolean }>(`${this.api.baseUrl}/products/packs/sku/${encodeURIComponent(sku)}`, { packId })
    );
    this.invalidate();
  }
}
