import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { lastValueFrom, Observable } from 'rxjs';
import { QueryClient } from '@tanstack/angular-query-experimental';
import { ApiService } from './api.service';

/** Query keys de Alertas; invalidar tras cualquier alta/edición/borrado. */
export const ALERTS_RULES_QUERY_KEY = ['alerts', 'rules'] as const;
export const ALERTS_RESTOCK_QUERY_KEY = ['alerts', 'restock'] as const;
export const ALERTS_NOTIFICATIONS_QUERY_KEY = ['alerts', 'notifications'] as const;

/** El pack al que pertenece un SKU (ver Productos → Packs); `null` si se pide suelto. */
export interface PackRef {
  packId: number;
  name: string;
  /** Código propio del pack (opcional), distinto del SKU de sus modelos. */
  sku: string | null;
  unitCount: number;
  mode: 'assorted' | 'single';
}

/** El pack de una fila de "Para reponer": trae además la cantidad de packs sugerida (ver computePackSuggestedQty en el backend). */
export interface RestockPackRef extends PackRef {
  suggestedPacks: SuggestedQty | null;
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

export type RestockState = 'still-low' | 'out' | 'restocked' | 'unknown';

/** Cantidad sugerida a pedir: en packs si el producto tiene uno, en unidades sueltas si no. */
export interface SuggestedQty {
  unit: 'packs' | 'unidades';
  qty: number;
}

export interface RestockRow {
  sku: string;
  productLabel: string | null;
  firstTriggeredAt: string | null;
  timesTriggered: number;
  threshold: number;
  stockMl: number | null;
  stockTn: number | null;
  stockEffective: number | null;
  state: RestockState;
  pack: RestockPackRef | null;
  /** `null` cuando el producto tiene pack y no se cargó un ajuste manual: la sugerencia real es la del pack (`pack.suggestedPacks`). */
  suggested: SuggestedQty | null;
}

export interface RestockList {
  rows: RestockRow[];
  /** Desde cuándo cuenta el período actual (`null` = todo el historial). */
  cutoff: string | null;
}

export type RestockPeriod = 'last-order' | '30d' | 'all';

@Injectable({ providedIn: 'root' })
export class AlertsService {
  private readonly queryClient = inject(QueryClient);

  constructor(
    private http: HttpClient,
    private api: ApiService
  ) {}

  private invalidateAll(): void {
    this.queryClient.invalidateQueries({ queryKey: ALERTS_RULES_QUERY_KEY });
    this.queryClient.invalidateQueries({ queryKey: ALERTS_RESTOCK_QUERY_KEY });
    this.queryClient.invalidateQueries({ queryKey: ALERTS_NOTIFICATIONS_QUERY_KEY });
  }

  private invalidateRestock(): void {
    this.queryClient.invalidateQueries({ queryKey: ALERTS_RESTOCK_QUERY_KEY });
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

  getRestock(period: RestockPeriod = 'last-order'): Observable<RestockList> {
    const params = new HttpParams().set('period', period);
    return this.http.get<RestockList>(`${this.api.baseUrl}/alerts/restock`, { params });
  }

  getRestockPromise(period: RestockPeriod = 'last-order'): Promise<RestockList> {
    return lastValueFrom(this.getRestock(period));
  }

  /** "Marcar pedido como hecho": cierra el período. No borra reglas ni notificaciones. */
  async closeRestockPeriod(): Promise<void> {
    await lastValueFrom(this.http.post<{ ok: boolean }>(`${this.api.baseUrl}/alerts/restock/done`, {}));
    this.invalidateAll();
  }

  /** Ajusta a mano la cantidad "a pedir" de un SKU o un pack; `qty: null` la borra y vuelve a la sugerida. */
  async saveRestockOverride(targetType: 'sku' | 'pack', targetId: string, qty: number | null): Promise<void> {
    await lastValueFrom(
      this.http.put<{ ok: boolean }>(`${this.api.baseUrl}/alerts/restock/override`, { targetType, targetId, qty })
    );
    this.invalidateRestock();
  }
}

/** Etiqueta legible para el estado de una fila de "Para reponer". */
export function restockStateLabel(state: RestockState): string {
  switch (state) {
    case 'out': return 'Sin stock';
    case 'restocked': return 'Ya repuesto';
    case 'still-low': return 'Sigue bajo';
    default: return 'Sin datos';
  }
}
