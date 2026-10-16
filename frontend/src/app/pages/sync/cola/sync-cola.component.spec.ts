import { ComponentFixture, TestBed } from '@angular/core/testing';
import { QueryClient } from '@tanstack/angular-query-experimental';
import { of, throwError } from 'rxjs';
import { SyncColaComponent } from './sync-cola.component';
import { SyncStore } from '../sync.store';
import { SyncService, PendingMlTask } from '../../../core/services/sync.service';
import { createSyncServiceSpy, failedTask, flushQuery, syncTestProviders } from '../sync.testing';

describe('SyncColaComponent', () => {
  let fixture: ComponentFixture<SyncColaComponent>;
  let component: SyncColaComponent;
  let store: SyncStore;
  let syncServiceSpy: jasmine.SpyObj<SyncService>;
  let queryClient: QueryClient;

  beforeEach(() => {
    syncServiceSpy = createSyncServiceSpy();
    TestBed.configureTestingModule({
      imports: [SyncColaComponent],
      providers: [...syncTestProviders(syncServiceSpy), SyncStore]
    });

    store = TestBed.inject(SyncStore);
    queryClient = TestBed.inject(QueryClient);
  });

  afterEach(() => {
    fixture?.destroy();
  });

  async function mount(hasDatabase = true): Promise<void> {
    store.hasDatabase.set(hasDatabase);
    fixture = TestBed.createComponent(SyncColaComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await flushQuery();
    fixture.detectChanges();
  }

  describe('tareas pendientes de ML', () => {
    it('pendingTasksQuery no se dispara sin base de datos', async () => {
      await mount(false);

      expect(syncServiceSpy.getPendingTasks).not.toHaveBeenCalled();
      expect(component.pendingTasks()).toEqual([]);
    });

    it('carga y pinta las tareas pendientes cuando hay base de datos', async () => {
      syncServiceSpy.getPendingTasks.and.returnValue(of({ tasks: [failedTask], total: 1, activeCount: 0, failedCount: 1 }));
      await mount();

      expect(syncServiceSpy.getPendingTasks).toHaveBeenCalledWith(20, 0);
      expect(component.pendingTasks()).toEqual([failedTask]);
      expect(component.pendingTasksLoading()).toBeFalse();
      expect(store.activeTasksCount()).toBe(0);
      expect(store.failedTasksCount()).toBe(1);
      expect(component.pendingTasksQueryError()).toBeNull();
      expect(fixture.nativeElement.textContent).toContain('MLA456');
    });

    it('expone el error de pendingTasksQuery formateado', async () => {
      syncServiceSpy.getPendingTasks.and.returnValue(throwError(() => ({ error: { error: 'Error tareas' } })));
      await mount();

      expect(component.pendingTasksQueryError()).toBe('Error tareas');
    });

    it('goToTasksPage() respeta los límites de página', async () => {
      syncServiceSpy.getPendingTasks.and.returnValue(of({ tasks: [failedTask], total: 50, activeCount: 0, failedCount: 1 }));
      await mount();

      expect(store.tasksTotalPages()).toBe(3);

      store.goToTasksPage(2);
      expect(store.tasksCurrentPage()).toBe(2);

      store.goToTasksPage(0);
      store.goToTasksPage(99);
      expect(store.tasksCurrentPage()).toBe(2);
    });

    it('refreshPendingTasks() limpia el error e invalida la query', async () => {
      await mount();
      spyOn(queryClient, 'invalidateQueries').and.callThrough();
      component.pendingTasksError.set('algo');

      component.refreshPendingTasks();

      expect(component.pendingTasksError()).toBeNull();
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['sync', 'pendingTasks'] });
    });

    describe('retryTask', () => {
      it('no reintenta tareas que no están fallidas ni trabadas', async () => {
        await mount();
        component.retryTask({ ...failedTask, status: 'pending' });

        expect(syncServiceSpy.retryTask).not.toHaveBeenCalled();
      });

      it('no reintenta una tarea "processing" con el lock vivo (está corriendo de verdad)', async () => {
        await mount();
        component.retryTask({ ...failedTask, status: 'processing', stuck: false });

        expect(syncServiceSpy.retryTask).not.toHaveBeenCalled();
      });

      // Una tarea trabada quedó en 'processing' porque el worker murió a mitad de camino (deploy):
      // el worker la recupera solo al vencer el lock, pero el botón evita esperar.
      it('reintenta una tarea trabada aunque siga en estado "processing"', async () => {
        await mount();
        component.retryTask({ ...failedTask, status: 'processing', stuck: true });

        expect(syncServiceSpy.retryTask).toHaveBeenCalledWith(failedTask.id);
      });

      it('reintenta una tarea fallida exitosamente e invalida la query', async () => {
        await mount();
        spyOn(queryClient, 'invalidateQueries').and.callThrough();

        component.retryTask(failedTask);

        expect(syncServiceSpy.retryTask).toHaveBeenCalledWith(failedTask.id);
        expect(component.retryingTaskId()).toBeNull();
        expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['sync', 'pendingTasks'] });
      });

      it('maneja el error al reintentar una tarea', async () => {
        syncServiceSpy.retryTask.and.returnValue(throwError(() => ({ error: { error: 'No se pudo reintentar' } })));
        await mount();

        component.retryTask(failedTask);

        expect(component.pendingTasksError()).toBe('No se pudo reintentar');
        expect(component.retryingTaskId()).toBeNull();
      });
    });
  });

  describe('helpers de formato', () => {
    beforeEach(() => {
      fixture = TestBed.createComponent(SyncColaComponent);
      component = fixture.componentInstance;
    });

    it('taskKindLabel() traduce todos los tipos de tarea', () => {
      expect(component.taskKindLabel('stock_ml')).toBe('Stock ML');
      expect(component.taskKindLabel('stock_ml_set')).toBe('Stock ML');
      expect(component.taskKindLabel('sku_ml')).toBe('SKU ML');
      expect(component.taskKindLabel('sku_tn')).toBe('SKU TN');
      expect(component.taskKindLabel('price_ml')).toBe('Precio ML');
    });

    it('taskStatusLabel() y taskStatusChipClass() traducen todos los estados', () => {
      expect(component.taskStatusLabel({ ...failedTask, status: 'pending' })).toBe('Pendiente');
      expect(component.taskStatusLabel({ ...failedTask, status: 'processing' })).toBe('En proceso');
      expect(component.taskStatusLabel({ ...failedTask, status: 'failed' })).toBe('Falló');

      expect(component.taskStatusChipClass({ ...failedTask, status: 'pending' })).toBe('task-chip pending');
      expect(component.taskStatusChipClass({ ...failedTask, status: 'processing' })).toBe('task-chip processing');
      expect(component.taskStatusChipClass({ ...failedTask, status: 'failed' })).toBe('task-chip failed');
    });

    it('una tarea trabada se muestra como "Trabada" y no como "En proceso"', () => {
      const stuck: PendingMlTask = { ...failedTask, status: 'processing', stuck: true };

      expect(component.taskStatusLabel(stuck)).toBe('Trabada');
      expect(component.taskStatusChipClass(stuck)).toBe('task-chip failed');
    });

    it('taskChangeLabel() arma la etiqueta según el tipo de tarea', () => {
      expect(component.taskChangeLabel({ ...failedTask, kind: 'stock_ml', targetQty: null })).toBe('—');
      expect(component.taskChangeLabel({ ...failedTask, kind: 'stock_ml', targetQty: 5 })).toBe('+5 u.');
      expect(component.taskChangeLabel({ ...failedTask, kind: 'stock_ml', targetQty: -5 })).toBe('-5 u.');
      expect(component.taskChangeLabel({ ...failedTask, kind: 'price_ml', targetPrice: null })).toBe('—');
      expect(component.taskChangeLabel({ ...failedTask, kind: 'price_ml', targetPrice: 1500 })).toBe(`$${(1500).toLocaleString('es-AR')}`);
      expect(component.taskChangeLabel({ ...failedTask, kind: 'sku_ml', targetSku: null })).toBe('—');
      expect(component.taskChangeLabel({ ...failedTask, kind: 'sku_ml', targetSku: 'SKU-9' })).toBe('SKU → SKU-9');
    });
  });
});
