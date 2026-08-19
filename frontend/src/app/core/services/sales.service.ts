import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { lastValueFrom, Observable } from 'rxjs';
import { QueryClient } from '@tanstack/angular-query-experimental';
import { ApiService } from './api.service';

export const SALES_REPORT_QUERY_KEY = ['sales', 'report'] as const;
export const SALES_SYNC_STATE_QUERY_KEY = ['sales', 'sync-state'] as const;

export interface SalesKpis {
  facturadoTotal: number;
  facturadoDeltaPct: number;
  ventas: number;
  ventasDeltaPct: number;
  unidades: number;
  unidadesDeltaPct: number;
  ticketPromedio: number;
  ticketPromedioDeltaPct: number;
}

export interface SalesProvinceRow {
  name: string;
  ventas: number;
  unidades: number;
  facturado: number;
  pctOfTotal: number;
  deltaPct: number;
}

export interface SalesExcluded {
  total: number;
  facturadas: number;
  canceladas: number;
  devueltas: number;
}

export interface SalesTopProduct {
  sku: string;
  title: string | null;
  units: number;
  amount: number;
}

export interface SalesDailyPoint {
  day: string;
  amount: number;
}

export interface SalesReport {
  kpis: SalesKpis;
  provinces: SalesProvinceRow[];
  excluded: SalesExcluded;
  topProducts: SalesTopProduct[];
  daily: SalesDailyPoint[];
}

export type SalesSyncStatus = 'idle' | 'running' | 'error';

export interface SalesSyncState {
  status: SalesSyncStatus;
  lastSyncAt: string | null;
  processed: number;
  total: number;
  phase: string | null;
  error?: string;
}

@Injectable({ providedIn: 'root' })
export class SalesService {
  private readonly queryClient = inject(QueryClient);

  constructor(
    private http: HttpClient,
    private api: ApiService
  ) {}

  private dateRangeParams(from: string, to: string): HttpParams {
    return new HttpParams().set('from', from).set('to', to);
  }

  getReport(from: string, to: string): Observable<SalesReport> {
    return this.http.get<SalesReport>(`${this.api.baseUrl}/sales/report`, { params: this.dateRangeParams(from, to) });
  }

  getReportPromise(from: string, to: string): Promise<SalesReport> {
    return lastValueFrom(this.getReport(from, to));
  }

  getSyncState(): Observable<SalesSyncState> {
    return this.http.get<SalesSyncState>(`${this.api.baseUrl}/sales/sync-state`);
  }

  getSyncStatePromise(): Promise<SalesSyncState> {
    return lastValueFrom(this.getSyncState());
  }

  /** Dispara el barrido (o el backfill inicial la primera vez). No espera a que termine. */
  async startSync(): Promise<void> {
    await lastValueFrom(this.http.post<{ ok: boolean }>(`${this.api.baseUrl}/sales/sync`, {}));
    this.queryClient.invalidateQueries({ queryKey: SALES_SYNC_STATE_QUERY_KEY });
  }

  /** Descarga el CSV por provincia del rango — mismo cálculo que el informe, hecho en el backend. */
  async exportCsv(from: string, to: string): Promise<void> {
    const blob = await lastValueFrom(
      this.http.get(`${this.api.baseUrl}/sales/export`, { params: this.dateRangeParams(from, to), responseType: 'blob' })
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ventas_${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
}
