import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ApiService } from './api.service';

export interface SyncConfig {
  enabled: boolean;
  hasDatabase: boolean;
}

/**
 * De dónde salió un cambio de stock. 'venta' y 'devolucion' los produce la sincronización
 * automática; 'manual' es alguien tocando el stock desde Precio y stock.
 */
export type AuditSource = 'venta' | 'manual' | 'devolucion';

export interface SyncAuditRow {
  id: number;
  source: AuditSource;
  /**
   * Los campos de venta van en null cuando source es 'manual': un cambio a mano no tiene canal de
   * venta, ni orden, ni cantidad vendida. Lo que pasó lo cuentan stockBefore/stockAfter.
   */
  channelSale: 'mercadolibre' | 'tiendanube' | null;
  /** Id. de la orden individual (ML: order.id; TN: order id). */
  orderId: string | null;
  /** Nro de venta real (ML: pack_id, agrupa varias órdenes de un mismo carrito). */
  packId?: string | null;
  /** Id. del ítem en esa venta (ML: item_id o item_id:variation_id; TN: variant_id o product_id:variant_id). */
  saleItemId?: string | null;
  sku: string;
  productLabel: string | null;
  /** Descripción y variante del producto para identificar más rápido. */
  productDisplay?: string | null;
  quantity: number | null;
  /** Canal donde se escribió el stock. Siempre presente, sea cual sea el origen. */
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
  reason: string | null;
  buyerNickname: string | null;
  claimDate: string | null;
  status: string;
  createdAt: string;
}

export interface SyncReturnsResponse {
  rows: PendingReturnRow[];
  total: number;
}

export type MlTaskKind = 'stock_ml' | 'sku_ml' | 'sku_tn' | 'price_ml';
export type MlTaskStatus = 'pending' | 'processing' | 'failed';

export interface PendingMlTask {
  id: number;
  kind: MlTaskKind;
  itemId: string | null;
  variationId: string | null;
  /** Para stock: delta relativo (negativo = descuento, positivo = restauración). */
  targetQty: number | null;
  targetSku: string | null;
  targetPrice: number | null;
  status: MlTaskStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string;
}

export interface PendingMlTasksResponse {
  tasks: PendingMlTask[];
  total: number;
  activeCount: number;
  failedCount: number;
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

  /** `orderId` busca por nº de venta, id. de ítem o SKU. `source` filtra por origen (vacío = todos). */
  getAudit(limit = 100, offset = 0, orderId?: string, source?: AuditSource | '') {
    const params: Record<string, string> = { limit: String(limit), offset: String(offset) };
    if (orderId != null && orderId.trim()) params['orderId'] = orderId.trim();
    if (source) params['source'] = source;
    return this.http.get<SyncAuditResponse>(`${this.api.baseUrl}/sync/audit`, { params });
  }

  /** Historial de stock de un producto puntual (ambos canales, todos los orígenes). */
  getStockHistoryBySku(sku: string, limit = 50, offset = 0) {
    const params: Record<string, string> = { limit: String(limit), offset: String(offset) };
    return this.http.get<SyncAuditResponse>(
      `${this.api.baseUrl}/sync/audit/by-sku/${encodeURIComponent(sku)}`,
      { params }
    );
  }

  /** Revierte un registro del historial: vuelve a sumar el stock en el canal donde se había descontado. */
  revertAudit(id: number) {
    return this.http.post<{ ok: boolean }>(`${this.api.baseUrl}/sync/audit/${id}/revert`, {});
  }

  /** Reintentar sincronización de una orden ML (cuando el webhook la marcó procesada pero no descontó). */
  reprocessOrder(orderId: string) {
    return this.http.post<{ ok: boolean; orderId: string; itemsSynced: number }>(
      `${this.api.baseUrl}/sync/reprocess-order`,
      { orderId: orderId.trim() }
    );
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

  /** Listar devoluciones pendientes (ML), paginadas. */
  getReturns(limit = 20, offset = 0) {
    const params = { limit: String(limit), offset: String(offset) };
    return this.http.get<SyncReturnsResponse>(`${this.api.baseUrl}/sync/returns`, { params });
  }

  /** Traer devoluciones desde ML (reclamos con devolución). No tenés que ingresar el nº de orden. */
  fetchReturnsFromMl() {
    // skippedCrawl/mlBusy: el backend no crawleó porque ML está saturado (circuit breaker) o en
    // cooldown; devuelve el último resultado bueno (stale) o ceros. Ver /returns/fetch en el backend.
    return this.http.post<{
      ok: boolean; claimsChecked: number; created: number; skipped: number;
      cached?: boolean; stale?: boolean; skippedCrawl?: boolean; mlBusy?: boolean;
    }>(
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

  /** Listar tareas de actualización de ML pendientes / en proceso / fallidas, paginadas. */
  getPendingTasks(limit = 20, offset = 0) {
    const params = { limit: String(limit), offset: String(offset) };
    return this.http.get<PendingMlTasksResponse>(`${this.api.baseUrl}/sync/pending-tasks`, { params });
  }

  /** Reintentar manualmente una tarea fallida. */
  retryTask(id: number) {
    return this.http.post<{ ok: boolean }>(`${this.api.baseUrl}/sync/pending-tasks/${id}/retry`, {});
  }

  /** Registrar webhooks de Tienda Nube (order/paid, order/cancelled, etc.). Útil cuando cambia la URL de ngrok. */
  registerWebhooks() {
    return this.http.post<{ ok: boolean; registered: number; created: Array<{ event: string; id: number }> }>(
      `${this.api.baseUrl}/sync/register-webhooks`,
      {}
    );
  }
}
