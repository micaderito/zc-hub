import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';
import { debounceTime, distinctUntilChanged, skip } from 'rxjs/operators';
import { QueryClient, injectQuery } from '@tanstack/angular-query-experimental';
import { AuditSource, PendingMlTasksResponse, SyncAuditRow, SyncService } from '../../core/services/sync.service';
import { errorMessage } from './sync.utils';

export const SYNC_RETURNS_QUERY_KEY = ['sync', 'returns'] as const;
export const SYNC_PENDING_TASKS_QUERY_KEY = ['sync', 'pendingTasks'] as const;
const AUDIT_PAGE_SIZE = 25;
const RETURNS_PAGE_SIZE = 20;
const TASKS_PAGE_SIZE = 20;

/**
 * Estado compartido de "Historial y cola". Se provee en SyncComponent (uno por visita) y lo
 * inyectan las pestañas. Vive acá lo que tiene que sobrevivir a cambiar de pestaña (cada pestaña
 * se monta solo mientras se ve) o lo que lee otra pestaña:
 * - las queries de devoluciones y de la Cola ML alimentan los contadores de las pestañas;
 * - el historial (filtros, página, filas) se conserva al ir y volver, y aprobar una devolución
 *   lo recarga desde otra pestaña.
 */
@Injectable()
export class SyncStore {
  private readonly sync = inject(SyncService);
  private readonly queryClient = inject(QueryClient);

  /** Habilita las queries de devoluciones y Cola ML (sin base no hay nada que pedir). */
  readonly hasDatabase = signal(false);

  // ── Historial ────────────────────────────────────────────────────
  readonly auditRows = signal<SyncAuditRow[]>([]);
  readonly auditTotal = signal(0);
  readonly auditLoading = signal(true);
  readonly auditFetching = signal(false);
  readonly auditError = signal<string | null>(null);
  readonly revertError = signal<string | null>(null);
  /** Filtro de origen del historial; '' = todos. */
  readonly auditSource = signal<AuditSource | ''>('');
  readonly auditSearchQuery = signal('');
  readonly auditCurrentPage = signal(1);
  readonly auditTotalPages = computed(() => Math.max(1, Math.ceil(this.auditTotal() / AUDIT_PAGE_SIZE)));
  private auditRequestId = 0;

  // ── Devoluciones ─────────────────────────────────────────────────
  readonly returnsCurrentPage = signal(1);
  readonly returnsQuery = injectQuery(() => ({
    queryKey: [...SYNC_RETURNS_QUERY_KEY, this.returnsCurrentPage()],
    queryFn: () => firstValueFrom(
      this.sync.getReturns(RETURNS_PAGE_SIZE, (this.returnsCurrentPage() - 1) * RETURNS_PAGE_SIZE)
    ),
    enabled: this.hasDatabase(),
    refetchOnWindowFocus: false,
    staleTime: 2 * 60 * 1000,
    gcTime: 5 * 60 * 1000
  }));
  readonly returnsTotal = computed(() => this.returnsQuery.data()?.total ?? 0);
  readonly returnsTotalPages = computed(() => Math.max(1, Math.ceil(this.returnsTotal() / RETURNS_PAGE_SIZE)));

  // ── Cola ML ──────────────────────────────────────────────────────
  readonly tasksCurrentPage = signal(1);
  readonly pendingTasksQuery = injectQuery<PendingMlTasksResponse>(() => ({
    queryKey: [...SYNC_PENDING_TASKS_QUERY_KEY, this.tasksCurrentPage()],
    queryFn: () => firstValueFrom(
      this.sync.getPendingTasks(TASKS_PAGE_SIZE, (this.tasksCurrentPage() - 1) * TASKS_PAGE_SIZE)
    ),
    enabled: this.hasDatabase(),
    refetchOnWindowFocus: true,
    staleTime: 0,
    refetchInterval: (query) => {
      const hasActive = (query.state.data?.activeCount ?? 0) > 0;
      return hasActive ? 4000 : 20000;
    }
  }));
  readonly tasksTotal = computed(() => this.pendingTasksQuery.data()?.total ?? 0);
  readonly tasksTotalPages = computed(() => Math.max(1, Math.ceil(this.tasksTotal() / TASKS_PAGE_SIZE)));
  readonly activeTasksCount = computed(() => this.pendingTasksQuery.data()?.activeCount ?? 0);
  readonly failedTasksCount = computed(() => this.pendingTasksQuery.data()?.failedCount ?? 0);

  constructor() {
    toObservable(this.auditSearchQuery)
      .pipe(skip(1), debounceTime(350), distinctUntilChanged(), takeUntilDestroyed(inject(DestroyRef)))
      .subscribe(() => this.refreshAudit());
  }

  loadAudit(page = this.auditCurrentPage()): void {
    if (this.auditRows().length > 0) this.auditFetching.set(true);
    else this.auditLoading.set(true);
    this.auditError.set(null);
    this.revertError.set(null);
    const offset = (page - 1) * AUDIT_PAGE_SIZE;
    const orderId = this.auditSearchQuery().trim() || undefined;
    const requestId = ++this.auditRequestId;
    this.sync.getAudit(AUDIT_PAGE_SIZE, offset, orderId, this.auditSource()).subscribe({
      next: (r) => {
        if (requestId !== this.auditRequestId) return;
        this.auditRows.set(r.rows);
        this.auditTotal.set(r.total);
        this.auditLoading.set(false);
        this.auditFetching.set(false);
      },
      error: (e) => {
        if (requestId !== this.auditRequestId) return;
        this.auditError.set(errorMessage(e, 'Error al cargar historial.'));
        this.auditLoading.set(false);
        this.auditFetching.set(false);
      }
    });
  }

  refreshAudit(): void {
    this.auditCurrentPage.set(1);
    this.loadAudit(1);
  }

  goToAuditPage(page: number): void {
    if (page < 1 || page > this.auditTotalPages()) return;
    this.auditCurrentPage.set(page);
    this.loadAudit(page);
  }

  setAuditSource(source: AuditSource | ''): void {
    if (this.auditSource() === source) return;
    this.auditSource.set(source);
    this.refreshAudit();
  }

  goToReturnsPage(page: number): void {
    if (page < 1 || page > this.returnsTotalPages()) return;
    this.returnsCurrentPage.set(page);
  }

  invalidateReturns(): void {
    this.queryClient.invalidateQueries({ queryKey: SYNC_RETURNS_QUERY_KEY });
  }

  goToTasksPage(page: number): void {
    if (page < 1 || page > this.tasksTotalPages()) return;
    this.tasksCurrentPage.set(page);
  }

  invalidateTasks(): void {
    this.queryClient.invalidateQueries({ queryKey: SYNC_PENDING_TASKS_QUERY_KEY });
  }
}
