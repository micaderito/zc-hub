import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { toObservable } from '@angular/core/rxjs-interop';
import { debounceTime, distinctUntilChanged, skip } from 'rxjs/operators';
import { QueryClient, injectQuery, injectMutation } from '@tanstack/angular-query-experimental';
import { SyncService, SyncConfig, SyncAuditRow, AuditSource, PendingReturnRow, PendingMlTask, PendingMlTasksResponse } from '../../core/services/sync.service';
import { SearchBarComponent } from '../../shared/components/search-bar/search-bar.component';
import { PaginationComponent } from '../../shared/components/pagination/pagination.component';
import { TabsComponent, TabDef } from '../../shared/components/tabs/tabs.component';
import { ConfirmDialogComponent } from '../../shared/components/confirm-dialog/confirm-dialog.component';

const SYNC_RETURNS_QUERY_KEY = ['sync', 'returns'] as const;
const SYNC_PENDING_TASKS_QUERY_KEY = ['sync', 'pendingTasks'] as const;
const AUDIT_PAGE_SIZE = 25;
const RETURNS_PAGE_SIZE = 20;
const TASKS_PAGE_SIZE = 20;

@Component({
  selector: 'app-sync',
  standalone: true,
  imports: [CommonModule, FormsModule, SearchBarComponent, PaginationComponent, TabsComponent, ConfirmDialogComponent],
  templateUrl: './sync.component.html',
  styleUrl: './sync.component.scss'
})
export class SyncComponent implements OnInit {
  private readonly sync = inject(SyncService);
  private readonly queryClient = inject(QueryClient);

  readonly activeTab = signal<string>('historial');

  config: SyncConfig | null = null;
  loading = true;
  savingToggle = false;
  error: string | null = null;

  auditRows: SyncAuditRow[] = [];
  auditTotal = 0;
  auditLoading = true;
  auditFetching = false;
  auditError: string | null = null;
  revertingAuditId: number | null = null;
  revertError: string | null = null;

  /** Filtro de origen del historial; '' = todos. */
  readonly auditSource = signal<AuditSource | ''>('');

  /** Opciones del filtro de origen, en el orden en que se muestran. */
  readonly auditSourceOptions: { key: AuditSource | ''; label: string }[] = [
    { key: '', label: 'Todos' },
    { key: 'venta', label: 'Ventas' },
    { key: 'manual', label: 'Manuales' },
    { key: 'devolucion', label: 'Devoluciones' },
  ];

  setAuditSource(source: AuditSource | ''): void {
    if (this.auditSource() === source) return;
    this.auditSource.set(source);
    this.auditCurrentPage.set(1);
    this.loadAudit(1);
  }

  readonly auditSearchQuery = signal('');
  readonly auditCurrentPage = signal(1);
  private auditRequestId = 0;

  readonly auditTotalPages = computed(() =>
    Math.max(1, Math.ceil(this.auditTotal / AUDIT_PAGE_SIZE))
  );

  reprocessOrderId = '';
  reprocessingOrder = false;
  reprocessResult: string | null = null;

  readonly hasDatabaseForReturns = signal(false);

  retryingTaskId: number | null = null;
  pendingTasksError: string | null = null;

  returnOrderId = '';
  addingReturn = false;
  fetchResult: string | null = null;
  approvingId: number | null = null;

  registeringWebhooks = false;
  webhooksResult: string | null = null;

  readonly returnsCurrentPage = signal(1);
  readonly returnsTotal = computed(() => this.returnsQuery.data()?.total ?? 0);
  readonly returnsTotalPages = computed(() =>
    Math.max(1, Math.ceil(this.returnsTotal() / RETURNS_PAGE_SIZE))
  );

  readonly returnsQuery = injectQuery(() => ({
    queryKey: [...SYNC_RETURNS_QUERY_KEY, this.returnsCurrentPage()],
    queryFn: () => firstValueFrom(
      this.sync.getReturns(RETURNS_PAGE_SIZE, (this.returnsCurrentPage() - 1) * RETURNS_PAGE_SIZE)
    ),
    enabled: this.hasDatabaseForReturns(),
    refetchOnWindowFocus: false,
    staleTime: 2 * 60 * 1000,
    gcTime: 5 * 60 * 1000
  }));

  readonly fetchReturnsMutation = injectMutation(() => ({
    mutationKey: ['sync', 'fetchReturns'],
    mutationFn: () => firstValueFrom(this.sync.fetchReturnsFromMl()),
    onSuccess: () => {
      this.queryClient.invalidateQueries({ queryKey: SYNC_RETURNS_QUERY_KEY });
    }
  }));

  readonly tasksCurrentPage = signal(1);
  readonly tasksTotal = computed(() => this.pendingTasksQuery.data()?.total ?? 0);
  readonly tasksTotalPages = computed(() =>
    Math.max(1, Math.ceil(this.tasksTotal() / TASKS_PAGE_SIZE))
  );

  readonly pendingTasksQuery = injectQuery<PendingMlTasksResponse>(() => ({
    queryKey: [...SYNC_PENDING_TASKS_QUERY_KEY, this.tasksCurrentPage()],
    queryFn: () => firstValueFrom(
      this.sync.getPendingTasks(TASKS_PAGE_SIZE, (this.tasksCurrentPage() - 1) * TASKS_PAGE_SIZE)
    ),
    enabled: this.hasDatabaseForReturns(),
    refetchOnWindowFocus: true,
    staleTime: 0,
    refetchInterval: (query) => {
      const hasActive = (query.state.data?.activeCount ?? 0) > 0;
      return hasActive ? 4000 : 20000;
    }
  }));

  readonly tabs = computed<TabDef[]>(() => {
    const returns = this.returnsTotal();
    const failed = this.failedTasksCount;
    const active = this.activeTasksCount;
    const taskCount = active + failed;
    return [
      { key: 'historial', label: 'Historial' },
      {
        key: 'devoluciones',
        label: 'Devoluciones',
        ...(returns > 0 ? { count: returns, countVariant: 'err' as const } : {})
      },
      {
        key: 'cola',
        label: 'Cola ML',
        ...(taskCount > 0 ? { count: taskCount, countVariant: (failed > 0 ? 'err' : 'warn') as 'err' | 'warn' } : {})
      },
      { key: 'estado', label: 'Estado' }
    ];
  });

  constructor() {
    toObservable(this.auditSearchQuery)
      .pipe(skip(1), debounceTime(350), distinctUntilChanged())
      .subscribe(() => {
        this.auditCurrentPage.set(1);
        this.loadAudit(1);
      });
  }

  ngOnInit(): void {
    this.loadConfig();
    this.loadAudit();
  }

  loadConfig(): void {
    this.loading = true;
    this.error = null;
    this.sync.getConfig().subscribe({
      next: (c) => {
        this.config = c;
        this.loading = false;
        // hasDatabaseForReturns habilita las queries de la lista de devoluciones y de Cola ML.
        // El crawl a ML (fetchReturnsMutation) NO se dispara acá: antes corría en cada montaje de
        // la pantalla sin importar la tab, así que entrar a mirar la cola gatillaba un crawl de
        // reclamos y alimentaba la tormenta de 429. Ahora solo corre al abrir la tab Devoluciones.
        if (c?.hasDatabase) {
          this.hasDatabaseForReturns.set(true);
          if (this.activeTab() === 'devoluciones') this.fetchReturns();
        }
      },
      error: (e) => {
        this.error = e.error?.error || e.message || 'Error al cargar.';
        this.loading = false;
      }
    });
  }

  /** Cambia de tab. Al entrar a Devoluciones, dispara el crawl a ML (una sola vez por apertura). */
  onTabChange(key: string): void {
    const prev = this.activeTab();
    this.activeTab.set(key);
    if (key === 'devoluciones' && prev !== 'devoluciones' && this.hasDatabaseForReturns()) {
      this.fetchReturns();
    }
  }

  /**
   * Crawl a ML en busca de devoluciones nuevas. El backend ya se protege solo (cache 2 min, respeta
   * el circuit breaker y abre un cooldown tras un fallo), así que dispararlo al abrir la tab es
   * seguro: si ML está saturado, responde sin pegarle. Ver /returns/fetch en el backend.
   */
  fetchReturns(): void {
    this.fetchReturnsMutation.mutate(undefined, {
      onSettled: () => {
        const r = this.fetchReturnsMutation.data();
        if (r && (r.created > 0 || r.skipped > 0))
          this.fetchResult = `Se revisaron ${r.claimsChecked} reclamos. Se agregaron ${r.created} ítems${r.skipped > 0 ? ` (${r.skipped} ya estaban)` : ''}.`;
      }
    });
  }

  loadAudit(page = this.auditCurrentPage()): void {
    if (this.auditRows.length > 0) {
      this.auditFetching = true;
    } else {
      this.auditLoading = true;
    }
    this.auditError = null;
    this.revertError = null;
    const offset = (page - 1) * AUDIT_PAGE_SIZE;
    const orderId = this.auditSearchQuery().trim() || undefined;
    const requestId = ++this.auditRequestId;
    this.sync.getAudit(AUDIT_PAGE_SIZE, offset, orderId, this.auditSource()).subscribe({
      next: (r) => {
        if (requestId !== this.auditRequestId) return;
        this.auditRows = r.rows;
        this.auditTotal = r.total;
        this.auditLoading = false;
        this.auditFetching = false;
      },
      error: (e) => {
        if (requestId !== this.auditRequestId) return;
        this.auditError = e.error?.error || e.message || 'Error al cargar historial.';
        this.auditLoading = false;
        this.auditFetching = false;
      }
    });
  }

  refreshAudit(): void {
    this.auditCurrentPage.set(1);
    this.loadAudit(1);
  }

  goToAuditPage(page: number): void {
    const total = this.auditTotalPages();
    if (page < 1 || page > total) return;
    this.auditCurrentPage.set(page);
    this.loadAudit(page);
  }

  goToReturnsPage(page: number): void {
    const total = this.returnsTotalPages();
    if (page < 1 || page > total) return;
    this.returnsCurrentPage.set(page);
  }

  goToTasksPage(page: number): void {
    const total = this.tasksTotalPages();
    if (page < 1 || page > total) return;
    this.tasksCurrentPage.set(page);
  }

  /** Nro de venta pendiente de confirmación por reintentar (ya estaba en el historial). */
  readonly confirmReprocessId = signal<string | null>(null);

  reprocessOrder(): void {
    const id = this.reprocessOrderId.trim();
    if (!id) return;
    this.reprocessResult = null;
    this.reprocessingOrder = true;
    this.sync.getAudit(50, 0, id).subscribe({
      next: (r) => {
        const alreadySynced = r.rows.some(row => !row.revertedAt && (row.orderId === id || row.packId === id));
        if (alreadySynced) {
          this.reprocessingOrder = false;
          this.confirmReprocessId.set(id);
          return;
        }
        this.submitReprocess(id);
      },
      error: () => this.submitReprocess(id)
    });
  }

  confirmReprocess(): void {
    const id = this.confirmReprocessId();
    if (!id) return;
    this.confirmReprocessId.set(null);
    this.reprocessingOrder = true;
    this.submitReprocess(id);
  }

  cancelReprocess(): void {
    this.confirmReprocessId.set(null);
  }

  private submitReprocess(id: string): void {
    this.sync.reprocessOrder(id).subscribe({
      next: (r) => {
        this.reprocessingOrder = false;
        this.reprocessResult = r.ok ? `Orden ${r.orderId} sincronizada: ${r.itemsSynced} ítem(s) descontados.` : null;
        if (r.ok) {
          this.reprocessOrderId = '';
          this.loadAudit();
        }
      },
      error: (e) => {
        this.reprocessingOrder = false;
        this.reprocessResult = e.error?.error || e.message || 'Error al reintentar.';
      }
    });
  }

  revertAudit(row: SyncAuditRow): void {
    if (row.revertedAt) return;
    this.revertError = null;
    this.revertingAuditId = row.id;
    this.sync.revertAudit(row.id).subscribe({
      next: () => {
        this.revertingAuditId = null;
        this.loadAudit();
      },
      error: (e) => {
        this.revertingAuditId = null;
        this.revertError = e.error?.error || e.message || 'No se pudo revertir.';
      }
    });
  }

  toggleSync(enabled: boolean): void {
    if (!this.config?.hasDatabase) return;
    this.savingToggle = true;
    this.error = null;
    this.sync.setSyncEnabled(enabled).subscribe({
      next: (r) => {
        if (this.config) this.config.enabled = r.enabled;
        this.savingToggle = false;
      },
      error: (e) => {
        this.error = e.error?.error || e.message || 'No se pudo actualizar.';
        this.savingToggle = false;
      }
    });
  }

  channelLabel(ch: string): string {
    return ch === 'mercadolibre' ? 'Mercado Libre' : 'Tienda Nube';
  }

  revertTitle(row: SyncAuditRow): string {
    const verb = row.stockAfter > row.stockBefore ? 'Descontar' : 'Sumar';
    return `${verb} ${row.quantity} de nuevo en ${this.channelLabel(row.updatedChannel)}`;
  }

  /**
   * Revertir deshace el descuento que hizo una venta. Un cambio manual no tiene venta detrás ni
   * cantidad que deshacer: se corrige volviendo a fijar el stock desde Precio y stock. El backend
   * también lo rechaza; esto evita ofrecer un botón que solo puede fallar.
   */
  canRevert(row: SyncAuditRow): boolean {
    return row.source !== 'manual';
  }

  /** Etiqueta del chip de origen de cada fila del historial. */
  auditSourceLabel(source: AuditSource): string {
    if (source === 'manual') return 'Manual';
    if (source === 'devolucion') return 'Devolución';
    return 'Venta';
  }

  stateChipClass(label: string | null | undefined): string {
    if (!label) return 'state-chip n';
    const n = label.toLowerCase().replace(/\s+/g, '-');
    if (n.includes('venta-ml')) return 'state-chip vml';
    if (n.includes('venta-tn')) return 'state-chip vtn';
    if (n.includes('cancelación') || n.includes('cancelacion')) return 'state-chip can';
    if (n.includes('devolución') || n.includes('devolucion')) return 'state-chip dev';
    return 'state-chip n';
  }

  formatDate(iso: string | null | undefined): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
  }

  get returnsRows(): PendingReturnRow[] {
    return this.returnsQuery.data()?.rows ?? [];
  }

  get returnsLoading(): boolean {
    return this.returnsQuery.isLoading();
  }

  get returnsError(): string | null {
    if (!this.returnsQuery.isError() || !this.returnsQuery.error()) return null;
    const err = this.returnsQuery.error() as { error?: { error?: string }; message?: string };
    return err?.error?.error ?? err?.message ?? 'Error al cargar devoluciones.';
  }

  get fetchingReturns(): boolean {
    return this.fetchReturnsMutation.isPending();
  }

  refreshReturns(): void {
    this.fetchResult = null;
    this.returnsCurrentPage.set(1);
    this.fetchReturnsMutation.mutate(undefined, {
      onSuccess: (r) => {
        this.fetchResult = r.mlBusy
          ? 'Mercado Libre está saturado en este momento. Probá de nuevo en un minuto.'
          : r.created > 0 || r.skipped > 0
            ? `Se revisaron ${r.claimsChecked} reclamos. Se agregaron ${r.created} ítems${r.skipped > 0 ? ` (${r.skipped} ya estaban)` : ''}.`
            : r.claimsChecked === 0
              ? 'No hay reclamos recientes con devolución en ML.'
              : 'Lista actualizada.';
      },
      onError: (e) => {
        this.fetchResult = (e as { error?: { error?: string }; message?: string })?.error?.error ?? (e as Error)?.message ?? 'Error al actualizar.';
      }
    });
  }

  addReturnsByOrder(): void {
    const orderId = this.returnOrderId.trim();
    if (!orderId) return;
    this.addingReturn = true;
    this.fetchResult = null;
    this.sync.addReturnsFromOrder(orderId).subscribe({
      next: (r) => {
        this.returnOrderId = '';
        this.addingReturn = false;
        this.returnsCurrentPage.set(1);
        this.queryClient.invalidateQueries({ queryKey: SYNC_RETURNS_QUERY_KEY });
        this.fetchResult = r.created > 0 ? `Se agregaron ${r.created} ítems de la orden.` : null;
      },
      error: (e) => {
        this.fetchResult = e.error?.error || e.message || 'Error al agregar devoluciones.';
        this.addingReturn = false;
      }
    });
  }

  registerWebhooks(): void {
    this.webhooksResult = null;
    this.registeringWebhooks = true;
    this.sync.registerWebhooks().subscribe({
      next: (r) => {
        this.registeringWebhooks = false;
        this.webhooksResult = r.registered > 0
          ? `Webhooks registrados: ${r.registered}.`
          : 'Ya estaban registrados con la URL actual.';
      },
      error: (e) => {
        this.webhooksResult = e.error?.error || e.message || 'Error al registrar webhooks.';
        this.registeringWebhooks = false;
      }
    });
  }

  approveReturn(row: PendingReturnRow): void {
    this.approvingId = row.id;
    this.sync.approveReturn(row.id).subscribe({
      next: () => {
        this.approvingId = null;
        this.queryClient.invalidateQueries({ queryKey: SYNC_RETURNS_QUERY_KEY });
        this.loadAudit();
      },
      error: (e) => {
        this.fetchResult = e.error?.error || e.message || 'Error al restaurar stock.';
        this.approvingId = null;
      }
    });
  }

  get pendingTasks(): PendingMlTask[] {
    return this.pendingTasksQuery.data()?.tasks ?? [];
  }

  get pendingTasksLoading(): boolean {
    return this.pendingTasksQuery.isLoading();
  }

  get pendingTasksFetching(): boolean {
    return this.pendingTasksQuery.isFetching();
  }

  get pendingTasksQueryError(): string | null {
    if (!this.pendingTasksQuery.isError() || !this.pendingTasksQuery.error()) return null;
    const err = this.pendingTasksQuery.error() as { error?: { error?: string }; message?: string };
    return err?.error?.error ?? err?.message ?? 'Error al cargar tareas.';
  }

  get activeTasksCount(): number {
    return this.pendingTasksQuery.data()?.activeCount ?? 0;
  }

  get failedTasksCount(): number {
    return this.pendingTasksQuery.data()?.failedCount ?? 0;
  }

  refreshPendingTasks(): void {
    this.pendingTasksError = null;
    this.queryClient.invalidateQueries({ queryKey: SYNC_PENDING_TASKS_QUERY_KEY });
  }

  retryTask(task: PendingMlTask): void {
    if (task.status !== 'failed') return;
    this.pendingTasksError = null;
    this.retryingTaskId = task.id;
    this.sync.retryTask(task.id).subscribe({
      next: () => {
        this.retryingTaskId = null;
        this.queryClient.invalidateQueries({ queryKey: SYNC_PENDING_TASKS_QUERY_KEY });
      },
      error: (e) => {
        this.retryingTaskId = null;
        this.pendingTasksError = e.error?.error || e.message || 'No se pudo reintentar la tarea.';
      }
    });
  }

  taskKindLabel(kind: PendingMlTask['kind']): string {
    switch (kind) {
      case 'stock_ml': return 'Stock ML';
      case 'sku_ml': return 'SKU ML';
      case 'sku_tn': return 'SKU TN';
      case 'price_ml': return 'Precio ML';
      default: return kind;
    }
  }

  taskStatusLabel(status: PendingMlTask['status']): string {
    switch (status) {
      case 'pending': return 'Pendiente';
      case 'processing': return 'En proceso';
      case 'failed': return 'Falló';
      default: return status;
    }
  }

  taskStatusChipClass(status: PendingMlTask['status']): string {
    switch (status) {
      case 'pending': return 'task-chip pending';
      case 'processing': return 'task-chip processing';
      case 'failed': return 'task-chip failed';
      default: return 'task-chip';
    }
  }

  taskChangeLabel(task: PendingMlTask): string {
    if (task.kind === 'stock_ml') {
      if (task.targetQty == null) return '—';
      const sign = task.targetQty > 0 ? '+' : '';
      return `${sign}${task.targetQty} u.`;
    }
    if (task.kind === 'price_ml') {
      return task.targetPrice != null ? `$${task.targetPrice.toLocaleString('es-AR')}` : '—';
    }
    return task.targetSku ? `SKU → ${task.targetSku}` : '—';
  }
}
