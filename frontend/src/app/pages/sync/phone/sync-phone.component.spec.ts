import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { SyncPhoneComponent, dayLabel, groupByDay } from './sync-phone.component';
import { SyncStore } from '../sync.store';
import { SyncService, PendingMlTask } from '../../../core/services/sync.service';
import { SessionService } from '../../../core/services/session.service';
import { auditRow, auditRowManual, createSyncServiceSpy, failedTask, flushQuery, returnRow, syncTestProviders } from '../sync.testing';

describe('SyncPhoneComponent', () => {
  let fixture: ComponentFixture<SyncPhoneComponent>;
  let component: SyncPhoneComponent;
  let store: SyncStore;
  let spy: jasmine.SpyObj<SyncService>;
  const admin = signal(true);

  beforeEach(() => {
    admin.set(true);
    spy = createSyncServiceSpy();
    TestBed.configureTestingModule({
      imports: [SyncPhoneComponent],
      providers: [
        ...syncTestProviders(spy),
        SyncStore,
        { provide: SessionService, useValue: { isAdmin: () => admin(), isReadOnly: () => !admin(), user: () => null } },
      ],
    });
    store = TestBed.inject(SyncStore);
  });

  afterEach(() => fixture?.destroy());

  async function mount(): Promise<void> {
    store.hasDatabase.set(true);
    fixture = TestBed.createComponent(SyncPhoneComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await flushQuery();
    fixture.detectChanges();
  }

  const text = () => fixture.nativeElement.textContent as string;
  const stuckTask: PendingMlTask = { ...failedTask, id: 8, kind: 'price_ml', targetPrice: 1000, status: 'processing', stuck: true, lastError: null };

  it('revisa los reclamos de ML al abrir y muestra las devoluciones arriba con sus botones', async () => {
    spy.getReturns.and.returnValue(of({ rows: [returnRow], total: 1 }));
    await mount();
    expect(spy.fetchReturnsFromMl).toHaveBeenCalledTimes(1);
    expect(text()).toContain('Devoluciones para confirmar');
    expect(text()).toContain('Cuaderno tapa dura');
    expect(text()).toContain('Restaurar stock');
    expect(text()).toContain('Descartar');
  });

  it('sin nada pendiente dice "Todo al día"', async () => {
    await mount();
    expect(text()).toContain('Todo al día');
  });

  it('cuenta las trabadas como error, no como en cola', async () => {
    spy.getPendingTasks.and.returnValue(of({ tasks: [failedTask, stuckTask], total: 2, activeCount: 1, failedCount: 1 }));
    await mount();
    expect(component.errorCount()).toBe(2);
    expect(component.queueCount()).toBe(0);
    expect(component.problemTasks().map((t) => t.id)).toEqual([7, 8]);
    expect(text()).toContain('Cola ML con problemas');
  });

  it('aprobar una devolución restaura y recarga devoluciones e historial', async () => {
    spy.getReturns.and.returnValue(of({ rows: [returnRow], total: 1 }));
    await mount();
    spy.getAudit.calls.reset();
    component.approveReturn(returnRow);
    expect(spy.approveReturn).toHaveBeenCalledWith(5);
    expect(spy.getAudit).toHaveBeenCalled();
    expect(component.notice()).toContain('Stock restaurado');
  });

  it('descartar no toca el historial', async () => {
    await mount();
    spy.getAudit.calls.reset();
    component.dismissReturn(returnRow);
    expect(spy.dismissReturn).toHaveBeenCalledWith(5);
    expect(spy.getAudit).not.toHaveBeenCalled();
  });

  it('un número de arriba filtra y se vuelve a tocar para sacar el filtro', async () => {
    spy.getAudit.and.returnValue(of({ rows: [auditRow], total: 1 }));
    await mount();
    expect(text()).toContain('Movimientos');
    component.toggleFocus('queue');
    fixture.detectChanges();
    expect(text()).not.toContain('Movimientos');
    expect(text()).toContain('No hay actualizaciones en cola.');
    component.toggleFocus('queue');
    expect(component.focus()).toBeNull();
  });

  it('arranca filtrado si viene del acceso directo Devoluciones', async () => {
    store.hasDatabase.set(true);
    fixture = TestBed.createComponent(SyncPhoneComponent);
    fixture.componentRef.setInput('initialFocus', 'returns');
    fixture.detectChanges();
    expect(fixture.componentInstance.focus()).toBe('returns');
  });

  it('tocar un movimiento abre la hoja; revertir solo si se puede', async () => {
    spy.getAudit.and.returnValue(of({ rows: [auditRow, auditRowManual], total: 2 }));
    await mount();
    expect(component.canRevert(auditRow)).toBeTrue();
    expect(component.canRevert(auditRowManual)).toBeFalse();
    component.showAudit(auditRow);
    fixture.detectChanges();
    expect(document.body.textContent).toContain('Ver todo el historial de este SKU');
    component.revert(auditRow);
    expect(spy.revertAudit).toHaveBeenCalledWith(1);
    expect(component.openAudit()).toBeNull();
  });

  it('solo lectura: sin Revertir ni botones de devoluciones', async () => {
    admin.set(false);
    spy.getReturns.and.returnValue(of({ rows: [returnRow], total: 1 }));
    await mount();
    expect(component.canRevert(auditRow)).toBeFalse();
    expect(text()).not.toContain('Restaurar stock');
  });

  it('"ver todo el historial" abre el modal del SKU', async () => {
    await mount();
    component.showAudit(auditRow);
    component.openSkuHistory('SKU-1');
    expect(component.openAudit()).toBeNull();
    expect(component.historySku()).toBe('SKU-1');
  });

  it('reintentar una venta ya descontada pide confirmar antes de descontarla de nuevo', async () => {
    await mount();
    spy.getAudit.and.returnValue(of({ rows: [auditRow], total: 1 }));
    component.openOrderSheet('reprocess');
    component.orderId.set('ORD-1');
    component.submitOrder();
    expect(component.confirmReprocess()).toBeTrue();
    expect(spy.reprocessOrder).not.toHaveBeenCalled();
    component.submitOrder();
    expect(spy.reprocessOrder).toHaveBeenCalledWith('ORD-1');
    expect(component.orderSheet()).toBeNull();
  });

  it('agregar una devolución por nro de venta', async () => {
    await mount();
    spy.addReturnsFromOrder.and.returnValue(of({ created: 2, rows: [] }));
    component.openOrderSheet('return');
    component.orderId.set('123');
    component.submitOrder();
    expect(spy.addReturnsFromOrder).toHaveBeenCalledWith('123');
    expect(component.notice()).toContain('Se agregaron 2');
  });

  it('reintentar una tarea con error', async () => {
    await mount();
    component.retryTask(failedTask);
    expect(spy.retryTask).toHaveBeenCalledWith(7);
  });

  describe('agrupar por día', () => {
    const now = new Date(2026, 10, 19, 15, 0);

    it('hoy, ayer y fechas', () => {
      expect(dayLabel(new Date(2026, 10, 19, 9).toISOString(), now)).toBe('Hoy');
      expect(dayLabel(new Date(2026, 10, 18, 23).toISOString(), now)).toBe('Ayer');
      expect(dayLabel(new Date(2026, 10, 12, 10).toISOString(), now)).toMatch(/12\/11/);
    });

    it('junta las filas seguidas del mismo día sin reordenar', () => {
      const at = (d: number, id: number) => ({ ...auditRow, id, createdAt: new Date(2026, 10, d, 10).toISOString() });
      const groups = groupByDay([at(19, 1), at(19, 2), at(18, 3)], now);
      expect(groups.map((g) => [g.label, g.rows.map((r) => r.id)])).toEqual([['Hoy', [1, 2]], ['Ayer', [3]]]);
    });
  });
});
