import { ComponentFixture, TestBed, fakeAsync, tick, flush } from '@angular/core/testing';
import { QueryClient, provideTanStackQuery } from '@tanstack/angular-query-experimental';
import { of, throwError, Subject } from 'rxjs';
import { SyncComponent } from './sync.component';
import {
  SyncService,
  SyncConfig,
  SyncAuditRow,
  SyncAuditResponse,
  PendingReturnRow,
  SyncReturnsResponse,
  PendingMlTask,
  PendingMlTasksResponse
} from '../../core/services/sync.service';

/**
 * `pendingTasksQuery` tiene un `refetchInterval` que se reprograma solo tras cada fetch
 * exitoso, así que la zona de Angular nunca queda "estable" mientras el componente esté vivo
 * (siempre hay un timer de 4s/20s pendiente). Por eso NO se puede usar `fixture.whenStable()`
 * en este spec — esperaría ese timer real y haría que Jasmine mate el test por timeout.
 * En su lugar, esperamos un macrotask propio (ajeno a la estabilidad de la zona) para darle
 * tiempo a la promesa del queryFn (mockeada con `of(...)`) a resolver y propagarse a los signals.
 */
async function flushQuery(): Promise<void> {
  // Varias vueltas de macrotask/microtask: TanStack Query notifica sus cambios de estado
  // de forma asíncrona (batching interno), así que un solo tick no alcanza siempre.
  for (let i = 0; i < 3; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
    await Promise.resolve();
  }
}

describe('SyncComponent', () => {
  let fixture: ComponentFixture<SyncComponent>;
  let component: SyncComponent;
  let syncServiceSpy: jasmine.SpyObj<SyncService>;
  let queryClient: QueryClient;

  const configConDb: SyncConfig = { enabled: true, hasDatabase: true };
  const configSinDb: SyncConfig = { enabled: false, hasDatabase: false };

  const auditVacio: SyncAuditResponse = { rows: [], total: 0 };
  const returnsVacio: SyncReturnsResponse = { rows: [], total: 0 };
  const tasksVacio: PendingMlTasksResponse = { tasks: [], total: 0, activeCount: 0, failedCount: 0 };
  const fetchVacio = { ok: true, claimsChecked: 0, created: 0, skipped: 0 };

  const auditRow: SyncAuditRow = {
    id: 1,
    channelSale: 'mercadolibre',
    orderId: 'ORD-1',
    packId: 'PACK-1',
    saleItemId: 'MLA123',
    sku: 'SKU-1',
    productLabel: 'Venta ML',
    productDisplay: 'Cuaderno A4 - Tapa dura',
    quantity: 2,
    updatedChannel: 'tiendanube',
    stockBefore: 10,
    stockAfter: 8,
    createdAt: '2026-01-01T10:00:00Z',
    revertedAt: null
  };

  const returnRow: PendingReturnRow = {
    id: 5,
    orderId: 'ORD-99',
    itemId: 'MLA456',
    variationId: null,
    sku: 'SKU-2',
    quantity: 1,
    productLabel: 'Cuaderno tapa dura',
    reason: 'Producto dañado',
    buyerNickname: 'comprador1',
    claimDate: '2026-01-02T12:00:00Z',
    status: 'pending',
    createdAt: '2026-01-02T12:00:00Z'
  };

  const failedTask: PendingMlTask = {
    id: 7,
    kind: 'stock_ml',
    itemId: 'MLA456',
    variationId: null,
    targetQty: -3,
    targetSku: null,
    targetPrice: null,
    status: 'failed',
    attempts: 2,
    lastError: 'timeout',
    createdAt: '2026-01-03T10:00:00Z',
    updatedAt: '2026-01-03T10:05:00Z',
    nextRunAt: '2026-01-03T10:10:00Z'
  };

  beforeEach(() => {
    syncServiceSpy = jasmine.createSpyObj<SyncService>('SyncService', [
      'getConfig',
      'setSyncEnabled',
      'getAudit',
      'revertAudit',
      'reprocessOrder',
      'getReturns',
      'fetchReturnsFromMl',
      'addReturnsFromOrder',
      'approveReturn',
      'getPendingTasks',
      'retryTask',
      'registerWebhooks'
    ]);

    // Valores por defecto "seguros" para que cualquier test que no los pise no rompa.
    syncServiceSpy.getConfig.and.returnValue(of(configSinDb));
    syncServiceSpy.getAudit.and.returnValue(of(auditVacio));
    syncServiceSpy.getReturns.and.returnValue(of(returnsVacio));
    syncServiceSpy.fetchReturnsFromMl.and.returnValue(of(fetchVacio));
    syncServiceSpy.getPendingTasks.and.returnValue(of(tasksVacio));
    syncServiceSpy.setSyncEnabled.and.returnValue(of({ enabled: true }));
    syncServiceSpy.revertAudit.and.returnValue(of({ ok: true }));
    syncServiceSpy.reprocessOrder.and.returnValue(of({ ok: true, orderId: 'ORD-1', itemsSynced: 1 }));
    syncServiceSpy.addReturnsFromOrder.and.returnValue(of({ created: 0, rows: [] }));
    syncServiceSpy.approveReturn.and.returnValue(of({ ok: true, mlRestored: true, tnRestored: true }));
    syncServiceSpy.retryTask.and.returnValue(of({ ok: true }));
    syncServiceSpy.registerWebhooks.and.returnValue(of({ ok: true, registered: 0, created: [] }));

    TestBed.configureTestingModule({
      imports: [SyncComponent],
      providers: [
        provideTanStackQuery(new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })),
        { provide: SyncService, useValue: syncServiceSpy }
      ]
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

      expect(component.loading).toBeFalse();
      expect(component.config).toEqual(configSinDb);
      expect(component.hasDatabaseForReturns()).toBeFalse();
      expect(component.error).toBeNull();
    });

    it('cuando hay base de datos, activa hasDatabaseForReturns y dispara la búsqueda automática de devoluciones', fakeAsync(() => {
      syncServiceSpy.getConfig.and.returnValue(of(configConDb));
      syncServiceSpy.fetchReturnsFromMl.and.returnValue(of({ ok: true, claimsChecked: 3, created: 2, skipped: 1 }));

      fixture.detectChanges();
      expect(component.hasDatabaseForReturns()).toBeTrue();

      tick();
      fixture.detectChanges();

      // Nota: no se verifica component.fetchResult acá. Con un mock 100% síncrono, mutate()
      // se ejecuta y resuelve antes de que @tanstack/angular-query-experimental llegue a
      // suscribirse al MutationObserver interno, y MutationObserver#notify() (query-core)
      // descarta el callback onSettled cuando hasListeners() da false — el estado de la
      // mutación sí queda "success" (se verifica en el siguiente test vía refreshReturns()),
      // pero el callback puntual de este mutate() no llega a correr. Con HTTP real esto no
      // ocurre nunca: la respuesta siempre llega en un macrotask posterior al montaje.
      expect(syncServiceSpy.fetchReturnsFromMl).toHaveBeenCalled();
      // returnsQuery/pendingTasksQuery (también habilitadas por hasDatabaseForReturns) dejan
      // timers de refetchInterval/gcTime pendientes. Destruir el fixture desuscribe los
      // observers, pero eso hace que sus entradas de caché programen SU PROPIO timeout de
      // recolección (gcTime) justo en ese momento — limpiar la caché del QueryClient los
      // purga sin esperar a que ese timer llegue a disparar, dejando la zona sin timers
      // pendientes antes de que fakeAsync lo exija al cerrar el test.
      fixture.destroy();
      queryClient.clear();
      flush();
    }));

    it('no arma mensaje de resultado si fetchReturnsFromMl no creó ni saltó ítems al iniciar', async () => {
      syncServiceSpy.getConfig.and.returnValue(of(configConDb));
      syncServiceSpy.fetchReturnsFromMl.and.returnValue(of({ ok: true, claimsChecked: 0, created: 0, skipped: 0 }));

      fixture.detectChanges();
      await flushQuery();
      fixture.detectChanges();

      expect(component.fetchResult).toBeNull();
    });

    it('maneja el error de getConfig usando el mensaje del backend', () => {
      syncServiceSpy.getConfig.and.returnValue(throwError(() => ({ error: { error: 'Config inválida' } })));
      fixture.detectChanges();

      expect(component.loading).toBeFalse();
      expect(component.error).toBe('Config inválida');
    });

    it('maneja el error de getConfig usando e.message cuando no hay error.error', () => {
      syncServiceSpy.getConfig.and.returnValue(throwError(() => ({ message: 'Network fail' })));
      fixture.detectChanges();

      expect(component.error).toBe('Network fail');
    });

    it('usa el mensaje por defecto si el error no trae info', () => {
      syncServiceSpy.getConfig.and.returnValue(throwError(() => ({})));
      fixture.detectChanges();

      expect(component.error).toBe('Error al cargar.');
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
      expect(component.config?.enabled).toBeFalse();
      expect(component.savingToggle).toBeFalse();
    });

    it('maneja el error al actualizar la sync', () => {
      syncServiceSpy.getConfig.and.returnValue(of(configConDb));
      syncServiceSpy.setSyncEnabled.and.returnValue(throwError(() => ({ error: { error: 'No se pudo' } })));
      fixture.detectChanges();

      component.toggleSync(true);

      expect(component.error).toBe('No se pudo');
      expect(component.savingToggle).toBeFalse();
    });
  });

  describe('historial de sincronización (auditoría)', () => {
    it('carga el historial en ngOnInit', () => {
      syncServiceSpy.getAudit.and.returnValue(of({ rows: [auditRow], total: 1 }));
      fixture.detectChanges();

      expect(syncServiceSpy.getAudit).toHaveBeenCalledWith(25, 0, undefined);
      expect(component.auditRows).toEqual([auditRow]);
      expect(component.auditTotal).toBe(1);
      expect(component.auditLoading).toBeFalse();
    });

    it('maneja el error al cargar el historial', () => {
      syncServiceSpy.getAudit.and.returnValue(throwError(() => ({ error: { error: 'Error de auditoría' } })));
      fixture.detectChanges();

      expect(component.auditError).toBe('Error de auditoría');
      expect(component.auditLoading).toBeFalse();
    });

    it('refreshAudit() vuelve a la página 1 y recarga', () => {
      syncServiceSpy.getAudit.and.returnValue(of({ rows: [auditRow], total: 100 }));
      fixture.detectChanges();
      component.goToAuditPage(3);
      syncServiceSpy.getAudit.calls.reset();

      component.refreshAudit();

      expect(component.auditCurrentPage()).toBe(1);
      expect(syncServiceSpy.getAudit).toHaveBeenCalledWith(25, 0, undefined);
    });

    it('goToAuditPage() pagina correctamente y respeta los límites', () => {
      syncServiceSpy.getAudit.and.returnValue(of({ rows: [auditRow], total: 100 }));
      fixture.detectChanges();
      expect(component.auditTotalPages()).toBe(4);
      syncServiceSpy.getAudit.calls.reset();

      component.goToAuditPage(2);
      expect(component.auditCurrentPage()).toBe(2);
      expect(syncServiceSpy.getAudit).toHaveBeenCalledWith(25, 25, undefined);

      syncServiceSpy.getAudit.calls.reset();
      component.goToAuditPage(0);
      component.goToAuditPage(10);

      expect(component.auditCurrentPage()).toBe(2);
      expect(syncServiceSpy.getAudit).not.toHaveBeenCalled();
    });

    it('busca por término luego del debounce y vuelve a la página 1', fakeAsync(() => {
      syncServiceSpy.getAudit.and.returnValue(of(auditVacio));
      fixture.detectChanges();
      component.goToAuditPage(1);
      syncServiceSpy.getAudit.calls.reset();

      component.auditSearchQuery.set('2000011838697695');
      tick(350);

      expect(syncServiceSpy.getAudit).toHaveBeenCalledWith(25, 0, '2000011838697695');
      expect(component.auditCurrentPage()).toBe(1);
    }));

    it('descarta una respuesta de auditoría obsoleta si llegó tras una carga más nueva', () => {
      const first$ = new Subject<SyncAuditResponse>();
      const second$ = new Subject<SyncAuditResponse>();
      syncServiceSpy.getAudit.and.returnValues(first$.asObservable(), second$.asObservable());
      fixture.detectChanges(); // dispara la carga inicial (usa first$)

      component.loadAudit(); // dispara una segunda carga (usa second$); auditRequestId avanza

      second$.next({ rows: [auditRow], total: 1 });
      first$.next({ rows: [], total: 0 }); // respuesta tardía de la carga vieja: se descarta

      expect(component.auditRows).toEqual([auditRow]);
      expect(component.auditTotal).toBe(1);
    });

    it('descarta un error de auditoría obsoleto si llegó tras una carga más nueva', () => {
      const first$ = new Subject<SyncAuditResponse>();
      const second$ = new Subject<SyncAuditResponse>();
      syncServiceSpy.getAudit.and.returnValues(first$.asObservable(), second$.asObservable());
      fixture.detectChanges();

      component.loadAudit();

      second$.next({ rows: [auditRow], total: 1 });
      first$.error({ error: { error: 'obsoleto' } }); // error tardío de la carga vieja: se descarta

      expect(component.auditError).toBeNull();
      expect(component.auditRows).toEqual([auditRow]);
    });

    describe('revertAudit', () => {
      it('no hace nada si la fila ya fue revertida', () => {
        fixture.detectChanges();
        component.revertAudit({ ...auditRow, revertedAt: '2026-01-05T00:00:00Z' });

        expect(syncServiceSpy.revertAudit).not.toHaveBeenCalled();
      });

      it('revierte exitosamente y recarga el historial', () => {
        syncServiceSpy.getAudit.and.returnValue(of({ rows: [auditRow], total: 1 }));
        fixture.detectChanges();
        syncServiceSpy.getAudit.calls.reset();

        component.revertAudit(auditRow);

        expect(syncServiceSpy.revertAudit).toHaveBeenCalledWith(auditRow.id);
        expect(component.revertingAuditId).toBeNull();
        expect(syncServiceSpy.getAudit).toHaveBeenCalled();
      });

      it('maneja el error al revertir', () => {
        syncServiceSpy.revertAudit.and.returnValue(throwError(() => ({ error: { error: 'No se pudo revertir esto' } })));
        fixture.detectChanges();

        component.revertAudit(auditRow);

        expect(component.revertError).toBe('No se pudo revertir esto');
        expect(component.revertingAuditId).toBeNull();
      });
    });
  });

  describe('reintentar sincronización de una venta (reprocessOrder)', () => {
    it('no hace nada si el id está vacío', () => {
      fixture.detectChanges();
      component.reprocessOrderId = '   ';

      component.reprocessOrder();

      expect(syncServiceSpy.getAudit).toHaveBeenCalledTimes(1); // solo la carga inicial de ngOnInit
    });

    it('confirmReprocess() no hace nada si no hay una confirmación pendiente', () => {
      fixture.detectChanges();
      expect(component.confirmReprocessId()).toBeNull();

      component.confirmReprocess();

      expect(syncServiceSpy.reprocessOrder).not.toHaveBeenCalled();
    });

    it('pide confirmación si la orden ya estaba sincronizada (sin revertir)', () => {
      syncServiceSpy.getAudit.and.callFake((limit: number) => {
        if (limit === 50) {
          return of({ rows: [{ ...auditRow, orderId: 'ORD-1', revertedAt: null }], total: 1 });
        }
        return of(auditVacio);
      });
      fixture.detectChanges();
      component.reprocessOrderId = 'ORD-1';

      component.reprocessOrder();

      expect(component.confirmReprocessId()).toBe('ORD-1');
      expect(component.reprocessingOrder).toBeFalse();
      expect(syncServiceSpy.reprocessOrder).not.toHaveBeenCalled();
    });

    it('confirmReprocess() somete el reproceso tras la confirmación', () => {
      syncServiceSpy.getAudit.and.callFake((limit: number) => {
        if (limit === 50) return of({ rows: [{ ...auditRow, orderId: 'ORD-1', revertedAt: null }], total: 1 });
        return of(auditVacio);
      });
      syncServiceSpy.reprocessOrder.and.returnValue(of({ ok: true, orderId: 'ORD-1', itemsSynced: 3 }));
      fixture.detectChanges();
      component.reprocessOrderId = 'ORD-1';
      component.reprocessOrder();

      component.confirmReprocess();

      expect(component.confirmReprocessId()).toBeNull();
      expect(syncServiceSpy.reprocessOrder).toHaveBeenCalledWith('ORD-1');
      expect(component.reprocessResult).toBe('Orden ORD-1 sincronizada: 3 ítem(s) descontados.');
      expect(component.reprocessOrderId).toBe('');
    });

    it('cancelReprocess() descarta la confirmación pendiente', () => {
      syncServiceSpy.getAudit.and.callFake((limit: number) => {
        if (limit === 50) return of({ rows: [{ ...auditRow, orderId: 'ORD-1', revertedAt: null }], total: 1 });
        return of(auditVacio);
      });
      fixture.detectChanges();
      component.reprocessOrderId = 'ORD-1';
      component.reprocessOrder();

      component.cancelReprocess();

      expect(component.confirmReprocessId()).toBeNull();
    });

    it('somete directamente el reproceso si la orden no estaba ya sincronizada', () => {
      syncServiceSpy.getAudit.and.callFake((limit: number) => {
        if (limit === 50) return of(auditVacio);
        return of(auditVacio);
      });
      syncServiceSpy.reprocessOrder.and.returnValue(of({ ok: true, orderId: 'ORD-2', itemsSynced: 1 }));
      fixture.detectChanges();
      component.reprocessOrderId = 'ORD-2';

      component.reprocessOrder();

      expect(syncServiceSpy.reprocessOrder).toHaveBeenCalledWith('ORD-2');
      expect(component.reprocessResult).toBe('Orden ORD-2 sincronizada: 1 ítem(s) descontados.');
    });

    it('si falla la consulta previa de auditoría, igual somete el reproceso', () => {
      syncServiceSpy.getAudit.and.callFake((limit: number) => {
        if (limit === 50) return throwError(() => ({ error: { error: 'boom' } }));
        return of(auditVacio);
      });
      syncServiceSpy.reprocessOrder.and.returnValue(of({ ok: true, orderId: 'ORD-3', itemsSynced: 1 }));
      fixture.detectChanges();
      component.reprocessOrderId = 'ORD-3';

      component.reprocessOrder();

      expect(syncServiceSpy.reprocessOrder).toHaveBeenCalledWith('ORD-3');
    });

    it('cuando el backend responde ok:false no fija reprocessResult y no limpia el input', () => {
      syncServiceSpy.getAudit.and.returnValue(of(auditVacio));
      syncServiceSpy.reprocessOrder.and.returnValue(of({ ok: false, orderId: 'ORD-4', itemsSynced: 0 }));
      fixture.detectChanges();
      component.reprocessOrderId = 'ORD-4';

      component.reprocessOrder();

      expect(component.reprocessResult).toBeNull();
      expect(component.reprocessOrderId).toBe('ORD-4');
    });

    it('maneja el error al reintentar la sincronización', () => {
      syncServiceSpy.getAudit.and.returnValue(of(auditVacio));
      syncServiceSpy.reprocessOrder.and.returnValue(throwError(() => ({ error: { error: 'Error feo' } })));
      fixture.detectChanges();
      component.reprocessOrderId = 'ORD-5';

      component.reprocessOrder();

      expect(component.reprocessResult).toBe('Error feo');
      expect(component.reprocessingOrder).toBeFalse();
    });
  });

  describe('devoluciones', () => {
    it('returnsQuery no se dispara si no hay base de datos', async () => {
      syncServiceSpy.getConfig.and.returnValue(of(configSinDb));
      fixture.detectChanges();
      await flushQuery();

      expect(syncServiceSpy.getReturns).not.toHaveBeenCalled();
      expect(component.returnsRows).toEqual([]);
    });

    it('carga las devoluciones cuando hay base de datos', async () => {
      syncServiceSpy.getConfig.and.returnValue(of(configConDb));
      syncServiceSpy.getReturns.and.returnValue(of({ rows: [returnRow], total: 1 }));
      fixture.detectChanges();

      await flushQuery();
      fixture.detectChanges();

      expect(syncServiceSpy.getReturns).toHaveBeenCalledWith(20, 0);
      expect(component.returnsRows).toEqual([returnRow]);
      expect(component.returnsLoading).toBeFalse();
      expect(component.returnsTotal()).toBe(1);
      expect(component.returnsError).toBeNull();
    });

    it('expone el error de returnsQuery formateado', async () => {
      syncServiceSpy.getConfig.and.returnValue(of(configConDb));
      syncServiceSpy.getReturns.and.returnValue(throwError(() => ({ error: { error: 'Error devoluciones' } })));
      fixture.detectChanges();

      await flushQuery();
      fixture.detectChanges();

      expect(component.returnsError).toBe('Error devoluciones');
    });

    it('goToReturnsPage() respeta los límites de página', async () => {
      syncServiceSpy.getConfig.and.returnValue(of(configConDb));
      syncServiceSpy.getReturns.and.returnValue(of({ rows: [returnRow], total: 50 }));
      fixture.detectChanges();
      await flushQuery();
      fixture.detectChanges();

      expect(component.returnsTotalPages()).toBe(3);

      component.goToReturnsPage(2);
      expect(component.returnsCurrentPage()).toBe(2);

      component.goToReturnsPage(99);
      component.goToReturnsPage(0);
      expect(component.returnsCurrentPage()).toBe(2);
    });

    it('refreshReturns() dispara la mutación y arma el mensaje cuando se crean/saltean ítems', async () => {
      syncServiceSpy.getConfig.and.returnValue(of(configConDb));
      syncServiceSpy.fetchReturnsFromMl.and.returnValue(of({ ok: true, claimsChecked: 5, created: 2, skipped: 1 }));
      fixture.detectChanges();
      await flushQuery();

      component.refreshReturns();
      await flushQuery();

      expect(component.fetchResult).toBe('Se revisaron 5 reclamos. Se agregaron 2 ítems (1 ya estaban).');
      expect(component.returnsCurrentPage()).toBe(1);
    });

    it('refreshReturns() informa cuando no hay reclamos recientes', async () => {
      syncServiceSpy.getConfig.and.returnValue(of(configConDb));
      syncServiceSpy.fetchReturnsFromMl.and.returnValue(of({ ok: true, claimsChecked: 0, created: 0, skipped: 0 }));
      fixture.detectChanges();
      await flushQuery();

      component.refreshReturns();
      await flushQuery();

      expect(component.fetchResult).toBe('No hay reclamos recientes con devolución en ML.');
    });

    it('refreshReturns() informa "Lista actualizada" cuando hubo reclamos pero nada nuevo', async () => {
      syncServiceSpy.getConfig.and.returnValue(of(configConDb));
      syncServiceSpy.fetchReturnsFromMl.and.returnValue(of({ ok: true, claimsChecked: 4, created: 0, skipped: 0 }));
      fixture.detectChanges();
      await flushQuery();

      component.refreshReturns();
      await flushQuery();

      expect(component.fetchResult).toBe('Lista actualizada.');
    });

    it('refreshReturns() maneja el error de la mutación', async () => {
      syncServiceSpy.getConfig.and.returnValue(of(configConDb));
      // primer llamado (automático de ngOnInit) exitoso, luego el manual falla
      syncServiceSpy.fetchReturnsFromMl.and.returnValue(of(fetchVacio));
      fixture.detectChanges();
      await flushQuery();

      syncServiceSpy.fetchReturnsFromMl.and.returnValue(throwError(() => ({ error: { error: 'Error al buscar' } })));
      component.refreshReturns();
      await flushQuery();

      expect(component.fetchResult).toBe('Error al buscar');
    });

    it('addReturnsByOrder() no hace nada si el input está vacío', () => {
      fixture.detectChanges();
      component.returnOrderId = '  ';

      component.addReturnsByOrder();

      expect(syncServiceSpy.addReturnsFromOrder).not.toHaveBeenCalled();
    });

    it('addReturnsByOrder() agrega devoluciones e invalida la query', () => {
      syncServiceSpy.getConfig.and.returnValue(of(configConDb));
      syncServiceSpy.addReturnsFromOrder.and.returnValue(of({ created: 2, rows: [returnRow] }));
      fixture.detectChanges();
      spyOn(queryClient, 'invalidateQueries').and.callThrough();
      component.returnOrderId = 'ORD-99';

      component.addReturnsByOrder();

      expect(syncServiceSpy.addReturnsFromOrder).toHaveBeenCalledWith('ORD-99');
      expect(component.returnOrderId).toBe('');
      expect(component.addingReturn).toBeFalse();
      expect(component.returnsCurrentPage()).toBe(1);
      expect(component.fetchResult).toBe('Se agregaron 2 ítems de la orden.');
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['sync', 'returns'] });
    });

    it('addReturnsByOrder() no fija mensaje si no se creó ningún ítem', () => {
      syncServiceSpy.addReturnsFromOrder.and.returnValue(of({ created: 0, rows: [] }));
      fixture.detectChanges();
      component.returnOrderId = 'ORD-100';

      component.addReturnsByOrder();

      expect(component.fetchResult).toBeNull();
    });

    it('addReturnsByOrder() maneja el error', () => {
      syncServiceSpy.addReturnsFromOrder.and.returnValue(throwError(() => ({ error: { error: 'Orden inválida' } })));
      fixture.detectChanges();
      component.returnOrderId = 'ORD-BAD';

      component.addReturnsByOrder();

      expect(component.fetchResult).toBe('Orden inválida');
      expect(component.addingReturn).toBeFalse();
    });

    it('approveReturn() restaura stock, invalida la query y recarga el historial', () => {
      syncServiceSpy.getConfig.and.returnValue(of(configConDb));
      syncServiceSpy.getAudit.and.returnValue(of(auditVacio));
      fixture.detectChanges();
      spyOn(queryClient, 'invalidateQueries').and.callThrough();
      syncServiceSpy.getAudit.calls.reset();

      component.approveReturn(returnRow);

      expect(syncServiceSpy.approveReturn).toHaveBeenCalledWith(returnRow.id);
      expect(component.approvingId).toBeNull();
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['sync', 'returns'] });
      expect(syncServiceSpy.getAudit).toHaveBeenCalled();
    });

    it('approveReturn() maneja el error', () => {
      syncServiceSpy.approveReturn.and.returnValue(throwError(() => ({ error: { error: 'No se pudo restaurar' } })));
      fixture.detectChanges();

      component.approveReturn(returnRow);

      expect(component.fetchResult).toBe('No se pudo restaurar');
      expect(component.approvingId).toBeNull();
    });
  });

  describe('tareas pendientes de ML', () => {
    it('pendingTasksQuery no se dispara sin base de datos', async () => {
      syncServiceSpy.getConfig.and.returnValue(of(configSinDb));
      fixture.detectChanges();
      await flushQuery();

      expect(syncServiceSpy.getPendingTasks).not.toHaveBeenCalled();
      expect(component.pendingTasks).toEqual([]);
    });

    it('carga las tareas pendientes cuando hay base de datos', async () => {
      syncServiceSpy.getConfig.and.returnValue(of(configConDb));
      syncServiceSpy.getPendingTasks.and.returnValue(of({ tasks: [failedTask], total: 1, activeCount: 0, failedCount: 1 }));
      fixture.detectChanges();

      await flushQuery();
      fixture.detectChanges();

      expect(syncServiceSpy.getPendingTasks).toHaveBeenCalledWith(20, 0);
      expect(component.pendingTasks).toEqual([failedTask]);
      expect(component.pendingTasksLoading).toBeFalse();
      expect(component.activeTasksCount).toBe(0);
      expect(component.failedTasksCount).toBe(1);
      expect(component.pendingTasksQueryError).toBeNull();
    });

    it('expone el error de pendingTasksQuery formateado', async () => {
      syncServiceSpy.getConfig.and.returnValue(of(configConDb));
      syncServiceSpy.getPendingTasks.and.returnValue(throwError(() => ({ error: { error: 'Error tareas' } })));
      fixture.detectChanges();

      await flushQuery();
      fixture.detectChanges();

      expect(component.pendingTasksQueryError).toBe('Error tareas');
    });

    it('goToTasksPage() respeta los límites de página', async () => {
      syncServiceSpy.getConfig.and.returnValue(of(configConDb));
      syncServiceSpy.getPendingTasks.and.returnValue(of({ tasks: [failedTask], total: 50, activeCount: 0, failedCount: 1 }));
      fixture.detectChanges();
      await flushQuery();
      fixture.detectChanges();

      expect(component.tasksTotalPages()).toBe(3);

      component.goToTasksPage(2);
      expect(component.tasksCurrentPage()).toBe(2);

      component.goToTasksPage(0);
      component.goToTasksPage(99);
      expect(component.tasksCurrentPage()).toBe(2);
    });

    it('refreshPendingTasks() limpia el error e invalida la query', () => {
      fixture.detectChanges();
      spyOn(queryClient, 'invalidateQueries').and.callThrough();
      component.pendingTasksError = 'algo';

      component.refreshPendingTasks();

      expect(component.pendingTasksError).toBeNull();
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['sync', 'pendingTasks'] });
    });

    describe('retryTask', () => {
      it('no reintenta tareas que no están en estado "failed"', () => {
        fixture.detectChanges();
        component.retryTask({ ...failedTask, status: 'pending' });

        expect(syncServiceSpy.retryTask).not.toHaveBeenCalled();
      });

      it('reintenta una tarea fallida exitosamente e invalida la query', () => {
        fixture.detectChanges();
        spyOn(queryClient, 'invalidateQueries').and.callThrough();

        component.retryTask(failedTask);

        expect(syncServiceSpy.retryTask).toHaveBeenCalledWith(failedTask.id);
        expect(component.retryingTaskId).toBeNull();
        expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['sync', 'pendingTasks'] });
      });

      it('maneja el error al reintentar una tarea', () => {
        syncServiceSpy.retryTask.and.returnValue(throwError(() => ({ error: { error: 'No se pudo reintentar' } })));
        fixture.detectChanges();

        component.retryTask(failedTask);

        expect(component.pendingTasksError).toBe('No se pudo reintentar');
        expect(component.retryingTaskId).toBeNull();
      });
    });
  });

  describe('registerWebhooks', () => {
    it('informa cuántos webhooks se registraron', () => {
      syncServiceSpy.registerWebhooks.and.returnValue(of({ ok: true, registered: 3, created: [] }));
      fixture.detectChanges();

      component.registerWebhooks();

      expect(component.webhooksResult).toBe('Webhooks registrados: 3.');
      expect(component.registeringWebhooks).toBeFalse();
    });

    it('informa que ya estaban registrados si registered es 0', () => {
      syncServiceSpy.registerWebhooks.and.returnValue(of({ ok: true, registered: 0, created: [] }));
      fixture.detectChanges();

      component.registerWebhooks();

      expect(component.webhooksResult).toBe('Ya estaban registrados con la URL actual.');
    });

    it('maneja el error al registrar webhooks', () => {
      syncServiceSpy.registerWebhooks.and.returnValue(throwError(() => ({ error: { error: 'Error webhooks' } })));
      fixture.detectChanges();

      component.registerWebhooks();

      expect(component.webhooksResult).toBe('Error webhooks');
      expect(component.registeringWebhooks).toBeFalse();
    });
  });

  describe('tabs() (badges de conteo)', () => {
    it('sin devoluciones ni tareas, no muestra badges de conteo', () => {
      fixture.detectChanges();
      const tabs = component.tabs();

      expect(tabs.map(t => t.key)).toEqual(['estado', 'devoluciones', 'cola', 'historial']);
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

  describe('helpers de formato', () => {
    beforeEach(() => fixture.detectChanges());

    it('channelLabel() traduce los canales', () => {
      expect(component.channelLabel('mercadolibre')).toBe('Mercado Libre');
      expect(component.channelLabel('tiendanube')).toBe('Tienda Nube');
    });

    it('stateChipClass() cubre todas las variantes de estado', () => {
      expect(component.stateChipClass(null)).toBe('state-chip n');
      expect(component.stateChipClass(undefined)).toBe('state-chip n');
      expect(component.stateChipClass('Venta ML')).toBe('state-chip vml');
      expect(component.stateChipClass('Venta TN')).toBe('state-chip vtn');
      expect(component.stateChipClass('Cancelación')).toBe('state-chip can');
      expect(component.stateChipClass('Devolución')).toBe('state-chip dev');
      expect(component.stateChipClass('Otro estado')).toBe('state-chip n');
    });

    it('formatDate() formatea o devuelve "—" si no hay fecha', () => {
      expect(component.formatDate(null)).toBe('—');
      expect(component.formatDate(undefined)).toBe('—');
      expect(component.formatDate('2026-01-01T10:00:00Z')).not.toBe('—');
    });

    it('taskKindLabel() traduce todos los tipos de tarea', () => {
      expect(component.taskKindLabel('stock_ml')).toBe('Stock ML');
      expect(component.taskKindLabel('sku_ml')).toBe('SKU ML');
      expect(component.taskKindLabel('sku_tn')).toBe('SKU TN');
      expect(component.taskKindLabel('price_ml')).toBe('Precio ML');
    });

    it('taskStatusLabel() y taskStatusChipClass() traducen todos los estados', () => {
      expect(component.taskStatusLabel('pending')).toBe('Pendiente');
      expect(component.taskStatusLabel('processing')).toBe('En proceso');
      expect(component.taskStatusLabel('failed')).toBe('Falló');

      expect(component.taskStatusChipClass('pending')).toBe('task-chip pending');
      expect(component.taskStatusChipClass('processing')).toBe('task-chip processing');
      expect(component.taskStatusChipClass('failed')).toBe('task-chip failed');
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
