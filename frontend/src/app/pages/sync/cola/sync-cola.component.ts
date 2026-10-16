import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { PendingMlTask, SyncService } from '../../../core/services/sync.service';
import { SessionService } from '../../../core/services/session.service';
import { PaginationComponent } from '../../../shared/components/pagination/pagination.component';
import { SyncStore } from '../sync.store';
import { errorMessage, formatDate } from '../sync.utils';

/** Pestaña Cola ML: las escrituras a ML encoladas (`ml_pending_tasks`) hasta que terminan, con reintento a mano. */
@Component({
  selector: 'zc-sync-cola',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tab-panel' },
  imports: [PaginationComponent],
  templateUrl: './sync-cola.component.html',
  styleUrl: './sync-cola.component.scss'
})
export class SyncColaComponent {
  readonly session = inject(SessionService);
  readonly store = inject(SyncStore);
  private readonly sync = inject(SyncService);

  readonly retryingTaskId = signal<number | null>(null);
  readonly pendingTasksError = signal<string | null>(null);

  readonly formatDate = formatDate;

  readonly pendingTasks = computed<PendingMlTask[]>(() => this.store.pendingTasksQuery.data()?.tasks ?? []);
  readonly pendingTasksLoading = computed(() => this.store.pendingTasksQuery.isLoading());
  readonly pendingTasksFetching = computed(() => this.store.pendingTasksQuery.isFetching());
  readonly pendingTasksQueryError = computed<string | null>(() => {
    const q = this.store.pendingTasksQuery;
    if (!q.isError() || !q.error()) return null;
    return errorMessage(q.error(), 'Error al cargar tareas.');
  });

  refreshPendingTasks(): void {
    this.pendingTasksError.set(null);
    this.store.invalidateTasks();
  }

  /** Se puede reintentar a mano: falló, o quedó trabada con el lock vencido. */
  canRetryTask(task: PendingMlTask): boolean {
    return task.status === 'failed' || task.stuck === true;
  }

  retryTask(task: PendingMlTask): void {
    if (!this.canRetryTask(task)) return;
    this.pendingTasksError.set(null);
    this.retryingTaskId.set(task.id);
    this.sync.retryTask(task.id).subscribe({
      next: () => {
        this.retryingTaskId.set(null);
        this.store.invalidateTasks();
      },
      error: (e) => {
        this.retryingTaskId.set(null);
        this.pendingTasksError.set(errorMessage(e, 'No se pudo reintentar la tarea.'));
      }
    });
  }

  taskKindLabel(kind: PendingMlTask['kind']): string {
    switch (kind) {
      case 'stock_ml': return 'Stock ML';
      case 'stock_ml_set': return 'Stock ML';
      case 'sku_ml': return 'SKU ML';
      case 'sku_tn': return 'SKU TN';
      case 'price_ml': return 'Precio ML';
      case 'stock_probe': return 'Releer stock';
      default: return kind;
    }
  }

  taskStatusLabel(task: PendingMlTask): string {
    if (task.stuck) return 'Trabada';
    switch (task.status) {
      case 'pending': return 'Pendiente';
      case 'processing': return 'En proceso';
      case 'failed': return 'Falló';
      default: return task.status;
    }
  }

  taskStatusChipClass(task: PendingMlTask): string {
    if (task.stuck) return 'task-chip failed';
    switch (task.status) {
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
    // stock_ml_set fija el stock a un valor absoluto (no es un delta como stock_ml).
    if (task.kind === 'stock_ml_set') {
      return task.targetQty != null ? `→ ${task.targetQty} u.` : '—';
    }
    if (task.kind === 'price_ml') {
      return task.targetPrice != null ? `$${task.targetPrice.toLocaleString('es-AR')}` : '—';
    }
    // stock_probe no cambia nada: solo lee para completar el historial.
    if (task.kind === 'stock_probe') return 'Solo lectura';
    return task.targetSku ? `SKU → ${task.targetSku}` : '—';
  }
}
