import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { provideTanStackQuery, QueryClient } from '@tanstack/angular-query-experimental';
import { OrderSupplier, OrdersService, SupplierOrder } from '../../core/services/orders.service';
import { PedidosListComponent } from './pedidos-list.component';

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const order = (over: Partial<SupplierOrder> = {}): SupplierOrder => ({
  id: 1, name: 'Pedido', status: 'borrador', partial: false, discount1: 25, discount2: 5, note: '', basedOnId: null,
  supplierKey: 'punto_cero', createdAt: '2026-10-08T00:00:00Z', updatedAt: null, orderedAt: null, receivedAt: null, lines: [],
  totals: { lineCount: 0, packs: 0, subtotal: 0, discount1Amount: 0, discount2Amount: 0, total: 0, missingPrices: 0 },
  ...over,
});

const PC: OrderSupplier = { key: 'punto_cero', name: 'Punto Cero', profileName: 'General', discount1: 25, discount2: 5 };
const FILGO: OrderSupplier = { key: 'filgo', name: 'Filgo', profileName: 'Sin descuento', discount1: 0, discount2: 0 };

describe('PedidosListComponent', () => {
  let fixture: ComponentFixture<PedidosListComponent>;
  let component: PedidosListComponent;
  let orders: jasmine.SpyObj<OrdersService>;

  async function create(suppliers: OrderSupplier[]): Promise<void> {
    orders = jasmine.createSpyObj<OrdersService>('OrdersService', ['list', 'suppliers', 'create', 'duplicate']);
    orders.list.and.resolveTo({ orders: [order(), order({ id: 2, supplierKey: 'filgo', status: 'pendiente' })] });
    orders.suppliers.and.resolveTo({ suppliers });
    orders.create.and.callFake(async (opts = {}) => order({ id: 9, supplierKey: opts.supplierKey ?? 'punto_cero' }));
    await TestBed.configureTestingModule({
      imports: [PedidosListComponent],
      providers: [
        provideRouter([]),
        provideTanStackQuery(new QueryClient({ defaultOptions: { queries: { gcTime: 0, retry: false } } })),
        { provide: OrdersService, useValue: orders },
      ],
    }).compileComponents();
    spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    fixture = TestBed.createComponent(PedidosListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  }

  it('filtra por proveedor (y los chips de estado cuentan sobre ese proveedor)', async () => {
    await create([PC, FILGO]);
    expect(component.visibleOrders().length).toBe(2);
    component.supplierFilter.set('filgo');
    expect(component.visibleOrders().map((o) => o.id)).toEqual([2]);
    expect(component.counts()['borrador']).toBe(0);
    expect(component.counts()['pendiente']).toBe(1);
    expect(fixture.nativeElement.textContent).toContain('Punto Cero');
  });

  it('"Nuevo pedido" con varios proveedores pide elegir y crea para el elegido', async () => {
    await create([PC, FILGO]);
    component.supplierFilter.set('filgo');
    component.newOrder();
    expect(component.choosingSupplier()).toBeTrue();
    expect(component.newSupplierKey).toBe('filgo', 'arranca en el proveedor filtrado');
    await component.createFor('filgo');
    expect(orders.create).toHaveBeenCalledWith({ supplierKey: 'filgo' });
    expect(TestBed.inject(Router).navigate).toHaveBeenCalledWith(['/pedidos', 9]);
  });

  it('con un solo proveedor crea directo, sin preguntar', async () => {
    await create([PC]);
    component.newOrder();
    await settle();
    expect(component.choosingSupplier()).toBeFalse();
    expect(orders.create).toHaveBeenCalledWith({ supplierKey: 'punto_cero' });
  });
});
