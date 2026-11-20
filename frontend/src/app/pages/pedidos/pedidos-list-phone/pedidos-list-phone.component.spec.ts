import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { SupplierOrder } from '../../../core/services/orders.service';
import { PedidosListPhoneComponent, RECEIVED_PREVIEW } from './pedidos-list-phone.component';

const order = (over: Partial<SupplierOrder> = {}): SupplierOrder => ({
  id: 1, name: 'Pedido', status: 'borrador', partial: false, discount1: 25, discount2: 5, note: '', basedOnId: null,
  supplierKey: 'pc', createdAt: '2026-10-08T00:00:00Z', updatedAt: null, orderedAt: null, receivedAt: null, lines: [],
  totals: { lineCount: 2, packs: 5, subtotal: 0, discount1Amount: 0, discount2Amount: 0, total: 1000, missingPrices: 0 },
  ...over,
});

describe('PedidosListPhoneComponent', () => {
  let fixture: ComponentFixture<PedidosListPhoneComponent>;
  let component: PedidosListPhoneComponent;

  function create(orders: SupplierOrder[]): void {
    TestBed.configureTestingModule({ imports: [PedidosListPhoneComponent], providers: [provideRouter([])] });
    fixture = TestBed.createComponent(PedidosListPhoneComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('orders', orders);
    fixture.componentRef.setInput('suppliers', [{ key: 'pc', name: 'Punto Cero', profileName: null, discount1: null, discount2: null }]);
    fixture.detectChanges();
  }

  const text = () => fixture.nativeElement.textContent as string;
  const sectionTitles = () => Array.from(fixture.nativeElement.querySelectorAll('.pl-section span:first-child') as NodeListOf<HTMLElement>).map((e) => e.textContent!.trim());

  it('cuenta por estado y separa en secciones, lo que está en camino primero', () => {
    create([
      order({ id: 1, name: 'Borrador nov' }),
      order({ id: 2, name: 'Agendas', status: 'pendiente', orderedAt: '2026-11-10T00:00:00Z' }),
      order({ id: 3, name: 'Octubre', status: 'recibido', partial: true, orderedAt: '2026-10-01T00:00:00Z', receivedAt: '2026-10-14T00:00:00Z' }),
    ]);
    expect(component.counts()).toEqual({ borrador: 1, pendiente: 1, recibido: 1 });
    expect(sectionTitles()).toEqual(['En camino', 'Borradores', 'Recibidos']);
    expect(text()).toContain('Punto Cero');
    expect(text()).toContain('incompleto');
    expect(fixture.nativeElement.querySelector('.pl-card').getAttribute('href')).toBe('/pedidos/2');
  });

  it('tocar un número filtra esa sección; tocarlo de nuevo vuelve a todas', () => {
    create([order(), order({ id: 2, status: 'pendiente', orderedAt: '2026-11-10T00:00:00Z' })]);
    const tiles = fixture.nativeElement.querySelectorAll('.pl-tile') as NodeListOf<HTMLButtonElement>;
    tiles[1].click(); // En camino
    fixture.detectChanges();
    expect(sectionTitles()).toEqual(['En camino']);
    tiles[1].click();
    fixture.detectChanges();
    expect(sectionTitles().length).toBe(2);
  });

  it('los recibidos se cortan y "Ver más" muestra el resto', () => {
    const received = Array.from({ length: RECEIVED_PREVIEW + 3 }, (_, i) => order({ id: i + 1, status: 'recibido', orderedAt: '2026-09-01T00:00:00Z' }));
    create(received);
    expect(fixture.nativeElement.querySelectorAll('.pl-card').length).toBe(RECEIVED_PREVIEW);
    (fixture.nativeElement.querySelector('.pl-more') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.pl-card').length).toBe(RECEIVED_PREVIEW + 3);
  });

  it('dice hace cuánto se pidió y avisa una recepción a medias', () => {
    const o = order({ status: 'pendiente', orderedAt: '2026-11-10T12:00:00Z', lines: [
      { id: 1, kind: 'sku', packId: null, sku: 'A', code: 'A', description: 'A', detail: '', qty: 2, unitPrice: null, priceSource: 'precios', unitsPerPack: 1, origin: 'manual', receivedQty: 1 },
    ] });
    create([o]);
    expect(component.daysAgo(o, new Date('2026-11-19T12:00:00Z').getTime())).toBe('hace 9 días');
    expect(component.daysAgo(o, new Date('2026-11-11T13:00:00Z').getTime())).toBe('ayer');
    expect(text()).toContain('recepción a medias');
  });

  it('sin pedidos invita a crear el primero', () => {
    create([]);
    fixture.componentRef.setInput('hasAny', false);
    fixture.detectChanges();
    expect(text()).toContain('Todavía no hay pedidos');
  });
});
