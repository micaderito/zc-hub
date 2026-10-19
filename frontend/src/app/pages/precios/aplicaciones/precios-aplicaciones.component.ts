import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CurrencyPipe, DatePipe } from '@angular/common';
import { injectQuery } from '@tanstack/angular-query-experimental';
import { firstValueFrom } from 'rxjs';
import {
  ApplyChannelCounts, ApplyItemStatus, ApplyRun, ApplyRunItem, PricingService,
} from '../../../core/services/pricing.service';
import { PaginationComponent } from '../../../shared/components/pagination/pagination.component';
import { apiError } from '../precios.utils';

const PAGE_SIZE = 20;

export const APPLY_STATUS_LABEL: Record<ApplyItemStatus, string> = {
  ok: 'Aplicado',
  queued: 'En cola',
  retrying: 'Reintentando',
  failed: 'Falló',
  skipped: 'Omitido',
};

/** Lo que todavía se mueve solo (la cola de ML): mientras haya algo así, la vista se refresca. */
const IN_FLIGHT: ApplyItemStatus[] = ['queued', 'retrying'];
/** Lo que se muestra con "Solo con problemas". */
const PROBLEMS: ApplyItemStatus[] = ['failed', 'retrying', 'skipped'];

/**
 * Pestaña "Aplicaciones" de Actualizar precios: cada "Aplicar a ML y TN" con cómo terminó en cada
 * canal. ML se resuelve en vivo contra su tarea de la cola (en cola → reintentando → aplicado /
 * falló); TN queda como salió el bulk. Lo que falló se reintenta desde acá, con el mismo precio
 * que se mandó esa vez — sin tener que volver a tildarlo en la planilla.
 */
@Component({
  selector: 'zc-precios-aplicaciones',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CurrencyPipe, DatePipe, PaginationComponent],
  templateUrl: './precios-aplicaciones.component.html',
  styleUrl: './precios-aplicaciones.component.scss',
})
export class PreciosAplicacionesComponent {
  private readonly pricing = inject(PricingService);

  readonly statusLabel = APPLY_STATUS_LABEL;
  readonly page = signal(1);
  readonly expanded = signal<number | null>(null);
  readonly onlyProblems = signal(true);
  readonly retrying = signal<number | null>(null);
  readonly notice = signal<string | null>(null);
  readonly errorMsg = signal<string | null>(null);

  readonly runsQuery = injectQuery(() => ({
    queryKey: ['pricing', 'apply-runs', this.page()],
    queryFn: () => firstValueFrom(this.pricing.listApplyRuns(PAGE_SIZE, (this.page() - 1) * PAGE_SIZE)),
    refetchInterval: (q: { state: { data?: { runs: ApplyRun[] } } }) =>
      q.state.data?.runs.some((r) => inFlight(r.counts.ml) > 0) ? 10_000 : false,
  }));

  readonly itemsQuery = injectQuery(() => ({
    queryKey: ['pricing', 'apply-run', this.expanded()],
    queryFn: () => firstValueFrom(this.pricing.getApplyRun(this.expanded()!)),
    enabled: this.expanded() != null,
    refetchInterval: (q: { state: { data?: { items: ApplyRunItem[] } } }) =>
      q.state.data?.items.some((i) => IN_FLIGHT.includes(i.status)) ? 10_000 : false,
  }));

  readonly runs = computed<ApplyRun[]>(() => this.runsQuery.data()?.runs ?? []);
  readonly total = computed(() => this.runsQuery.data()?.total ?? 0);
  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.total() / PAGE_SIZE)));

  readonly items = computed<ApplyRunItem[]>(() => {
    const all = this.itemsQuery.data()?.items ?? [];
    return this.onlyProblems() ? all.filter((i) => PROBLEMS.includes(i.status)) : all;
  });
  readonly allItemsCount = computed(() => this.itemsQuery.data()?.items.length ?? 0);

  count(c: ApplyChannelCounts, status: ApplyItemStatus): number {
    return c[status] ?? 0;
  }

  failedCount(run: ApplyRun): number {
    return (run.counts.ml.failed ?? 0) + (run.counts.tn.failed ?? 0);
  }

  /** Cuántas filas tiene ese canal (para no mostrar un canal que no se aplicó). */
  channelTotal(c: ApplyChannelCounts): number {
    return Object.values(c).reduce((a, n) => a + (n ?? 0), 0);
  }

  toggle(run: ApplyRun): void {
    this.expanded.set(this.expanded() === run.id ? null : run.id);
    this.onlyProblems.set(this.failedCount(run) + (run.counts.ml.retrying ?? 0) + (run.counts.ml.skipped ?? 0) + (run.counts.tn.skipped ?? 0) > 0);
  }

  async retry(run: ApplyRun, itemIds?: number[]): Promise<void> {
    this.retrying.set(run.id);
    this.notice.set(null);
    this.errorMsg.set(null);
    try {
      const res = await firstValueFrom(this.pricing.retryApplyRun(run.id, itemIds));
      const parts: string[] = [];
      if (res.retriedMl > 0) parts.push(`${res.retriedMl} vuelven a la cola de ML`);
      if (res.appliedTn > 0) parts.push(`${res.appliedTn} aplicados en TN`);
      if (res.failedTn > 0) parts.push(`${res.failedTn} volvieron a fallar en TN`);
      this.notice.set(parts.length ? parts.join(' · ') : 'No había nada para reintentar');
      await Promise.all([this.runsQuery.refetch(), this.expanded() != null ? this.itemsQuery.refetch() : null]);
    } catch (e) {
      this.errorMsg.set(apiError(e, 'No se pudo reintentar'));
    } finally {
      this.retrying.set(null);
    }
  }

  prevPage(): void {
    this.page.update((p) => Math.max(1, p - 1));
  }

  nextPage(): void {
    this.page.update((p) => Math.min(this.totalPages(), p + 1));
  }
}

function inFlight(c: ApplyChannelCounts): number {
  return IN_FLIGHT.reduce((a, s) => a + (c[s] ?? 0), 0);
}
