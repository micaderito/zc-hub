import { ComponentFixture, TestBed, fakeAsync, tick, flush } from '@angular/core/testing';
import { QueryClient } from '@tanstack/angular-query-experimental';
import { By } from '@angular/platform-browser';
import { of, throwError } from 'rxjs';
import { SyncComponent } from './sync.component';
import { SyncService } from '../../core/services/sync.service';
import { SyncHistorialComponent } from './historial/sync-historial.component';
import { SyncDevolucionesComponent } from './devoluciones/sync-devoluciones.component';
import { SyncColaComponent } from './cola/sync-cola.component';
import {
  auditRow, configConDb, configSinDb, createSyncServiceSpy, failedTask, flushQuery, returnRow, syncTestProviders
} from './sync.testing';

describe('SyncComponent', () => {
  let fixture: ComponentFixture<SyncComponent>;
  let component: SyncComponent;
  let syncServiceSpy: jasmine.SpyObj<SyncService>;
  let queryClient: QueryClient;

  beforeEach(() => {
    syncServiceSpy = createSyncServiceSpy();
    TestBed.configureTestingModule({
      imports: [SyncComponent],
      providers: syncTestProviders(syncServiceSpy)
    });

    fixture = TestBed.createComponent(SyncComponent);
    component = fixture.componentInstance;
    queryClient = TestBed.inject(QueryClient);
  });

  afterEach(() => {
    fixture.destroy();
  });

  describe('ngOnInit y carga de configuración', () => {
    it('carga la configuración exitosamente y queda sin base de datos', () => {
      syncServiceSpy.getConfig.and.returnValue(of(configSinDb));
      fixture.detectChanges();

      expect(component.loading()).toBeFalse();
      expect(component.config()).toEqual(configSinDb);
      expect(component.store.hasDatabase()).toBeFalse();
      expect(component.error()).toBeNull();
    });

    it('carga el historial al iniciar', () => {
      syncServiceSpy.getAudit.and.returnValue(of({ rows: [auditRow], total: 1 }));
      fixture.detectChanges();

      expect(syncServiceSpy.getAudit).toHaveBeenCalledWith(25, 0, undefined, '');
      expect(component.store.auditRows()).toEqual([auditRow]);
    });

    it('con base de datos habilita las queries pero NO crawlea devoluciones al iniciar (tab por defecto: historial)', fakeAsync(() => {
      // Antes el crawl a ML se disparaba en cada montaje sin importar la tab, alimentando la
      // tormenta de 429. Ahora la tab por defecto es Historial y el crawl no debe correr.
      syncServiceSpy.getConfig.and.returnValue(of(configConDb));

      fixture.detectChanges();
      expect(component.store.hasDatabase()).toBeTrue();

      tick();
      fixture.detectChanges();

      expect(syncServiceSpy.fetchReturnsFromMl).not.toHaveBeenCalled();

      // returnsQuery/pendingTasksQuery (habilitadas por hasDatabase) dejan timers de
      // refetchInterval/gcTime pendientes; se limpian igual que en el resto del spec.
      fixture.destroy();
      queryClient.clear();
      flush();
    }));

    it('maneja el error de getConfig usando el mensaje del backend', () => {
      syncServiceSpy.getConfig.and.returnValue(throwError(() => ({ error: { error: 'Config inválida' } })));
      fixture.detectChanges();

      expect(component.loading()).toBeFalse();
      expect(component.error()).toBe('Config inválida');
    });

    it('maneja el error de getConfig usando e.message cuando no hay error.error', () => {
      syncServiceSpy.getConfig.and.returnValue(throwError(() => ({ message: 'Network fail' })));
      fixture.detectChanges();

      expect(component.error()).toBe('Network fail');
    });

    it('usa el mensaje por defecto si el error no trae info', () => {
      syncServiceSpy.getConfig.and.returnValue(throwError(() => ({})));
      fixture.detectChanges();

      expect(component.error()).toBe('Error al cargar.');
    });
  });

  describe('pestañas', () => {
    it('monta solo el componente de la pestaña activa', async () => {
      syncServiceSpy.getConfig.and.returnValue(of(configConDb));
      fixture.detectChanges();
      await flushQuery();
      fixture.detectChanges();

      expect(fixture.debugElement.query(By.directive(SyncHistorialComponent))).not.toBeNull();
      expect(fixture.debugElement.query(By.directive(SyncColaComponent))).toBeNull();

      component.onTabChange('cola');
      fixture.detectChanges();
      expect(fixture.debugElement.query(By.directive(SyncHistorialComponent))).toBeNull();
      expect(fixture.debugElement.query(By.directive(SyncColaComponent))).not.toBeNull();
    });

    it('sin base de datos no monta las pestañas (muestra el aviso)', () => {
      syncServiceSpy.getConfig.and.returnValue(of(configSinDb));
      fixture.detectChanges();

      expect(fixture.debugElement.query(By.directive(SyncHistorialComponent))).toBeNull();
      expect(fixture.nativeElement.textContent).toContain('El historial se guarda cuando hay una base de datos configurada.');
    });

    it('abrir Devoluciones dispara el crawl a ML; abrir otras tabs no', async () => {
      syncServiceSpy.getConfig.and.returnValue(of(configConDb));
      fixture.detectChanges();
      await flushQuery();
      syncServiceSpy.fetchReturnsFromMl.calls.reset();

      // Abrir Cola ML no debe gatillar un crawl de reclamos.
      component.onTabChange('cola');
      fixture.detectChanges();
      await flushQuery();
      expect(syncServiceSpy.fetchReturnsFromMl).not.toHaveBeenCalled();

      // Abrir Devoluciones sí (mutate corre async → esperamos).
      component.onTabChange('devoluciones');
      fixture.detectChanges();
      await flushQuery();
      expect(fixture.debugElement.query(By.directive(SyncDevolucionesComponent))).not.toBeNull();
      expect(syncServiceSpy.fetchReturnsFromMl).toHaveBeenCalledTimes(1);

      // Reentrar a la misma tab (sin haber salido) no re-dispara.
      component.onTabChange('devoluciones');
      fixture.detectChanges();
      await flushQuery();
      expect(syncServiceSpy.fetchReturnsFromMl).toHaveBeenCalledTimes(1);
    });

    it('abrir Devoluciones sin base de datos no crawlea', async () => {
      syncServiceSpy.getConfig.and.returnValue(of(configSinDb));
      fixture.detectChanges();
      await flushQuery();
      syncServiceSpy.fetchReturnsFromMl.calls.reset();

      component.onTabChange('devoluciones');
      fixture.detectChanges();
      await flushQuery();

      expect(syncServiceSpy.fetchReturnsFromMl).not.toHaveBeenCalled();
    });
  });

  describe('toggleSync', () => {
    it('no hace nada si no hay base de datos configurada', () => {
      syncServiceSpy.getConfig.and.returnValue(of(configSinDb));
      fixture.detectChanges();

      component.toggleSync(true);

      expect(syncServiceSpy.setSyncEnabled).not.toHaveBeenCalled();
    });

    it('activa/desactiva la sync exitosamente y actualiza config.enabled', () => {
      syncServiceSpy.getConfig.and.returnValue(of(configConDb));
      syncServiceSpy.setSyncEnabled.and.returnValue(of({ enabled: false }));
      fixture.detectChanges();

      component.toggleSync(false);

      expect(syncServiceSpy.setSyncEnabled).toHaveBeenCalledWith(false);
      expect(component.config()?.enabled).toBeFalse();
      expect(component.savingToggle()).toBeFalse();
    });

    it('maneja el error al actualizar la sync', () => {
      syncServiceSpy.getConfig.and.returnValue(of(configConDb));
      syncServiceSpy.setSyncEnabled.and.returnValue(throwError(() => ({ error: { error: 'No se pudo' } })));
      fixture.detectChanges();

      component.toggleSync(true);

      expect(component.error()).toBe('No se pudo');
      expect(component.savingToggle()).toBeFalse();
    });
  });

  describe('registerWebhooks', () => {
    it('informa cuántos webhooks se registraron', () => {
      syncServiceSpy.registerWebhooks.and.returnValue(of({ ok: true, registered: 3, created: [] }));
      fixture.detectChanges();

      component.registerWebhooks();

      expect(component.webhooksResult()).toBe('Webhooks registrados: 3.');
      expect(component.registeringWebhooks()).toBeFalse();
    });

    it('informa que ya estaban registrados si registered es 0', () => {
      syncServiceSpy.registerWebhooks.and.returnValue(of({ ok: true, registered: 0, created: [] }));
      fixture.detectChanges();

      component.registerWebhooks();

      expect(component.webhooksResult()).toBe('Ya estaban registrados con la URL actual.');
    });

    it('maneja el error al registrar webhooks', () => {
      syncServiceSpy.registerWebhooks.and.returnValue(throwError(() => ({ error: { error: 'Error webhooks' } })));
      fixture.detectChanges();

      component.registerWebhooks();

      expect(component.webhooksResult()).toBe('Error webhooks');
      expect(component.registeringWebhooks()).toBeFalse();
    });
  });

  describe('tabs() (badges de conteo)', () => {
    it('sin devoluciones ni tareas, no muestra badges de conteo', () => {
      fixture.detectChanges();
      const tabs = component.tabs();

      expect(tabs.map(t => t.key)).toEqual(['historial', 'devoluciones', 'cola', 'estado']);
      expect(tabs.find(t => t.key === 'devoluciones')?.count).toBeUndefined();
      expect(tabs.find(t => t.key === 'cola')?.count).toBeUndefined();
    });

    it('muestra el badge de devoluciones en rojo cuando hay pendientes', async () => {
      syncServiceSpy.getConfig.and.returnValue(of(configConDb));
      syncServiceSpy.getReturns.and.returnValue(of({ rows: [returnRow], total: 4 }));
      fixture.detectChanges();
      await flushQuery();
      fixture.detectChanges();

      const devolucionesTab = component.tabs().find(t => t.key === 'devoluciones');
      expect(devolucionesTab?.count).toBe(4);
      expect(devolucionesTab?.countVariant).toBe('err');
    });

    it('muestra el badge de la cola en warn cuando solo hay tareas activas', async () => {
      syncServiceSpy.getConfig.and.returnValue(of(configConDb));
      syncServiceSpy.getPendingTasks.and.returnValue(of({ tasks: [], total: 2, activeCount: 2, failedCount: 0 }));
      fixture.detectChanges();
      await flushQuery();
      fixture.detectChanges();

      const colaTab = component.tabs().find(t => t.key === 'cola');
      expect(colaTab?.count).toBe(2);
      expect(colaTab?.countVariant).toBe('warn');
    });

    it('muestra el badge de la cola en err cuando hay tareas fallidas', async () => {
      syncServiceSpy.getConfig.and.returnValue(of(configConDb));
      syncServiceSpy.getPendingTasks.and.returnValue(of({ tasks: [failedTask], total: 2, activeCount: 1, failedCount: 1 }));
      fixture.detectChanges();
      await flushQuery();
      fixture.detectChanges();

      const colaTab = component.tabs().find(t => t.key === 'cola');
      expect(colaTab?.count).toBe(2);
      expect(colaTab?.countVariant).toBe('err');
    });
  });
});
