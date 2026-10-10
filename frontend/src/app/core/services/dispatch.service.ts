import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { lastValueFrom } from 'rxjs';
import { ApiService } from './api.service';

export const DISPATCH_QUERY_KEY = ['dispatch', 'list'] as const;

export type DispatchChannel = 'ml' | 'tn';
export type DispatchBucket = 'cancelled' | 'overdue' | 'today' | 'upcoming';
export type DispatchTone = 'ok' | 'warn' | 'err' | 'neutral';

export interface DispatchItem {
  sku: string | null;
  title: string;
  variation: string | null;
  qty: number;
  thumb: string | null;
  /** Fotos grandes, para el zoom. */
  pictures: string[];
}

export interface DispatchPackage {
  channel: DispatchChannel;
  /** ML: pack_id ?? order_id (el nro de venta que se ve en ML). TN: id interno de la orden. */
  saleId: string;
  orderIds?: string[];
  /** TN: nro de orden visible. */
  orderNumber?: string | null;
  buyer: string | null;
  city: string | null;
  createdAt: string | null;
  logisticType: string | null;
  shipStatus: string | null;
  substatus: string | null;
  shippingMethod: string | null;
  deadline: string | null;
  /** true si `deadline` trae hora exacta (SLA de ML); false si es solo el día. */
  deadlineHasTime: boolean;
  deadlineDay: string | null;
  slaStatus: string | null;
  bufferedUntil: string | null;
  bufferedDay: string | null;
  cancelled: boolean;
  cancelledAt?: string | null;
  bucket: DispatchBucket;
  state: { label: string; tone: DispatchTone };
  preparedAt: string | null;
  preparedBy: string | null;
  items: DispatchItem[];
}

export interface DispatchList {
  generatedAt: string;
  /** `YYYY-MM-DD` de hoy en Argentina, según el backend. */
  today: string;
  packages: DispatchPackage[];
  errors: { ml?: string; tn?: string };
}

@Injectable({ providedIn: 'root' })
export class DispatchService {
  private readonly http = inject(HttpClient);
  private readonly api = inject(ApiService);

  getList(refresh = false): Promise<DispatchList> {
    const qs = refresh ? '?refresh=1' : '';
    return lastValueFrom(this.http.get<DispatchList>(`${this.api.baseUrl}/dispatch${qs}`));
  }

  setPrepared(pkg: Pick<DispatchPackage, 'channel' | 'saleId'>, prepared: boolean): Promise<unknown> {
    const url = `${this.api.baseUrl}/dispatch/${pkg.channel}/${encodeURIComponent(pkg.saleId)}/prepared`;
    return lastValueFrom(prepared ? this.http.put(url, {}) : this.http.delete(url));
  }

  markCancelSeen(pkg: Pick<DispatchPackage, 'channel' | 'saleId'>): Promise<unknown> {
    return lastValueFrom(
      this.http.put(`${this.api.baseUrl}/dispatch/${pkg.channel}/${encodeURIComponent(pkg.saleId)}/cancel-seen`, {})
    );
  }
}
