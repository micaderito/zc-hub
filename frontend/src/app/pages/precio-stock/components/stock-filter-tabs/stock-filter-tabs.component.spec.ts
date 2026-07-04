import { ComponentFixture, TestBed } from '@angular/core/testing';

import { StockFilterTabsComponent, StockFilter, StockSummary } from './stock-filter-tabs.component';

describe('StockFilterTabsComponent', () => {
  let fixture: ComponentFixture<StockFilterTabsComponent>;
  let component: StockFilterTabsComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [StockFilterTabsComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(StockFilterTabsComponent);
    component = fixture.componentInstance;
  });

  function setInputs(filter: StockFilter, summary?: StockSummary) {
    fixture.componentRef.setInput('filter', filter);
    if (summary) fixture.componentRef.setInput('summary', summary);
    fixture.detectChanges();
  }

  it('debería renderizar las 5 pestañas con sus etiquetas', () => {
    setInputs('all');

    const tabs = fixture.nativeElement.querySelectorAll('[role="tab"]');
    expect(tabs.length).toBe(5);
    expect(fixture.nativeElement.textContent).toContain('Todos');
    expect(fixture.nativeElement.textContent).toContain('Stock distinto');
    expect(fixture.nativeElement.textContent).toContain('Mismo stock');
    expect(fixture.nativeElement.textContent).toContain('Sin stock');
    expect(fixture.nativeElement.textContent).toContain('Con stock');
  });

  it('debería mostrar 0 en todos los contadores cuando no hay summary', () => {
    setInputs('all');

    const counts = fixture.nativeElement.querySelectorAll('.tab-count');
    counts.forEach((c: HTMLElement) => expect(c.textContent?.trim()).toBe('0'));
  });

  it('debería mostrar los contadores del summary provisto', () => {
    const summary: StockSummary = { total: 40, mismatch: 5, synced: 30, noStock: 3, withStock: 37 };
    setInputs('all', summary);

    const counts = fixture.nativeElement.querySelectorAll('.tab-count');
    expect(counts[0].textContent?.trim()).toBe('40');
    expect(counts[1].textContent?.trim()).toBe('5');
    expect(counts[2].textContent?.trim()).toBe('30');
    expect(counts[3].textContent?.trim()).toBe('3');
    expect(counts[4].textContent?.trim()).toBe('37');
  });

  it('debería marcar como activa la pestaña correspondiente al filter actual', () => {
    setInputs('mismatch', { total: 10, mismatch: 2, synced: 8, noStock: 0, withStock: 10 });

    const tabs: HTMLElement[] = Array.from(fixture.nativeElement.querySelectorAll('[role="tab"]'));
    const activeTab = tabs.find((t) => t.classList.contains('active'));
    expect(activeTab?.textContent).toContain('Stock distinto');
  });

  it('debería aplicar la variante "warn" al contador de "Stock distinto" y "ok" a "Mismo stock"/"Con stock"', () => {
    const summary: StockSummary = { total: 10, mismatch: 2, synced: 8, noStock: 0, withStock: 10 };
    setInputs('all', summary);

    const counts = fixture.nativeElement.querySelectorAll('.tab-count');
    expect(counts[1].classList.contains('warn')).toBeTrue();
    expect(counts[2].classList.contains('ok')).toBeTrue();
    expect(counts[4].classList.contains('ok')).toBeTrue();
    expect(counts[0].classList.contains('ok')).toBeFalse();
    expect(counts[0].classList.contains('warn')).toBeFalse();
  });

  it('debería emitir filterChange con la key correspondiente al hacer click en una pestaña', () => {
    setInputs('all');

    let emitted: StockFilter | undefined;
    component.filterChange.subscribe((v) => (emitted = v));

    const tabs: HTMLElement[] = Array.from(fixture.nativeElement.querySelectorAll('[role="tab"]'));
    tabs[3].click();

    expect(emitted).toBe('no-stock');
  });

  it('onTabChange debería castear la key y emitir filterChange', () => {
    setInputs('all');

    let emitted: StockFilter | undefined;
    component.filterChange.subscribe((v) => (emitted = v));

    component.onTabChange('synced');

    expect(emitted).toBe('synced');
  });
});
