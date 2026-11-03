import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { CatalogMember, CatalogUnit } from '../../../core/services/orders.service';
import { AlertasDisparadasComponent } from './alertas-disparadas.component';

const member = (over: Partial<CatalogMember> = {}): CatalogMember => ({
  sku: 'A', label: 'Cuaderno A5', stockMl: 1, stockTn: 1, stockEffective: 1, depositoStock: null, threshold: 3, alertState: 'still-low', ...over,
});

const unit = (over: Partial<CatalogUnit> = {}): CatalogUnit => ({
  key: 'sku:A', kind: 'sku', packId: null, sku: 'A', name: 'Cuaderno A5', code: 'C-1', description: 'CUADERNO',
  unitsPerPack: 1, mode: 'bulk', price: null, members: [member()], alerted: true, suggestedQty: 2,
  depositoStock: null, lastOrder: null, pendingOrder: null, suppliers: ['pc'], priceSupplier: 'pc', ...over,
});

describe('AlertasDisparadasComponent', () => {
  let fixture: ComponentFixture<AlertasDisparadasComponent>;
  let component: AlertasDisparadasComponent;

  function create(units: CatalogUnit[]): void {
    TestBed.configureTestingModule({ imports: [AlertasDisparadasComponent], providers: [provideRouter([])] });
    fixture = TestBed.createComponent(AlertasDisparadasComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('units', units);
    fixture.componentRef.setInput('suppliers', [{ key: 'pc', name: 'Punto Cero', profileName: null, discount1: null, discount2: null }]);
    fixture.detectChanges();
  }

  it('muestra solo lo que tiene alerta, sin stock primero', () => {
    create([
      unit(),
      unit({ key: 'sku:B', sku: 'B', name: 'Lapicera', members: [member({ sku: 'B', label: 'Lapicera', stockEffective: 0, stockMl: 0, stockTn: 0, alertState: 'out' })] }),
      unit({ key: 'sku:C', sku: 'C', name: 'Notas', alerted: false, members: [member({ sku: 'C', alertState: 'watching', stockEffective: 9 })] }),
    ]);
    expect(component.visible().map((u) => u.key)).toEqual(['sku:B', 'sku:A']);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Lapicera');
    expect(text).toContain('Punto Cero');
    expect(text).not.toContain('Notas');
  });

  it('un pack muestra cuántos modelos avisaron y se puede plegar', () => {
    const pack = unit({
      key: 'pack:1', kind: 'pack', packId: 1, sku: null, name: 'Cuadernos surtidos', mode: 'assorted', unitsPerPack: 8,
      members: [member(), member({ sku: 'X', label: 'A4', stockEffective: 6, alertState: 'watching' })],
    });
    create([pack]);
    expect(fixture.nativeElement.textContent).toContain('1 de 2 con alerta');
    expect(component.isOpen(pack)).toBeTrue();
    component.toggle(pack);
    expect(component.isOpen(pack)).toBeFalse();
  });

  it('filtra por proveedor y "sin proveedor"', () => {
    create([unit(), unit({ key: 'sku:Z', sku: 'Z', name: 'Suelto', suppliers: [], members: [member({ sku: 'Z' })] })]);
    component.supplierFilter.set('none');
    expect(component.visible().map((u) => u.key)).toEqual(['sku:Z']);
    component.supplierFilter.set('pc');
    expect(component.visible().map((u) => u.key)).toEqual(['sku:A']);
  });

  it('marca lo que ya está en camino', () => {
    create([unit({ pendingOrder: { orderId: 12, orderName: 'Octubre' } })]);
    expect(fixture.nativeElement.textContent).toContain('en camino · #12');
  });

  it('sin alertas lo dice', () => {
    create([]);
    expect(fixture.nativeElement.textContent).toContain('No hay productos con el stock en el umbral o por debajo');
  });
});
