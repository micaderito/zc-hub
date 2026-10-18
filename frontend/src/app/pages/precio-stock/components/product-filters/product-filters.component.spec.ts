import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ProductFiltersComponent, ProductFiltersValue, StockSummary } from './product-filters.component';

describe('ProductFiltersComponent', () => {
  let fixture: ComponentFixture<ProductFiltersComponent>;
  let component: ProductFiltersComponent;
  let emitted: ProductFiltersValue[];

  const base: ProductFiltersValue = { stock: 'all', supplier: '', alert: 'all', pack: 'all' };
  const suppliers = [{ key: 'punto_cero', name: 'Punto Cero' }, { key: 'bic', name: 'Bic' }];

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [ProductFiltersComponent] }).compileComponents();
    fixture = TestBed.createComponent(ProductFiltersComponent);
    component = fixture.componentInstance;
    emitted = [];
    component.valueChange.subscribe((v) => emitted.push(v));
  });

  function render(value: Partial<ProductFiltersValue> = {}, summary?: StockSummary) {
    fixture.componentRef.setInput('value', { ...base, ...value });
    fixture.componentRef.setInput('suppliers', suppliers);
    if (summary) fixture.componentRef.setInput('summary', summary);
    fixture.detectChanges();
  }

  const el = () => fixture.nativeElement as HTMLElement;
  const buttons = (sel: string) => Array.from(el().querySelectorAll<HTMLButtonElement>(sel));

  it('muestra los 5 filtros de stock con sus conteos y marca el activo', () => {
    render({ stock: 'mismatch' }, { total: 40, mismatch: 5, synced: 30, noStock: 3, withStock: 37 });
    const stock = buttons('.sseg button');
    expect(stock.map((b) => b.querySelector('.cnt')!.textContent!.trim())).toEqual(['40', '5', '30', '3', '37']);
    expect(stock.find((b) => b.classList.contains('sel'))!.textContent).toContain('Stock distinto');
  });

  it('elegir un filtro de stock emite el valor completo', () => {
    render({ supplier: 'bic' });
    buttons('.sseg button')[3].click();
    expect(emitted).toEqual([{ ...base, supplier: 'bic', stock: 'no-stock' }]);
  });

  it('el menú de proveedor ofrece Todos, Sin proveedor y cada proveedor', () => {
    render();
    buttons('.fbtn')[0].click();
    fixture.detectChanges();
    const opts = buttons('.pop .o').map((b) => b.textContent!.trim());
    expect(opts).toEqual(['Todos', 'Sin proveedor', 'Punto Cero', 'Bic']);
    buttons('.pop .o')[1].click();
    fixture.detectChanges();
    expect(emitted.at(-1)).toEqual({ ...base, supplier: 'none' });
    expect(el().querySelector('.pop')).toBeNull();
  });

  it('con un proveedor elegido muestra su nombre y la × lo saca', () => {
    render({ supplier: 'punto_cero' });
    expect(buttons('.fbtn')[0].textContent).toContain('Punto Cero');
    expect(buttons('.fbtn')[0].classList).toContain('on');
    el().querySelector<HTMLButtonElement>('.fclear')!.click();
    expect(emitted.at(-1)).toEqual(base);
  });

  it('Alerta y Pack: Con / Sin y su rótulo', () => {
    render();
    buttons('.fbtn')[1].click();
    fixture.detectChanges();
    expect(buttons('.pop .o').map((b) => b.textContent!.trim())).toEqual(['Todas', 'Con alerta', 'Sin alerta']);
    buttons('.pop .o')[2].click();
    expect(emitted.at(-1)).toEqual({ ...base, alert: 'without' });

    render({ pack: 'with' });
    expect(buttons('.fbtn')[2].textContent).toContain('En un pack');
  });

  it('Limpiar saca proveedor, alerta y pack pero deja el filtro de stock', () => {
    render();
    expect(el().querySelector('.clear')).toBeNull();
    render({ stock: 'synced', supplier: 'bic', alert: 'with', pack: 'without' });
    el().querySelector<HTMLButtonElement>('.clear')!.click();
    expect(emitted.at(-1)).toEqual({ ...base, stock: 'synced' });
  });

  it('un clic afuera o Esc cierra el menú', () => {
    render();
    buttons('.fbtn')[0].click();
    fixture.detectChanges();
    expect(component.open()).toBe('supplier');
    document.body.click();
    expect(component.open()).toBeNull();

    buttons('.fbtn')[1].click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(component.open()).toBeNull();
  });
});
