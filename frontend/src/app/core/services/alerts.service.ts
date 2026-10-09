import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { lastValueFrom, Observable } from 'rxjs';
import { QueryClient } from '@tanstack/angular-query-experimental';
import { ApiService } from './api.service';

/** Query keys de Alertas; invalidar tras cualquier alta/edición/borrado. */
export const ALERTS_RULES_QUERY_KEY = ['alerts', 'rules'] as const;
export const ALERTS_NOTIFICATIONS_QUERY_KEY = ['alerts', 'notifications'] as const;
export const ALERTS_UNWATCHED_QUERY_KEY = ['alerts', 'unwatched'] as const;

/** El pack al que pertenece un SKU (ver Productos → Packs); `null` si se pide suelto. */
export interface PackRef {
  packId: number;
  name: string;
  /** Código propio del pack (opcional), distinto del SKU de sus modelos. */
  sku: string | null;
  unitCount: number;
  mode: 'assorted' | 'single';
}

/** Una regla de alerta, con el stock de hoy y el pack ya resueltos (lo que pinta la pestaña Reglas). */
export interface StockAlertRule {
  sku: string;
  threshold: number;
  productLabel: string | null;
  /** 'ok' | 'triggered' — ver evaluateStockAlerts en el backend (histéresis). */
  state: 'ok' | 'triggered';
  mutedUntil: string | null;
  stockMl: number | null;
  stockTn: number | null;
  /** min(ML, TN); `null` si el SKU no está en ningún canal. */
  stockEffective: number | null;
  pack: PackRef | null;
}

export interface StockNotification {
  id: number;
  sku: string;
  productLabel: string | null;
  threshold: number;
  stockMl: number | null;
  stockTn: number | null;
  stockEffective: number;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationsInbox {
  notifications: StockNotification[];
  total: number;
  unreadCount: number;
}

/** Producto matcheado (ML+TN) sin regla de alerta todavía, para la pestaña "Sin alertas". */
export interface UnwatchedProduct {
  sku: string;
  productLabel: string | null;
  thumbnail: string | null;
  stockMl: number | null;
  stockTn: number | null;
  stockEffective: number | null;
  pack: PackRef | null;
}

export interface UnwatchedProductsResponse {
  products: UnwatchedProduct[];
}

@Injectable({ providedIn: 'root' })
export class AlertsService {
  private readonly queryClient = inject(QueryClient);

  constructor(
    private http: HttpClient,
    private api: ApiService
  ) {}

  private invalidateAll(): void {
    this.queryClient.invalidateQueries({ queryKey: ALERTS_RULES_QUERY_KEY });
    this.queryClient.invalidateQueries({ queryKey: ALERTS_NOTIFICATIONS_QUERY_KEY });
    this.queryClient.invalidateQueries({ queryKey: ALERTS_UNWATCHED_QUERY_KEY });
  }

  getRules(): Observable<{ rules: StockAlertRule[] }> {
    return this.http.get<{ rules: StockAlertRule[] }>(`${this.api.baseUrl}/alerts`);
  }

  getRulesPromise(): Promise<{ rules: StockAlertRule[] }> {
    return lastValueFrom(this.getRules());
  }

  /** Alta/edición de una regla. Evalúa contra el stock actual: si ya está bajo, dispara al toque. */
  async saveRule(sku: string, threshold: number, productLabel?: string): Promise<void> {
    await lastValueFrom(
      this.http.put<{ ok: boolean }>(`${this.api.baseUrl}/alerts/${encodeURIComponent(sku)}`, { threshold, productLabel })
    );
    this.invalidateAll();
  }

  async deleteRule(sku: string): Promise<void> {
    await lastValueFrom(this.http.delete<{ ok: boolean }>(`${this.api.baseUrl}/alerts/${encodeURIComponent(sku)}`));
    this.invalidateAll();
  }

  async muteRule(sku: string, days = 7): Promise<void> {
    await lastValueFrom(this.http.post<{ ok: boolean }>(`${this.api.baseUrl}/alerts/${encodeURIComponent(sku)}/mute`, { days }));
    this.invalidateAll();
  }

  getNotifications(opts?: { unreadOnly?: boolean; limit?: number; offset?: number }): Observable<NotificationsInbox> {
    let params = new HttpParams();
    if (opts?.unreadOnly) params = params.set('unread', '1');
    if (opts?.limit != null) params = params.set('limit', String(opts.limit));
    if (opts?.offset != null) params = params.set('offset', String(opts.offset));
    return this.http.get<NotificationsInbox>(`${this.api.baseUrl}/alerts/notifications`, { params });
  }

  getNotificationsPromise(opts?: { unreadOnly?: boolean; limit?: number; offset?: number }): Promise<NotificationsInbox> {
    return lastValueFrom(this.getNotifications(opts));
  }

  async markNotificationsRead(payload: { ids?: number[]; all?: boolean }): Promise<void> {
    await lastValueFrom(this.http.post<{ ok: boolean }>(`${this.api.baseUrl}/alerts/notifications/read`, payload));
    this.invalidateAll();
  }

  getUnwatched(): Observable<UnwatchedProductsResponse> {
    return this.http.get<UnwatchedProductsResponse>(`${this.api.baseUrl}/alerts/unwatched`);
  }

  getUnwatchedPromise(): Promise<UnwatchedProductsResponse> {
    return lastValueFrom(this.getUnwatched());
  }
}
