import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { SalesProvinceRow, SalesReport } from '../../core/services/sales.service';
import { BottomSheetComponent } from '../../shared/components/bottom-sheet/bottom-sheet.component';
import { formatDay, MonthOption } from './ventas.utils';

export type VentasView = 'provincias' | 'productos' | 'dias';

/** Cuántos meses entran como chips; el resto (y un rango a mano) va por "Otro…". */
const MONTH_CHIPS = 6;

/**
 * Ventas por provincia en el celular: meses en chips, lo facturado en grande, y abajo Provincias /
 * Productos / Por día de a uno. Tocar una provincia abre su detalle en una hoja. El estado (rango,
 * informe, sincronización) vive en `VentasComponent`; esto solo lo muestra y avisa qué se tocó.
 */
@Component({
  selector: 'zc-ventas-phone',
  standalone: true,
  imports: [BottomSheetComponent],
  templateUrl: './ventas-phone.component.html',
  styleUrl: './ventas-phone.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VentasPhoneComponent {
  readonly report = input<SalesReport | undefined>(undefined);
  readonly loading = input(false);
  readonly neverSynced = input(false);
  readonly rangeValid = input(true);
  readonly syncing = input(false);
  readonly lastSyncLabel = input('');
  readonly months = input<MonthOption[]>([]);
  readonly selectedMonth = input('');
  readonly from = input('');
  readonly to = input('');

  readonly monthChange = output<string>();
  readonly fromChange = output<string>();
  readonly toChange = output<string>();
  readonly sync = output<void>();
  readonly exportCsv = output<void>();

  readonly view = signal<VentasView>('provincias');
  readonly views: { key: VentasView; label: string }[] = [
    { key: 'provincias', label: 'Provincias' },
    { key: 'productos', label: 'Productos' },
    { key: 'dias', label: 'Por día' },
  ];

  readonly monthChips = computed(() => this.months().slice(0, MONTH_CHIPS));
  readonly isCustom = computed(() => !this.monthChips().some((m) => m.value === this.selectedMonth()));

  private readonly selected = computed(() => this.months().find((m) => m.value === this.selectedMonth()) ?? null);

  /** "en octubre" para un mes; "del 1/10 al 15/10" para un rango. */
  readonly periodLabel = computed(() => {
    const m = this.selected();
    if (m) return `en ${this.monthName(m)}`;
    return `del ${formatDay(this.from())} al ${formatDay(this.to())}`;
  });

  /** Contra qué se compara: el mes anterior si es un mes, si no "el período anterior" (mismo largo). */
  readonly previousLabel = computed(() => {
    const months = this.months();
    const i = months.findIndex((m) => m.value === this.selectedMonth());
    const prev = i >= 0 ? months[i + 1] : undefined;
    return prev ? this.monthName(prev) : 'el período anterior';
  });

  /** Barra de cada provincia: contra la que más facturó (la primera queda llena). */
  readonly provinceBars = computed(() => {
    const rows = this.report()?.provinces ?? [];
    const max = rows.reduce((m, p) => Math.max(m, p.facturado), 0) || 1;
    return rows.map((p) => ({ row: p, widthPct: Math.max(2, Math.round((p.facturado / max) * 100)) }));
  });

  readonly dailyBars = computed(() => {
    const daily = this.report()?.daily ?? [];
    const max = daily.reduce((m, d) => Math.max(m, d.amount), 0) || 1;
    return daily.map((d) => ({ day: d.day, amount: d.amount, heightPct: Math.max(2, Math.round((d.amount / max) * 100)) }));
  });

  readonly selectedDay = signal<string | null>(null);
  readonly selectedBar = computed(() => this.dailyBars().find((b) => b.day === this.selectedDay()) ?? null);

  toggleDay(day: string): void {
    this.selectedDay.update((d) => (d === day ? null : day));
  }

  /* ── Hojas ── */

  readonly openProvince = signal<SalesProvinceRow | null>(null);
  readonly rangeOpen = signal(false);

  provinceRank(p: SalesProvinceRow): number {
    return (this.report()?.provinces.indexOf(p) ?? 0) + 1;
  }

  pickMonth(value: string): void {
    this.selectedDay.set(null);
    this.monthChange.emit(value);
  }

  /* ── Formato ── */

  readonly formatDay = formatDay;

  monthName(m: MonthOption): string {
    const [name, year] = m.label.split(' ');
    return year === String(new Date().getFullYear()) ? name : m.label;
  }

  /** Chip corto: "sept." / "nov."; "octubre" entra entero. */
  chipLabel(m: MonthOption): string {
    const name = this.monthName(m);
    if (name.length <= 7 || name.includes(' ')) return name;
    return name === 'septiembre' ? 'sept.' : name.slice(0, 3) + '.';
  }

  money(n: number | null | undefined): string {
    if (n == null) return '—';
    return '$' + Math.round(n).toLocaleString('es-AR');
  }

  pct(n: number): string {
    return `${n >= 0 ? '+' : '−'}${Math.abs(n)}%`;
  }
}
