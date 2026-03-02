import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ApiService } from './api.service';

export interface SyncConfig {
  enabled: boolean;
  hasDatabase: boolean;
}

export interface SyncAuditRow {
  id: number;
  channelSale: 'mercadolibre' | 'tiendanube';
  orderId: string;
  /** Id. del ítem en esa venta (ML: item_id o item_id:variation_id; TN: variant_id o product_id:variant_id). */
  saleItemId?: string | null;
  sku: string;
  productLabel: string | null;
  /** Descripción y variante del producto para identificar más rápido. */
  productDisplay?: string | null;
  quantity: number;
  updatedChannel: 'mercadolibre' | 'tiendanube';
  stockBefore: number;
  stockAfter: number;
  createdAt: string;
  revertedAt?: string | null;
}

export interface SyncAuditResponse {
  rows: SyncAuditRow[];
  total: number;
}

export interface PendingReturnRow {
  id: number;
  orderId: string;
  itemId: string;
  variationId: string | null;
  sku: string | null;
  quantity: number;
  productLabel: string | null;
  status: string;
  createdAt: string;
}

export interface SyncReturnsResponse {
  rows: PendingReturnRow[];
}

@Injectable({ providedIn: 'root' })
export class SyncService {
  constructor(
    private http: HttpClient,
    private api: ApiService
  ) {}

  getConfig() {
    return this.http.get<SyncConfig>(`${this.api.baseUrl}/sync/config`);
  }

  setSyncEnabled(enabled: boolean) {
    return this.http.patch<{ enabled: boolean }>(`${this.api.baseUrl}/sync/config`, { enabled });
  }

  getAudit(limit = 100, offset = 0, orderId?: string) {
    const params: Record<string, string> = { limit: String(limit), offset: String(offset) };
    if (orderId != null && orderId.trim()) params['orderId'] = orderId.trim();
    return this.http.get<SyncAuditResponse>(`${this.api.baseUrl}/sync/audit`, { params });
  }

  /** Revierte un registro del historial: vuelve a sumar el stock en el canal donde se había descontado. */
  revertAudit(id: number) {
    return this.http.post<{ ok: boolean }>(`${this.api.baseUrl}/sync/audit/${id}/revert`, {});
  }

  /** Sincronizar precios de todos los SKU a ML y TN. */
  syncAllPrices() {
    return this.http.post<Record<string, { ml?: boolean; tn?: boolean; error?: string }>>(
      `${this.api.baseUrl}/sync/prices`,
      {}
    );
  }

  /** Sincronizar precios de un SKU a ambos canales. */
  syncPricesForSku(sku: string) {
    return this.http.post<{ ml?: boolean; tn?: boolean; error?: string }>(
      `${this.api.baseUrl}/sync/prices/${encodeURIComponent(sku)}`,
      {}
    );
  }

  /** Listar devoluciones pendientes (ML). */
  getReturns() {
    return this.http.get<SyncReturnsResponse>(`${this.api.baseUrl}/sync/returns`);
  }

  /** Traer devoluciones desde ML (reclamos con devolución). No tenés que ingresar el nº de orden. */
  fetchReturnsFromMl() {
    return this.http.post<{ ok: boolean; claimsChecked: number; created: number; skipped: number }>(
      `${this.api.baseUrl}/sync/returns/fetch`,
      {}
    );
  }

  /** Agregar devoluciones desde una orden ML (por nº de orden). */
  addReturnsFromOrder(orderId: string) {
    return this.http.post<{ created: number; rows: PendingReturnRow[] }>(
      `${this.api.baseUrl}/sync/returns`,
      { orderId }
    );
  }

  /** Aprobar devolución y restaurar stock en ML y TN. */
  approveReturn(id: number) {
    return this.http.post<{ ok: boolean; mlRestored: boolean; tnRestored: boolean }>(
      `${this.api.baseUrl}/sync/returns/${id}/approve`,
      {}
    );
  }

  /** Registrar webhooks de Tienda Nube (order/paid, order/cancelled, etc.). Útil cuando cambia la URL de ngrok. */
  registerWebhooks() {
    return this.http.post<{ ok: boolean; registered: number; created: Array<{ event: string; id: number }> }>(
      `${this.api.baseUrl}/sync/register-webhooks`,
      {}
    );
  }
}
