import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { of, throwError, Subject } from 'rxjs';
import { SyncHistorialComponent } from './sync-historial.component';
import { SyncStore } from '../sync.store';
import { SyncService, SyncAuditRow, SyncAuditResponse } from '../../../core/services/sync.service';
import { auditRow, auditRowManual, auditVacio, createSyncServiceSpy, syncTestProviders } from '../sync.testing';

describe('SyncHistorialComponent', () => {
  let fixture: ComponentFixture<SyncHistorialComponent>;
  let component: SyncHistorialComponent;
  let store: SyncStore;
  let syncServiceSpy: jasmine.SpyObj<SyncService>;

  beforeEach(() => {
    syncServiceSpy = createSyncServiceSpy();
    TestBed.configureTestingModule({
      imports: [SyncHistorialComponent],
      providers: [...syncTestProviders(syncServiceSpy), SyncStore]
    });

    fixture = TestBed.createComponent(SyncHistorialComponent);
    component = fixture.componentInstance;
    store = TestBed.inject(SyncStore);
  });

  afterEach(() => {
    fixture.destroy();
  });

  /** La carga inicial del historial la hace la página (SyncComponent.ngOnInit). */
  function init(): void {
    store.loadAudit();
    fixture.detectChanges();
  }

  describe('historial de sincronización (auditoría)', () => {
    it('carga y pinta el historial', () => {
      syncServiceSpy.getAudit.and.returnValue(of({ rows: [auditRow], total: 1 }));
      init();

      expect(syncServiceSpy.getAudit).toHaveBeenCalledWith(25, 0, undefined, '');
      expect(store.auditRows()).toEqual([auditRow]);
      expect(store.auditTotal()).toBe(1);
      expect(store.auditLoading()).toBeFalse();
      expect(fixture.nativeElement.textContent).toContain('Cuaderno A4 - Tapa dura');
    });

    it('maneja el error al cargar el historial', () => {
      syncServiceSpy.getAudit.and.returnValue(throwError(() => ({ error: { error: 'Error de auditoría' } })));
      init();

      expect(store.auditError()).toBe('Error de auditoría');
      expect(store.auditLoading()).toBeFalse();
      expect(fixture.nativeElement.textContent).toContain('Error de auditoría');
    });

    it('refreshAudit() vuelve a la página 1 y recarga', () => {
      syncServiceSpy.getAudit.and.returnValue(of({ rows: [auditRow], total: 100 }));
      init();
      store.goToAuditPage(3);
      syncServiceSpy.getAudit.calls.reset();

      store.refreshAudit();

      expect(store.auditCurrentPage()).toBe(1);
      expect(syncServiceSpy.getAudit).toHaveBeenCalledWith(25, 0, undefined, '');
    });

    it('goToAuditPage() pagina correctamente y respeta los límites', () => {
      syncServiceSpy.getAudit.and.returnValue(of({ rows: [auditRow], total: 100 }));
      init();
      expect(store.auditTotalPages()).toBe(4);
      syncServiceSpy.getAudit.calls.reset();

      store.goToAuditPage(2);
      expect(store.auditCurrentPage()).toBe(2);
      expect(syncServiceSpy.getAudit).toHaveBeenCalledWith(25, 25, undefined, '');

      syncServiceSpy.getAudit.calls.reset();
      store.goToAuditPage(0);
      store.goToAuditPage(10);

      expect(store.auditCurrentPage()).toBe(2);
      expect(syncServiceSpy.getAudit).not.toHaveBeenCalled();
    });

    it('busca por término luego del debounce y vuelve a la página 1', fakeAsync(() => {
      syncServiceSpy.getAudit.and.returnValue(of(auditVacio));
      init();
      syncServiceSpy.getAudit.calls.reset();

      store.auditSearchQuery.set('2000011838697695');
      fixture.detectChanges();
      tick(350);

      expect(syncServiceSpy.getAudit).toHaveBeenCalledWith(25, 0, '2000011838697695', '');
      expect(store.auditCurrentPage()).toBe(1);
    }));

    it('setAuditSource() filtra por origen y vuelve a la página 1', () => {
      syncServiceSpy.getAudit.and.returnValue(of(auditVacio));
      init();
      store.goToAuditPage(2);
      syncServiceSpy.getAudit.calls.reset();

      store.setAuditSource('manual');

      expect(syncServiceSpy.getAudit).toHaveBeenCalledWith(25, 0, undefined, 'manual');
      expect(store.auditCurrentPage()).toBe(1);
      expect(store.auditSource()).toBe('manual');
    });

    it('setAuditSource() con el origen ya activo no recarga de gusto', () => {
      syncServiceSpy.getAudit.and.returnValue(of(auditVacio));
      init();
      syncServiceSpy.getAudit.calls.reset();

      store.setAuditSource('');

      expect(syncServiceSpy.getAudit).not.toHaveBeenCalled();
    });

    it('un cambio manual no ofrece revertir: no hay venta que deshacer', () => {
      expect(component.canRevert(auditRowManual)).toBeFalse();
      expect(component.canRevert(auditRow)).toBeTrue();
    });

    it('etiqueta el origen de cada fila del historial', () => {
      expect(component.auditSourceLabel('manual')).toBe('Manual');
      expect(component.auditSourceLabel('devolucion')).toBe('Devolución');
      expect(component.auditSourceLabel('venta')).toBe('Venta');
    });

    it('descarta una respuesta de auditoría obsoleta si llegó tras una carga más nueva', () => {
      const first$ = new Subject<SyncAuditResponse>();
      const second$ = new Subject<SyncAuditResponse>();
      syncServiceSpy.getAudit.and.returnValues(first$.asObservable(), second$.asObservable());
      init(); // dispara la carga inicial (usa first$)

      store.loadAudit(); // dispara una segunda carga (usa second$); auditRequestId avanza

      second$.next({ rows: [auditRow], total: 1 });
      first$.next({ rows: [], total: 0 }); // respuesta tardía de la carga vieja: se descarta

      expect(store.auditRows()).toEqual([auditRow]);
      expect(store.auditTotal()).toBe(1);
    });

    it('descarta un error de auditoría obsoleto si llegó tras una carga más nueva', () => {
      const first$ = new Subject<SyncAuditResponse>();
      const second$ = new Subject<SyncAuditResponse>();
      syncServiceSpy.getAudit.and.returnValues(first$.asObservable(), second$.asObservable());
      init();

      store.loadAudit();

      second$.next({ rows: [auditRow], total: 1 });
      first$.error({ error: { error: 'obsoleto' } }); // error tardío de la carga vieja: se descarta

      expect(store.auditError()).toBeNull();
      expect(store.auditRows()).toEqual([auditRow]);
    });

    describe('revertAudit', () => {
      it('no hace nada si la fila ya fue revertida', () => {
        init();
        component.revertAudit({ ...auditRow, revertedAt: '2026-01-05T00:00:00Z' });

        expect(syncServiceSpy.revertAudit).not.toHaveBeenCalled();
      });

      it('revierte exitosamente y recarga el historial', () => {
        syncServiceSpy.getAudit.and.returnValue(of({ rows: [auditRow], total: 1 }));
        init();
        syncServiceSpy.getAudit.calls.reset();

        component.revertAudit(auditRow);

        expect(syncServiceSpy.revertAudit).toHaveBeenCalledWith(auditRow.id);
        expect(component.revertingAuditId()).toBeNull();
        expect(syncServiceSpy.getAudit).toHaveBeenCalled();
      });

      it('maneja el error al revertir', () => {
        syncServiceSpy.revertAudit.and.returnValue(throwError(() => ({ error: { error: 'No se pudo revertir esto' } })));
        init();

        component.revertAudit(auditRow);

        expect(store.revertError()).toBe('No se pudo revertir esto');
        expect(component.revertingAuditId()).toBeNull();
      });
    });
  });

  describe('reintentar sincronización de una venta (reprocessOrder)', () => {
    /** La consulta previa (limit 50) encuentra la venta ya sincronizada; el resto, vacío. */
    function alreadySynced(): void {
      syncServiceSpy.getAudit.and.callFake((limit: number) => {
        if (limit === 50) return of({ rows: [{ ...auditRow, orderId: 'ORD-1', revertedAt: null }], total: 1 });
        return of(auditVacio);
      });
    }

    it('no hace nada si el id está vacío', () => {
      init();
      component.reprocessOrderId.set('   ');

      component.reprocessOrder();

      expect(syncServiceSpy.getAudit).toHaveBeenCalledTimes(1); // solo la carga inicial
    });

    it('confirmReprocess() no hace nada si no hay una confirmación pendiente', () => {
      init();
      expect(component.confirmReprocessId()).toBeNull();

      component.confirmReprocess();

      expect(syncServiceSpy.reprocessOrder).not.toHaveBeenCalled();
    });

    it('pide confirmación si la orden ya estaba sincronizada (sin revertir)', () => {
      alreadySynced();
      init();
      component.reprocessOrderId.set('ORD-1');

      component.reprocessOrder();

      expect(component.confirmReprocessId()).toBe('ORD-1');
      expect(component.reprocessingOrder()).toBeFalse();
      expect(syncServiceSpy.reprocessOrder).not.toHaveBeenCalled();
    });

    it('confirmReprocess() somete el reproceso tras la confirmación', () => {
      alreadySynced();
      syncServiceSpy.reprocessOrder.and.returnValue(of({ ok: true, orderId: 'ORD-1', itemsSynced: 3 }));
      init();
      component.reprocessOrderId.set('ORD-1');
      component.reprocessOrder();

      component.confirmReprocess();

      expect(component.confirmReprocessId()).toBeNull();
      expect(syncServiceSpy.reprocessOrder).toHaveBeenCalledWith('ORD-1');
      expect(component.reprocessResult()).toBe('Orden ORD-1 sincronizada: 3 ítem(s) descontados.');
      expect(component.reprocessOrderId()).toBe('');
    });

    it('cancelReprocess() descarta la confirmación pendiente', () => {
      alreadySynced();
      init();
      component.reprocessOrderId.set('ORD-1');
      component.reprocessOrder();

      component.cancelReprocess();

      expect(component.confirmReprocessId()).toBeNull();
    });

    it('somete directamente el reproceso si la orden no estaba ya sincronizada', () => {
      syncServiceSpy.getAudit.and.returnValue(of(auditVacio));
      syncServiceSpy.reprocessOrder.and.returnValue(of({ ok: true, orderId: 'ORD-2', itemsSynced: 1 }));
      init();
      component.reprocessOrderId.set('ORD-2');

      component.reprocessOrder();

      expect(syncServiceSpy.reprocessOrder).toHaveBeenCalledWith('ORD-2');
      expect(component.reprocessResult()).toBe('Orden ORD-2 sincronizada: 1 ítem(s) descontados.');
    });

    it('si falla la consulta previa de auditoría, igual somete el reproceso', () => {
      syncServiceSpy.getAudit.and.callFake((limit: number) => {
        if (limit === 50) return throwError(() => ({ error: { error: 'boom' } }));
        return of(auditVacio);
      });
      syncServiceSpy.reprocessOrder.and.returnValue(of({ ok: true, orderId: 'ORD-3', itemsSynced: 1 }));
      init();
      component.reprocessOrderId.set('ORD-3');

      component.reprocessOrder();

      expect(syncServiceSpy.reprocessOrder).toHaveBeenCalledWith('ORD-3');
    });

    it('cuando el backend responde ok:false no fija reprocessResult y no limpia el input', () => {
      syncServiceSpy.getAudit.and.returnValue(of(auditVacio));
      syncServiceSpy.reprocessOrder.and.returnValue(of({ ok: false, orderId: 'ORD-4', itemsSynced: 0 }));
      init();
      component.reprocessOrderId.set('ORD-4');

      component.reprocessOrder();

      expect(component.reprocessResult()).toBeNull();
      expect(component.reprocessOrderId()).toBe('ORD-4');
    });

    it('maneja el error al reintentar la sincronización', () => {
      syncServiceSpy.getAudit.and.returnValue(of(auditVacio));
      syncServiceSpy.reprocessOrder.and.returnValue(throwError(() => ({ error: { error: 'Error feo' } })));
      init();
      component.reprocessOrderId.set('ORD-5');

      component.reprocessOrder();

      expect(component.reprocessResult()).toBe('Error feo');
      expect(component.reprocessingOrder()).toBeFalse();
    });
  });

  describe('helpers de formato', () => {
    it('revertTitle() dice "Sumar" cuando el movimiento original restó stock (venta)', () => {
      const venta: SyncAuditRow = { ...auditRow, quantity: 2, stockBefore: 10, stockAfter: 8, updatedChannel: 'tiendanube' };
      expect(component.revertTitle(venta)).toBe('Sumar 2 de nuevo en Tienda Nube');
    });

    it('revertTitle() dice "Descontar" cuando el movimiento original sumó stock (cancelación)', () => {
      const cancelacion: SyncAuditRow = { ...auditRow, quantity: 2, stockBefore: 8, stockAfter: 10, updatedChannel: 'mercadolibre' };
      expect(component.revertTitle(cancelacion)).toBe('Descontar 2 de nuevo en Mercado Libre');
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
  });
});
