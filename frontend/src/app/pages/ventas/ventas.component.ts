import { Component, inject, signal, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { injectQuery, QueryClient } from '@tanstack/angular-query-experimental';
import {
  SalesService,
  SALES_REPORT_QUERY_KEY,
  SALES_SYNC_STATE_QUERY_KEY,
  SalesReport,
  SalesSyncState,
} from '../../core/services/sales.service';

/** Un mes calendario, para el select de presets del toolbar. */
interface MonthOption {
  value: string; // 'YYYY-MM'
  label: string;
  from: string; // 'YYYY-MM-DD'
  to: string;
}

const MONTH_LABELS = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function isoDate(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate();
}

/** Últimos `count` meses calendario (el más reciente primero), incluyendo el actual. */
function buildMonthOptions(count: number, today: Date): MonthOption[] {
  const out: MonthOption[] = [];
  let y = today.getFullYear();
  let m = today.getMonth() + 1; // 1-indexado
  for (let i = 0; i < count; i++) {
    out.push({
      value: `${y}-${pad2(m)}`,
      label: `${MONTH_LABELS[m - 1]} ${y}`,
      from: isoDate(y, m, 1),
      to: isoDate(y, m, daysInMonth(y, m)),
    });
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return out;
}

@Component({
  selector: 'app-ventas',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './ventas.component.html',
  styleUrl: './ventas.component.scss',
})
export class VentasComponent {
  private readonly salesSvc = inject(SalesService);
  private readonly queryClient = inject(QueryClient);

  private readonly monthOptions = buildMonthOptions(13, new Date());
  readonly months = this.monthOptions;

  // Default: el último mes CERRADO (el anterior al actual) — es el caso de uso típico: armar el
  // informe del contador apenas termina el mes.
  readonly selectedMonth = signal<string>(this.monthOptions[1]?.value ?? this.monthOptions[0].value);
  readonly from = signal<string>(this.monthOptions[1]?.from ?? this.monthOptions[0].from);
  readonly to = signal<string>(this.monthOptions[1]?.to ?? this.monthOptions[0].to);

  onMonthChange(value: string): void {
    this.selectedMonth.set(value);
    const opt = this.monthOptions.find((m) => m.value === value);
    if (opt) {
      this.from.set(opt.from);
      this.to.set(opt.to);
    }
  }

  onFromChange(value: string): void {
    this.from.set(value);
    this.selectedMonth.set('custom');
  }

  onToChange(value: string): void {
    this.to.set(value);
    this.selectedMonth.set('custom');
  }

  readonly rangeValid = computed(() => !!this.from() && !!this.to() && this.from() <= this.to());

  readonly reportQuery = injectQuery(() => ({
    queryKey: [...SALES_REPORT_QUERY_KEY, this.from(), this.to()],
    queryFn: () => this.salesSvc.getReportPromise(this.from(), this.to()),
    enabled: this.rangeValid(),
    refetchOnWindowFocus: false,
    staleTime: 60 * 1000,
  }));

  readonly report = computed<SalesReport | undefined>(() => this.reportQuery.data());
  readonly reportLoading = computed(() => this.reportQuery.isLoading());

  readonly syncQuery = injectQuery(() => ({
    queryKey: SALES_SYNC_STATE_QUERY_KEY,
    queryFn: () => this.salesSvc.getSyncStatePromise(),
    refetchOnWindowFocus: false,
    refetchInterval: (query: { state: { data?: SalesSyncState } }) => (query.state.data?.status === 'running' ? 2000 : false),
  }));

  readonly syncState = computed(() => this.syncQuery.data());
  readonly syncing = computed(() => this.syncState()?.status === 'running');
  readonly neverSynced = computed(() => !this.syncQuery.isLoading() && !this.syncState()?.lastSyncAt);

  // Cuando el barrido pasa de 'running' a otro estado, el informe quedó desactualizado en el
  // medio (staleTime lo hubiera servido de caché) — se invalida para que se vuelva a pedir.
  private previousSyncStatus: SalesSyncState['status'] | undefined;
  private readonly onSyncFinish = effect(() => {
    const status = this.syncState()?.status;
    if (this.previousSyncStatus === 'running' && status && status !== 'running') {
      this.queryClient.invalidateQueries({ queryKey: SALES_REPORT_QUERY_KEY });
    }
    this.previousSyncStatus = status;
  });

  readonly syncProgressPct = computed(() => {
    const s = this.syncState();
    if (!s || !s.total) return 0;
    return Math.round((s.processed / s.total) * 100);
  });

  readonly lastSyncLabel = computed(() => {
    const iso = this.syncState()?.lastSyncAt;
    if (!iso) return 'Nunca sincronizado';
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'Actualizado recién';
    if (mins < 60) return `Actualizado hace ${mins} min`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `Actualizado hace ${hours} h`;
    return `Actualizado hace ${Math.round(hours / 24)} d`;
  });

  async onSyncClick(): Promise<void> {
    if (this.syncing()) return;
    await this.salesSvc.startSync();
  }

  async onExportClick(): Promise<void> {
    await this.salesSvc.exportCsv(this.from(), this.to());
  }

  /* ══════════════════════════ Gráfico de evolución diaria ══════════════════════════ */

  readonly dailyBars = computed(() => {
    const daily = this.report()?.daily ?? [];
    const max = daily.reduce((m, d) => Math.max(m, d.amount), 0) || 1;
    return daily.map((d) => ({
      day: d.day,
      amount: d.amount,
      heightPct: Math.max(2, Math.round((d.amount / max) * 100)),
    }));
  });

  readonly maxProvinceFacturado = computed(() => {
    const provinces = this.report()?.provinces ?? [];
    return provinces.reduce((m, p) => Math.max(m, p.facturado), 0) || 1;
  });

  /* ══════════════════════════ Formato ══════════════════════════ */

  money(n: number | null | undefined): string {
    if (n == null) return '—';
    return '$' + Math.round(n).toLocaleString('es-AR');
  }

  formatDay(iso: string): string {
    const d = new Date(iso);
    return `${d.getDate()}/${d.getMonth() + 1}`;
  }
}
