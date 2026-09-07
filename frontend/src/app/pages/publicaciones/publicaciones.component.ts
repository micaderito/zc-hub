import { Component, computed, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { injectQuery } from '@tanstack/angular-query-experimental';
import { CatalogService, PublishJobRow, PublishUnit } from '../../core/services/catalog.service';
import { SearchBarComponent } from '../../shared/components/search-bar/search-bar.component';
import { PaginationComponent } from '../../shared/components/pagination/pagination.component';

const PER_PAGE = 20;

type StatusKey = '' | 'done' | 'error' | 'cancelled' | 'running';

/**
 * Historial de publicaciones de productos (todas, de todos los borradores). Lee de
 * `product_publish_jobs` / `product_publish_units` vía `GET /api/products/publish-jobs`. Cada fila
 * es un intento de publicar; al expandirla se ven las unidades (ítem ML / producto TN) con su id
 * externo y el resultado. Reintentar / cancelar / borrar reusan los endpoints de `/jobs/:id`.
 */
@Component({
  selector: 'app-publicaciones',
  standalone: true,
  imports: [DatePipe, SearchBarComponent, PaginationComponent],
  templateUrl: './publicaciones.component.html',
  styleUrl: './publicaciones.component.scss',
})
export class PublicacionesComponent {
  private readonly catalog = inject(CatalogService);

  readonly search = signal('');
  readonly appliedSearch = signal('');
  readonly statusFilter = signal<StatusKey>('');
  readonly channelFilter = signal<'' | 'ml' | 'tn'>('');
  readonly page = signal(1);
  readonly expandedId = signal<string | null>(null);
  readonly busyId = signal<string | null>(null);

  readonly statusOptions: { key: StatusKey; label: string }[] = [
    { key: '', label: 'Todas' },
    { key: 'running', label: 'En curso' },
    { key: 'done', label: 'Publicadas' },
    { key: 'error', label: 'Con errores' },
    { key: 'cancelled', label: 'Canceladas' },
  ];

  constructor() {
    // debounce de la búsqueda: no dispara un query por tecla. (`allowSignalWrites`: el set va
    // dentro de un setTimeout, pero lo dejamos explícito por consistencia con el de abajo.)
    let t: ReturnType<typeof setTimeout>;
    effect(
      () => {
        const v = this.search();
        clearTimeout(t);
        t = setTimeout(() => {
          this.appliedSearch.set(v.trim());
          this.page.set(1);
        }, 300);
      },
      { allowSignalWrites: true }
    );
    // al cambiar un filtro de status/canal, volvemos a la página 1
    effect(
      () => {
        this.statusFilter();
        this.channelFilter();
        this.page.set(1);
      },
      { allowSignalWrites: true }
    );
  }

  readonly jobsQuery = injectQuery(() => ({
    queryKey: ['publish-jobs', this.page(), this.appliedSearch(), this.statusFilter(), this.channelFilter()],
    queryFn: () =>
      this.catalog.listPublishJobs(PER_PAGE, (this.page() - 1) * PER_PAGE, {
        q: this.appliedSearch() || undefined,
        // el filtro "running" no es un status de DB: se manda `processing` y el front también acepta `pending`
        status: this.statusFilter() === 'running' ? 'processing' : this.statusFilter() || undefined,
        channel: this.channelFilter() || undefined,
      }),
    staleTime: 10_000,
  }));

  readonly rows = computed(() => this.jobsQuery.data()?.rows ?? []);
  readonly total = computed(() => this.jobsQuery.data()?.total ?? 0);
  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.total() / PER_PAGE)));

  readonly detailQuery = injectQuery(() => ({
    queryKey: ['publish-job-detail', this.expandedId()],
    queryFn: () => this.catalog.getPublishJob(this.expandedId()!),
    enabled: !!this.expandedId(),
    staleTime: 5_000,
  }));

  readonly detailUnits = computed<PublishUnit[]>(() => this.detailQuery.data()?.units ?? []);

  toggle(id: string): void {
    this.expandedId.set(this.expandedId() === id ? null : id);
  }

  channelsOf(job: PublishJobRow): string[] {
    return String(job.channels || '').split(',').map((c) => c.trim()).filter(Boolean);
  }

  /** Etiqueta + color del badge de estado del job. */
  statusLabel(s: PublishJobRow['status']): string {
    return { pending: 'En cola', processing: 'Publicando…', done: 'Publicado', error: 'Con errores', cancelled: 'Cancelado' }[s] ?? s;
  }
  statusClass(s: PublishJobRow['status']): 'ok' | 'err' | 'busy' | 'warn' {
    if (s === 'done') return 'ok';
    if (s === 'error') return 'err';
    if (s === 'cancelled') return 'warn';
    return 'busy';
  }

  /** Link a la publicación en el canal, cuando se puede armar. TN no tiene URL pública deducible. */
  externalUrl(unit: PublishUnit): string | null {
    if (unit.channel === 'ml' && unit.externalId) {
      const digits = String(unit.externalId).replace(/\D/g, '');
      return digits ? `https://articulo.mercadolibre.com.ar/MLA-${digits}-x` : null;
    }
    return null;
  }

  async retry(job: PublishJobRow, ev: Event): Promise<void> {
    ev.stopPropagation();
    await this.run(job.id, () => this.catalog.retryPublishJob(job.id));
  }
  async cancel(job: PublishJobRow, ev: Event): Promise<void> {
    ev.stopPropagation();
    await this.run(job.id, () => this.catalog.cancelPublishJob(job.id));
  }
  async remove(job: PublishJobRow, ev: Event): Promise<void> {
    ev.stopPropagation();
    if (!confirm('¿Borrar esta entrada del historial? No toca las publicaciones ya creadas en ML/TN.')) return;
    await this.run(job.id, () => this.catalog.deletePublishJob(job.id));
    if (this.expandedId() === job.id) this.expandedId.set(null);
  }

  private async run(id: string, fn: () => Promise<unknown>): Promise<void> {
    this.busyId.set(id);
    try {
      await fn();
      await this.jobsQuery.refetch();
      if (this.expandedId() === id) await this.detailQuery.refetch();
    } catch {
      /* el badge se actualiza en el próximo refetch; no bloqueamos la UI por esto */
    } finally {
      this.busyId.set(null);
    }
  }

  prevPage(): void {
    this.page.update((p) => Math.max(1, p - 1));
  }
  nextPage(): void {
    this.page.update((p) => Math.min(this.totalPages(), p + 1));
  }
}
