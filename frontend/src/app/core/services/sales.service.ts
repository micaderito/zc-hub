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

  /**
   * Descarga el CSV por provincia del rango — mismo cálculo que el informe, hecho en el backend.
   * En el celular (PWA en iOS sobre todo) el link con `download` no anda bien: si el sistema sabe
   * compartir archivos, se abre la hoja de compartir (guardar en Archivos, mandar por WhatsApp…).
   */
  async exportCsv(from: string, to: string): Promise<void> {
    const blob = await lastValueFrom(
      this.http.get(`${this.api.baseUrl}/sales/export`, { params: this.dateRangeParams(from, to), responseType: 'blob' })
    );
    const filename = `ventas_${from}_${to}.csv`;
    const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
    if (typeof File !== 'undefined' && nav.canShare && nav.share) {
      const file = new File([blob], filename, { type: 'text/csv' });
      if (nav.canShare({ files: [file] })) {
        try {
          await nav.share({ files: [file], title: filename });
          return;
        } catch (err) {
          // Cerrar la hoja de compartir no es un error. Otro rechazo (ej. NotAllowedError porque la
          // descarga tardó y se venció el gesto del usuario) cae a la descarga por link.
          if ((err as DOMException)?.name === 'AbortError') return;
        }
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    // Revocar en el acto corta la descarga en algunos navegadores (Safari): se da un margen.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
