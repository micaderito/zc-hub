import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, ActivatedRoute, convertToParamMap } from '@angular/router';
import { of } from 'rxjs';
import { provideTanStackQuery, QueryClient } from '@tanstack/angular-query-experimental';
import { CatalogUnit, OrdersService, SupplierOrder } from '../../core/services/orders.service';
import { PedidoEditorComponent } from './pedido-editor.component';

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const unit = (over: Partial<CatalogUnit> = {}): CatalogUnit => ({
  key: 'pack:1', kind: 'pack', packId: 1, sku: null, name: 'Cuadernos inteligentes', code: '4410', description: 'CUADERNO X8',
  unitsPerPack: 8, mode: 'assorted', price: 96000,
  members: [
    { sku: 'A', label: 'A5 rayado', stockMl: 0, stockTn: 0, stockEffective: 0, depositoStock: 8, threshold: 2, alertState: 'out' },
    { sku: 'B', label: 'A4', stockMl: 6, stockTn: 6, stockEffective: 6, depositoStock: null, threshold: 2, alertState: 'watching' },
  ],
  alerted: true, suggestedQty: 2, depositoStock: 8, lastOrder: null, pendingOrder: null, ...over,
});

const draft = (over: Partial<SupplierOrder> = {}): SupplierOrder => ({
  id: 17, name: 'Pedido octubre', status: 'borrador', partial: false, discount1: 25, discount2: 5, note: '', basedOnId: null,
  createdAt: '2026-10-08T00:00:00Z', updatedAt: null, orderedAt: null, receivedAt: null, lines: [],
  totals: { lineCount: 0, packs: 0, subtotal: 0, discount1Amount: 0, discount2Amount: 0, total: 0, missingPrices: 0 },
  ...over,
});

class OrdersMock {
  current = draft();
  get = jasmine.createSpy('get').and.callFake(() => Promise.resolve(this.current));
  catalog = jasmine.createSpy('catalog').and.callFake(() => Promise.resolve({
    units: [unit(), unit({ key: 'sku:LG', kind: 'sku', packId: null, sku: 'LG', name: 'Lapicera', code: 'GEL', price: 14400, unitsPerPack: 12, alerted: false, suggestedQty: null, members: [] })],
  }));
  saveDraft = jasmine.createSpy('saveDraft').and.callFake((_id: number, input: SupplierOrder) => Promise.resolve({ ...this.current, ...input }));
  place = jasmine.createSpy('place').and.callFake(() => Promise.resolve({ ...this.current, status: 'pendiente' }));
  receive = jasmine.createSpy('receive').and.callFake(() => Promise.resolve({ ...this.current, status: 'recibido', partial: true }));
  duplicate = jasmine.createSpy('duplicate').and.resolveTo(draft({ id: 18 }));
  delete = jasmine.createSpy('delete').and.resolveTo(undefined);
}

describe('PedidoEditorComponent', () => {
  let fixture: ComponentFixture<PedidoEditorComponent>;
  let component: PedidoEditorComponent;
  let orders: OrdersMock;

  async function create(order: SupplierOrder): Promise<void> {
    orders = new OrdersMock();
    orders.current = order;
    await TestBed.configureTestingModule({
      imports: [PedidoEditorComponent],
      providers: [
        provideRouter([]),
        provideTanStackQuery(new QueryClient({ defaultOptions: { queries: { gcTime: 0, retry: false } } })),
        { provide: OrdersService, useValue: orders },
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ id: String(order.id) })) } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(PedidoEditorComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  }

  it('agregar desde el catálogo usa la cantidad sugerida, marca "alerta" y recalcula el total', async () => {
    await create(draft());
    component.addUnit(component.catalogUnits()[0]);
    const line = component.order()!.lines[0];
    expect(line.qty).toBe(2);
    expect(line.origin).toBe('alerta');
    expect(component.totals()!.subtotal).toBe(192000);
    expect(component.qtyInOrder().get('pack:1')).toBe(2);
  });

  it('un pack con alerta muestra todos sus modelos', async () => {
    await create(draft());
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('A5 rayado');
    expect(text).toContain('A4');
    expect(text).toContain('1 de 2 con stock');
  });

  it('filtro "Con alerta" esconde lo que no avisó; "Todos" lo muestra', async () => {
    await create(draft());
    expect(component.visibleUnits().map((u) => u.key)).toEqual(['pack:1']);
    component.catalogFilter.set('all');
    expect(component.visibleUnits().length).toBe(2);
  });

  it('pisar el precio lo marca editado; volver lo trae de Precios', async () => {
    await create(draft());
    component.addUnit(component.catalogUnits()[0]);
    component.setLinePrice(0, 99000);
    expect(component.order()!.lines[0]).toEqual(jasmine.objectContaining({ unitPrice: 99000, priceSource: 'manual' }));
    component.revertLinePrice(0);
    expect(component.order()!.lines[0]).toEqual(jasmine.objectContaining({ unitPrice: 96000, priceSource: 'precios' }));
  });

  it('autoguarda el borrador después de editar', async () => {
    await create(draft());
    component.setName('Pedido agendas');
    expect(component.saveState()).toBe('pending');
    await settle(800);
    expect(orders.saveDraft).toHaveBeenCalledWith(17, jasmine.objectContaining({ name: 'Pedido agendas' }));
    expect(component.saveState()).toBe('saved');
  });

  it('"Agregar sugeridos" solo suma lo que avisó y no está en el pedido', async () => {
    await create(draft());
    component.addAllSuggested();
    component.addAllSuggested();
    expect(component.order()!.lines.length).toBe(1);
  });

  it('ítem libre: se agrega editable y no sigue a Precios', async () => {
    await create(draft());
    component.addFreeItem();
    expect(component.order()!.lines[0]).toEqual(jasmine.objectContaining({ kind: 'free', origin: 'libre', priceSource: 'manual' }));
  });

  it('marcar como pedido guarda antes y pasa a pendiente', async () => {
    await create(draft({ lines: [{ id: 1, kind: 'pack', packId: 1, sku: null, code: '4410', description: 'X', detail: '', qty: 1, unitPrice: 96000, priceSource: 'precios', unitsPerPack: 8, origin: 'manual', receivedQty: null }] }));
    component.setLineQty(0, 3);
    component.openSheetAfterPlace = false;
    await component.place();
    expect(orders.saveDraft).toHaveBeenCalled();
    expect(orders.place).toHaveBeenCalledWith(17);
    expect(component.order()!.status).toBe('pendiente');
  });

  it('recepción: "Llegó todo" completa cada línea; cerrar incompleto crea el borrador de faltantes', async () => {
    const lines = [
      { id: 10, kind: 'pack' as const, packId: 1, sku: null, code: 'A', description: 'A', detail: '', qty: 2, unitPrice: 1, priceSource: 'precios' as const, unitsPerPack: 8, origin: 'manual' as const, receivedQty: null },
      { id: 11, kind: 'pack' as const, packId: 2, sku: null, code: 'B', description: 'B', detail: '', qty: 3, unitPrice: 1, priceSource: 'precios' as const, unitsPerPack: 8, origin: 'manual' as const, receivedQty: null },
    ];
    await create(draft({ status: 'pendiente', lines }));
    component.startReceiving();
    component.allArrived();
    expect(component.received()).toEqual({ 10: 2, 11: 3 });
    component.setReceived(lines[1], 1);
    expect(component.shortLines().map((s) => s.got)).toEqual([1]);
    await component.closeReceiving();
    expect(orders.receive).toHaveBeenCalledWith(17, { 10: 2, 11: 1 }, true);
    expect(orders.duplicate).toHaveBeenCalledWith(17, { mode: 'missing' });
    expect(component.missingDraftId()).toBe(18);
  });

  it('un pedido mandado no se edita', async () => {
    await create(draft({ status: 'pendiente' }));
    component.setName('otro');
    expect(component.order()!.name).toBe('Pedido octubre');
    expect(fixture.nativeElement.querySelector('.catalog')).toBeNull();
  });
});
