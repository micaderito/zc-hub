import { ChangeDetectionStrategy, Component, OnInit, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { injectMutation } from '@tanstack/angular-query-experimental';
import { AuditSource, PendingMlTask, PendingReturnRow, SyncAuditRow, SyncService } from '../../../core/services/sync.service';
import { SessionService } from '../../../core/services/session.service';
import { BottomSheetComponent } from '../../../shared/components/bottom-sheet/bottom-sheet.component';
import { PaginationComponent } from '../../../shared/components/pagination/pagination.component';
import { SearchBarComponent } from '../../../shared/components/search-bar/search-bar.component';
import { CanWriteDirective } from '../../../shared/directives/can-write.directive';
import { ProductHistoryDialogComponent } from '../../precio-stock/components/product-history-dialog/product-history-dialog.component';
import { SyncStore } from '../sync.store';
import {
  auditSourceLabel, canRetryTask, canRevertAudit, channelLabel, errorMessage, formatDate, returnsFetchMessage,
  revertTitle, taskChangeLabel, taskKindLabel, taskStatusLabel,
} from '../sync.utils';

/** Qué muestra la pantalla: todo (null) o solo lo de un número de arriba. */
export type SyncFocus = 'returns' | 'errors' | 'queue';

/** Cuántas devoluciones se ven en la pantalla principal antes de "Ver las N". */
const RETURNS_PREVIEW = 2;

export const AUDIT_SOURCE_OPTIONS: { key: AuditSource | ''; label: string }[] = [
  { key: '', label: 'Todos' },
  { key: 'venta', label: 'Ventas' },
  { key: 'manual', label: 'Manuales' },
  { key: 'devolucion', label: 'Devoluciones' },
  { key: 'externo', label: 'Externos' },
];

/** Fecha local `YYYY-MM-DD` (para agrupar el historial por día). */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** "Hoy", "Ayer" o "mié 12/11". */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (dayKey(d) === dayKey(now)) return 'Hoy';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(d) === dayKey(yesterday)) return 'Ayer';
  const weekday = d.toLocaleDateString('es-AR', { weekday: 'short' }).replace('.', '');
  return `${weekday} ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Agrupa filas ya ordenadas (la más nueva primero) por día, sin reordenar. */
export function groupByDay(rows: SyncAuditRow[], now = new Date()): { label: string; rows: SyncAuditRow[] }[] {
  const groups: { label: string; rows: SyncAuditRow[] }[] = [];
  for (const row of rows) {
    const label = dayLabel(row.createdAt, now);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.rows.push(row);
    else groups.push({ label, rows: [row] });
  }
  return groups;
}

/**
 * "Historial y cola" en el celular (opción B de docs/prototype/sync-mobile.html): sin pestañas.
 * Arriba tres números que se tocan para quedarse solo con eso (Devoluciones · Con error · En cola);
 * abajo, lo que espera algo (devoluciones con sus botones, tareas de la Cola ML falladas o trabadas
 * con Reintentar) y después el historial, compacto y por día. Tocar un movimiento o una tarea abre
 * su hoja. Usa el mismo SyncStore que las pestañas de escritorio; SyncComponent decide cuál se ve.
 */
@Component({
  selector: 'zc-sync-phone',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, BottomSheetComponent, PaginationComponent, SearchBarComponent, CanWriteDirective, ProductHistoryDialogComponent],
  templateUrl: './sync-phone.component.html',
  styleUrl: './sync-phone.component.scss',
})
export class SyncPhoneComponent implements OnInit {
  readonly store = inject(SyncStore);
  readonly session = inject(SessionService);
  private readonly sync = inject(SyncService);

  /** Con qué arranca filtrada (el acceso directo "Devoluciones" del menú). */
  readonly initialFocus = input<SyncFocus | null>(null);

  readonly sourceOptions = AUDIT_SOURCE_OPTIONS;
  readonly focus = signal<SyncFocus | null>(null);
  /** Mensaje de la última acción (revisar reclamos, aprobar, reintentar…). */
  readonly notice = signal<string | null>(null);

  readonly formatDate = formatDate;
  readonly auditSourceLabel = auditSourceLabel;
  readonly taskKindLabel = taskKindLabel;
  readonly taskStatusLabel = taskStatusLabel;
  readonly taskChangeLabel = taskChangeLabel;
  readonly canRetryTask = canRetryTask;
  readonly channelLabel = channelLabel;
  readonly revertTitle = revertTitle;

  // ── Devoluciones ──
  readonly returnsRows = computed<PendingReturnRow[]>(() => this.store.returnsQuery.data()?.rows ?? []);
  readonly returnsLoading = computed(() => this.store.returnsQuery.isLoading());
  readonly returnsPreview = computed(() => this.returnsRows().slice(0, RETURNS_PREVIEW));
  readonly approvingId = signal<number | null>(null);
  readonly dismissingId = signal<number | null>(null);

  readonly fetchReturnsMutation = injectMutation(() => ({
    mutationKey: ['sync', 'fetchReturns'],
    mutationFn: () => firstValueFrom(this.sync.fetchReturnsFromMl()),
    onSuccess: () => this.store.invalidateReturns(),
  }));

  // ── Cola ML ──
  readonly tasks = computed<PendingMlTask[]>(() => this.store.pendingTasksQuery.data()?.tasks ?? []);
  readonly problemTasks = computed(() => this.tasks().filter(canRetryTask));
  /** Trabadas: el backend las cuenta como activas ('processing'), acá van con los errores. */
  private readonly stuckCount = computed(() => this.tasks().filter((t) => t.stuck).length);
  readonly errorCount = computed(() => this.store.failedTasksCount() + this.stuckCount());
  readonly queueCount = computed(() => Math.max(0, this.store.activeTasksCount() - this.stuckCount()));
  readonly retryingTaskId = signal<number | null>(null);

  readonly nothingPending = computed(() =>
    !this.returnsLoading() && this.store.returnsTotal() === 0 && this.errorCount() === 0);

  // ── Historial ──
  readonly auditGroups = computed(() => groupByDay(this.store.auditRows()));

  // ── Hojas ──
  readonly openAudit = signal<SyncAuditRow | null>(null);
  readonly openTask = signal<PendingMlTask | null>(null);
  readonly reverting = signal(false);
  readonly sheetError = signal<string | null>(null);
  /** SKU cuyo historial completo (el modal de Precio y stock) está abierto. */
  readonly historySku = signal<string | null>(null);

  /** Hoja con un nro de venta: reintentar la sincronización o agregarla a devoluciones. */
  readonly orderSheet = signal<'reprocess' | 'return' | null>(null);
  readonly orderId = signal('');
  readonly orderBusy = signal(false);
  /** La venta ya estaba descontada: se pide confirmar antes de descontarla de nuevo. */
  readonly confirmReprocess = signal(false);

  /**
   * En el celu las devoluciones están en la pantalla principal, así que se revisan los reclamos de
   * ML al abrirla (en escritorio, al abrir la pestaña). El backend se protege solo: caché de 2 min,
   * circuit breaker y cooldown tras un fallo — ver /returns/fetch.
   */
  constructor() {
    effect(() => this.focus.set(this.initialFocus()), { allowSignalWrites: true });
  }

  ngOnInit(): void {
    this.fetchReturnsMutation.mutate(undefined, {
      onSettled: (r) => {
        if (r && (r.created > 0 || r.skipped > 0)) this.notice.set(returnsFetchMessage(r));
      },
    });
  }

  toggleFocus(f: SyncFocus): void {
    this.focus.update((cur) => (cur === f ? null : f));
  }

  refresh(): void {
    this.notice.set(null);
    this.store.invalidateTasks();
    this.store.loadAudit();
    this.store.returnsCurrentPage.set(1);
    this.fetchReturnsMutation.mutate(undefined, {
      onSuccess: (r) => this.notice.set(returnsFetchMessage(r)),
      onError: (e) => this.notice.set(errorMessage(e, 'Error al actualizar.')),
    });
  }

  // ── Devoluciones ──

  approveReturn(row: PendingReturnRow): void {
    this.approvingId.set(row.id);
    this.sync.approveReturn(row.id).subscribe({
      next: () => {
        this.approvingId.set(null);
        this.notice.set(`Stock restaurado: ${row.productLabel || row.sku || 'devolución'} (+${row.quantity}).`);
        this.store.invalidateReturns();
        this.store.loadAudit();
      },
      error: (e) => {
        this.approvingId.set(null);
        this.notice.set(errorMessage(e, 'Error al restaurar stock.'));
      },
    });
  }

  /** Descartar: la unidad no volvió ni va a volver (ej. cancelaste la venta por falta de stock). */
  dismissReturn(row: PendingReturnRow): void {
    this.dismissingId.set(row.id);
    this.sync.dismissReturn(row.id).subscribe({
      next: () => {
        this.dismissingId.set(null);
        this.store.invalidateReturns();
      },
      error: (e) => {
        this.dismissingId.set(null);
        this.notice.set(errorMessage(e, 'Error al descartar la devolución.'));
      },
    });
  }

  /** "Sin stock" casi siempre se descarta: se resalta para no restaurar de más. */
  isNoStockReason(reason: string | null): boolean {
    return !!reason && /sin stock|no tengo stock|falta de stock/i.test(reason);
  }

  // ── Cola ML ──

  retryTask(task: PendingMlTask): void {
    if (!canRetryTask(task)) return;
    this.retryingTaskId.set(task.id);
    this.sheetError.set(null);
    this.sync.retryTask(task.id).subscribe({
      next: () => {
        this.retryingTaskId.set(null);
        this.openTask.set(null);
        this.store.invalidateTasks();
      },
      error: (e) => {
        this.retryingTaskId.set(null);
        const msg = errorMessage(e, 'No se pudo reintentar la tarea.');
        if (this.openTask()) this.sheetError.set(msg);
        else this.notice.set(msg);
      },
    });
  }

  showTask(task: PendingMlTask): void {
    this.sheetError.set(null);
    this.openTask.set(task);
  }

  taskBadge(task: PendingMlTask): string {
    if (task.stuck || task.status === 'failed') return 'err';
    return task.status === 'processing' ? 'busy' : 'warn';
  }

  // ── Historial ──

  showAudit(row: SyncAuditRow): void {
    this.sheetError.set(null);
    this.openAudit.set(row);
  }

  canRevert(row: SyncAuditRow): boolean {
    return !row.revertedAt && canRevertAudit(row) && this.session.isAdmin();
  }

  revert(row: SyncAuditRow): void {
    this.reverting.set(true);
    this.sheetError.set(null);
    this.sync.revertAudit(row.id).subscribe({
      next: () => {
        this.reverting.set(false);
        this.openAudit.set(null);
        this.store.loadAudit();
      },
      error: (e) => {
        this.reverting.set(false);
        this.sheetError.set(errorMessage(e, 'No se pudo revertir.'));
      },
    });
  }

  openSkuHistory(sku: string): void {
    this.openAudit.set(null);
    this.historySku.set(sku);
  }

  /** La etiqueta de la fila: "Venta ML"/"Devolución"… si el backend la armó, si no el origen. */
  rowLabel(row: SyncAuditRow): string {
    return row.productLabel || auditSourceLabel(row.source);
  }

  rowBadge(row: SyncAuditRow): string {
    if (row.revertedAt) return 'plain';
    if (row.source === 'devolucion') return 'ok';
    if (row.source === 'externo') return 'warn';
    if (row.source === 'manual') return 'plain';
    return 'busy';
  }

  delta(row: SyncAuditRow): number {
    return row.stockAfter - row.stockBefore;
  }

  time(iso: string): string {
    return new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  // ── Hoja de nro de venta ──

  openOrderSheet(mode: 'reprocess' | 'return'): void {
    this.orderId.set('');
    this.sheetError.set(null);
    this.confirmReprocess.set(false);
    this.orderSheet.set(mode);
  }

  submitOrder(): void {
    const id = this.orderId().trim();
    if (!id || this.orderBusy()) return;
    this.sheetError.set(null);
    this.orderBusy.set(true);
    if (this.orderSheet() === 'return') {
      this.sync.addReturnsFromOrder(id).subscribe({
        next: (r) => {
          this.orderBusy.set(false);
          this.orderSheet.set(null);
          this.store.returnsCurrentPage.set(1);
          this.store.invalidateReturns();
          this.notice.set(r.created > 0 ? `Se agregaron ${r.created} ítems de la venta ${id}.` : `La venta ${id} no tenía ítems nuevos para agregar.`);
        },
        error: (e) => {
          this.orderBusy.set(false);
          this.sheetError.set(errorMessage(e, 'Error al agregar devoluciones.'));
        },
      });
      return;
    }
    if (this.confirmReprocess()) {
      this.reprocess(id);
      return;
    }
    // Igual que en escritorio: si la venta ya está en el historial, se confirma antes de descontarla otra vez.
    this.sync.getAudit(50, 0, id).subscribe({
      next: (r) => {
        if (r.rows.some((row) => !row.revertedAt && (row.orderId === id || row.packId === id))) {
          this.orderBusy.set(false);
          this.confirmReprocess.set(true);
          return;
        }
        this.reprocess(id);
      },
      error: () => this.reprocess(id),
    });
  }

  private reprocess(id: string): void {
    this.sync.reprocessOrder(id).subscribe({
      next: (r) => {
        this.orderBusy.set(false);
        this.orderSheet.set(null);
        this.notice.set(r.ok ? `Venta ${r.orderId} sincronizada: ${r.itemsSynced} ítem(s) descontados.` : null);
        if (r.ok) this.store.loadAudit();
      },
      error: (e) => {
        this.orderBusy.set(false);
        this.sheetError.set(errorMessage(e, 'Error al reintentar.'));
      },
    });
  }
}
