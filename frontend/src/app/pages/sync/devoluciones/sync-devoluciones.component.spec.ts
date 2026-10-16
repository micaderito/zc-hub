import { ComponentFixture, TestBed } from '@angular/core/testing';
import { QueryClient } from '@tanstack/angular-query-experimental';
import { of, throwError } from 'rxjs';
import { SyncDevolucionesComponent } from './sync-devoluciones.component';
import { SyncStore } from '../sync.store';
import { SyncService } from '../../../core/services/sync.service';
import { auditVacio, createSyncServiceSpy, flushQuery, returnRow, syncTestProviders } from '../sync.testing';

describe('SyncDevolucionesComponent', () => {
  let fixture: ComponentFixture<SyncDevolucionesComponent>;
  let component: SyncDevolucionesComponent;
  let store: SyncStore;
  let syncServiceSpy: jasmine.SpyObj<SyncService>;
  let queryClient: QueryClient;

  beforeEach(() => {
    syncServiceSpy = createSyncServiceSpy();
    TestBed.configureTestingModule({
      imports: [SyncDevolucionesComponent],
      providers: [...syncTestProviders(syncServiceSpy), SyncStore]
    });

    store = TestBed.inject(SyncStore);
    queryClient = TestBed.inject(QueryClient);
  });

  afterEach(() => {
    fixture?.destroy();
  });

  /** La pestaña solo se monta con base de datos (la página la esconde si no hay). */
  async function mount(hasDatabase = true): Promise<void> {
    store.hasDatabase.set(hasDatabase);
    fixture = TestBed.createComponent(SyncDevolucionesComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await flushQuery();
    fixture.detectChanges();
  }

  it('returnsQuery no se dispara si no hay base de datos', async () => {
    await mount(false);

    expect(syncServiceSpy.getReturns).not.toHaveBeenCalled();
    expect(component.returnsRows()).toEqual([]);
  });

  it('carga y pinta las devoluciones cuando hay base de datos', async () => {
    syncServiceSpy.getReturns.and.returnValue(of({ rows: [returnRow], total: 1 }));
    await mount();

    expect(syncServiceSpy.getReturns).toHaveBeenCalledWith(20, 0);
    expect(component.returnsRows()).toEqual([returnRow]);
    expect(component.returnsLoading()).toBeFalse();
    expect(store.returnsTotal()).toBe(1);
    expect(component.returnsError()).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Cuaderno tapa dura');
  });

  it('al abrirse crawlea ML una vez y avisa si encontró algo', async () => {
    syncServiceSpy.fetchReturnsFromMl.and.returnValue(of({ ok: true, claimsChecked: 3, created: 1, skipped: 0 }));
    await mount();

    expect(syncServiceSpy.fetchReturnsFromMl).toHaveBeenCalledTimes(1);
    expect(component.fetchResult()).toBe('Se revisaron 3 reclamos. Se agregaron 1 ítems.');
  });

  it('expone el error de returnsQuery formateado', async () => {
    syncServiceSpy.getReturns.and.returnValue(throwError(() => ({ error: { error: 'Error devoluciones' } })));
    await mount();

    expect(component.returnsError()).toBe('Error devoluciones');
  });

  it('goToReturnsPage() respeta los límites de página', async () => {
    syncServiceSpy.getReturns.and.returnValue(of({ rows: [returnRow], total: 50 }));
    await mount();

    expect(store.returnsTotalPages()).toBe(3);

    store.goToReturnsPage(2);
    expect(store.returnsCurrentPage()).toBe(2);

    store.goToReturnsPage(99);
    store.goToReturnsPage(0);
    expect(store.returnsCurrentPage()).toBe(2);
  });

  it('refreshReturns() dispara la mutación y arma el mensaje cuando se crean/saltean ítems', async () => {
    await mount();
    syncServiceSpy.fetchReturnsFromMl.and.returnValue(of({ ok: true, claimsChecked: 5, created: 2, skipped: 1 }));

    component.refreshReturns();
    await flushQuery();

    expect(component.fetchResult()).toBe('Se revisaron 5 reclamos. Se agregaron 2 ítems (1 ya estaban).');
    expect(store.returnsCurrentPage()).toBe(1);
  });

  it('refreshReturns() informa cuando no hay reclamos recientes', async () => {
    await mount();
    syncServiceSpy.fetchReturnsFromMl.and.returnValue(of({ ok: true, claimsChecked: 0, created: 0, skipped: 0 }));

    component.refreshReturns();
    await flushQuery();

    expect(component.fetchResult()).toBe('No hay reclamos recientes con devolución en ML.');
  });

  it('refreshReturns() informa "Lista actualizada" cuando hubo reclamos pero nada nuevo', async () => {
    await mount();
    syncServiceSpy.fetchReturnsFromMl.and.returnValue(of({ ok: true, claimsChecked: 4, created: 0, skipped: 0 }));

    component.refreshReturns();
    await flushQuery();

    expect(component.fetchResult()).toBe('Lista actualizada.');
  });

  it('refreshReturns() avisa honestamente cuando ML está saturado (mlBusy) en vez de "no hay reclamos"', async () => {
    await mount();
    syncServiceSpy.fetchReturnsFromMl.and.returnValue(
      of({ ok: true, claimsChecked: 0, created: 0, skipped: 0, mlBusy: true, skippedCrawl: true })
    );

    component.refreshReturns();
    await flushQuery();

    expect(component.fetchResult()).toContain('saturado');
  });

  it('refreshReturns() maneja el error de la mutación', async () => {
    await mount();
    syncServiceSpy.fetchReturnsFromMl.and.returnValue(throwError(() => ({ error: { error: 'Error al buscar' } })));

    component.refreshReturns();
    await flushQuery();

    expect(component.fetchResult()).toBe('Error al buscar');
  });

  it('addReturnsByOrder() no hace nada si el input está vacío', async () => {
    await mount();
    component.returnOrderId.set('  ');

    component.addReturnsByOrder();

    expect(syncServiceSpy.addReturnsFromOrder).not.toHaveBeenCalled();
  });

  it('addReturnsByOrder() agrega devoluciones e invalida la query', async () => {
    syncServiceSpy.addReturnsFromOrder.and.returnValue(of({ created: 2, rows: [returnRow] }));
    await mount();
    spyOn(queryClient, 'invalidateQueries').and.callThrough();
    component.returnOrderId.set('ORD-99');

    component.addReturnsByOrder();

    expect(syncServiceSpy.addReturnsFromOrder).toHaveBeenCalledWith('ORD-99');
    expect(component.returnOrderId()).toBe('');
    expect(component.addingReturn()).toBeFalse();
    expect(store.returnsCurrentPage()).toBe(1);
    expect(component.fetchResult()).toBe('Se agregaron 2 ítems de la orden.');
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['sync', 'returns'] });
  });

  it('addReturnsByOrder() no fija mensaje si no se creó ningún ítem', async () => {
    syncServiceSpy.addReturnsFromOrder.and.returnValue(of({ created: 0, rows: [] }));
    await mount();
    component.returnOrderId.set('ORD-100');

    component.addReturnsByOrder();

    expect(component.fetchResult()).toBeNull();
  });

  it('addReturnsByOrder() maneja el error', async () => {
    syncServiceSpy.addReturnsFromOrder.and.returnValue(throwError(() => ({ error: { error: 'Orden inválida' } })));
    await mount();
    component.returnOrderId.set('ORD-BAD');

    component.addReturnsByOrder();

    expect(component.fetchResult()).toBe('Orden inválida');
    expect(component.addingReturn()).toBeFalse();
  });

  it('approveReturn() restaura stock, invalida la query y recarga el historial', async () => {
    syncServiceSpy.getAudit.and.returnValue(of(auditVacio));
    await mount();
    spyOn(queryClient, 'invalidateQueries').and.callThrough();
    syncServiceSpy.getAudit.calls.reset();

    component.approveReturn(returnRow);

    expect(syncServiceSpy.approveReturn).toHaveBeenCalledWith(returnRow.id);
    expect(component.approvingId()).toBeNull();
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['sync', 'returns'] });
    expect(syncServiceSpy.getAudit).toHaveBeenCalled();
  });

  it('approveReturn() maneja el error', async () => {
    syncServiceSpy.approveReturn.and.returnValue(throwError(() => ({ error: { error: 'No se pudo restaurar' } })));
    await mount();

    component.approveReturn(returnRow);

    expect(component.fetchResult()).toBe('No se pudo restaurar');
    expect(component.approvingId()).toBeNull();
  });

  it('dismissReturn() saca la fila de la lista sin tocar el historial de stock', async () => {
    await mount();
    spyOn(queryClient, 'invalidateQueries').and.callThrough();
    syncServiceSpy.getAudit.calls.reset();

    component.dismissReturn(returnRow);

    expect(syncServiceSpy.dismissReturn).toHaveBeenCalledWith(returnRow.id);
    expect(component.dismissingId()).toBeNull();
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['sync', 'returns'] });
    expect(syncServiceSpy.getAudit).not.toHaveBeenCalled();
  });

  it('dismissReturn() maneja el error', async () => {
    syncServiceSpy.dismissReturn.and.returnValue(throwError(() => ({ error: { error: 'No se pudo descartar' } })));
    await mount();

    component.dismissReturn(returnRow);

    expect(component.fetchResult()).toBe('No se pudo descartar');
    expect(component.dismissingId()).toBeNull();
  });
});
