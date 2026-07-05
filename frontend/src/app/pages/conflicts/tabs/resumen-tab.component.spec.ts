import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ResumenTabComponent } from './resumen-tab.component';
import { ConflictAnalysis, MlRow, TnRow } from '../../../core/services/conflicts.service';

function makeMlRow(overrides: Partial<MlRow> = {}): MlRow {
  return {
    type: 'ml',
    itemId: 'MLA123',
    variationId: null,
    title: 'Cuaderno Rivadavia Tapa Dura',
    sku: 'CUAD-RIV-01',
    hasSku: true,
    price: 5000,
    stock: 10,
    thumbnail: null,
    ...overrides,
  };
}

function makeTnRow(overrides: Partial<TnRow> = {}): TnRow {
  return {
    type: 'tn',
    productId: 1,
    variantId: 1,
    productName: 'Cuaderno Rivadavia Tapa Dura',
    sku: 'CUAD-RIV-01',
    hasSku: true,
    price: 5000,
    stock: 10,
    thumbnail: null,
    ...overrides,
  };
}

function makeAnalysis(overrides: Partial<ConflictAnalysis> = {}): ConflictAnalysis {
  return {
    mlConnected: true,
    tnConnected: true,
    summary: {
      matched: 0,
      onlyML: 0,
      onlyTN: 0,
      noSkuML: 0,
      noSkuTN: 0,
      duplicateSkuML: 0,
      duplicateSkuTN: 0,
      resolved: 0,
    },
    matched: [],
    onlyML: [],
    onlyTN: [],
    noSkuML: [],
    noSkuTN: [],
    duplicateSkuML: [],
    duplicateSkuTN: [],
    mappings: [],
    paging: { page: 1, limit: 25, total: 0, pages: 1 },
    ...overrides,
  };
}

describe('ResumenTabComponent', () => {
  let fixture: ComponentFixture<ResumenTabComponent>;
  let component: ResumenTabComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ResumenTabComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(ResumenTabComponent);
    component = fixture.componentInstance;
  });

  it('debería mostrar la cantidad de coincidencias', () => {
    component.analysis = makeAnalysis({
      matched: [{ ml: makeMlRow(), tn: makeTnRow() }, { ml: makeMlRow({ itemId: 'MLA124' }), tn: makeTnRow({ productId: 2 }) }],
    });
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.item-ok .resumen-title')?.textContent).toContain('Coincidencias (2)');
  });

  it('debería sumar onlyML y onlyTN para "Solo en un canal"', () => {
    component.analysis = makeAnalysis({
      onlyML: [makeMlRow()],
      onlyTN: [makeTnRow(), makeTnRow({ productId: 2 })],
    });
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    const items = el.querySelectorAll('.resumen-item');
    expect(items[1].textContent).toContain('Solo en un canal (3)');
  });

  it('debería sumar noSkuML y noSkuTN para "Sin SKU"', () => {
    component.analysis = makeAnalysis({
      noSkuML: [makeMlRow({ sku: null, hasSku: false })],
      noSkuTN: [],
    });
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    const items = el.querySelectorAll('.resumen-item');
    expect(items[2].textContent).toContain('Sin SKU (1)');
  });

  it('debería sumar duplicateSkuML y duplicateSkuTN para "SKU duplicados"', () => {
    component.analysis = makeAnalysis({
      duplicateSkuML: [{ sku: 'DUP-1', items: [makeMlRow(), makeMlRow({ itemId: 'MLA999' })] }],
      duplicateSkuTN: [{ sku: 'DUP-2', items: [makeTnRow()] }],
    });
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    const items = el.querySelectorAll('.resumen-item');
    expect(items[3].textContent).toContain('SKU duplicados (2)');
  });

  it('debería mostrar 0 en todas las categorías cuando el análisis está vacío', () => {
    component.analysis = makeAnalysis();
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('Coincidencias (0)');
    expect(el.textContent).toContain('Solo en un canal (0)');
    expect(el.textContent).toContain('Sin SKU (0)');
    expect(el.textContent).toContain('SKU duplicados (0)');
  });
});
