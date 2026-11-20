import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { PendingMlTask, SyncService } from '../../../core/services/sync.service';
import { SessionService } from '../../../core/services/session.service';
import { PaginationComponent } from '../../../shared/components/pagination/pagination.component';
import { SyncStore } from '../sync.store';
import { canRetryTask, errorMessage, formatDate, taskChangeLabel, taskKindLabel, taskStatusLabel } from '../sync.utils';

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

  readonly canRetryTask = canRetryTask;
  readonly taskKindLabel = taskKindLabel;
  readonly taskStatusLabel = taskStatusLabel;
  readonly taskChangeLabel = taskChangeLabel;

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

  taskStatusChipClass(task: PendingMlTask): string {
    if (task.stuck) return 'task-chip failed';
    switch (task.status) {
      case 'pending': return 'task-chip pending';
      case 'processing': return 'task-chip processing';
      case 'failed': return 'task-chip failed';
      default: return 'task-chip';
    }
  }
}
