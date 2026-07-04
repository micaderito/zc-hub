import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SoloTnTabComponent } from './solo-tn-tab.component';
import { TnRow } from '../../../core/services/conflicts.service';

function makeTnRow(overrides: Partial<TnRow> = {}): TnRow {
  return {
    type: 'tn',
    productId: 1,
    variantId: 1,
    productName: 'Cuaderno Rivadavia Tapa Dura',
    sku: null,
    hasSku: false,
    price: 5000,
    stock: 10,
    thumbnail: null,
    ...overrides,
  };
}

describe('SoloTnTabComponent', () => {
  let fixture: ComponentFixture<SoloTnTabComponent>;
  let component: SoloTnTabComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SoloTnTabComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(SoloTnTabComponent);
    component = fixture.componentInstance;
  });

  function setRows(rows: TnRow[], paging = { page: 1, limit: 25, total: rows.length, pages: 1 }) {
    component.rows = rows;
    component.paging = paging;
    fixture.detectChanges();
  }

  it('debería mostrar el hint con el total en plural', () => {
    setRows([makeTnRow(), makeTnRow({ productId: 2, variantId: 2 })]);

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.tab-hint')?.textContent).toContain('2 variantes de TN sin par en ML');
  });

  it('debería mostrar el hint en singular cuando hay una sola variante', () => {
    setRows([makeTnRow()]);

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.tab-hint')?.textContent).toContain('1 variante de TN sin par en ML');
  });

  it('debería renderizar una fila zc-conflict-row por cada variante', () => {
    setRows([makeTnRow(), makeTnRow({ productId: 2, variantId: 2, productName: 'Repuesto A4' })]);

    const rows = fixture.nativeElement.querySelectorAll('zc-conflict-row');
    expect(rows.length).toBe(2);
    expect(rows[1].textContent).toContain('Repuesto A4');
  });

  it('debería mostrar el nombre con variante cuando la fila tiene variantName', () => {
    setRows([makeTnRow({ variantName: 'A4 · Raya' })]);

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.row-name')?.textContent).toContain('Cuaderno Rivadavia Tapa Dura (A4 · Raya)');
  });

  it('debería mostrar el mensaje de "sin resultados" cuando no hay filas', () => {
    setRows([]);

    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('Sin resultados para la búsqueda.');
  });

  it('debería emitir editSku con canal tiendanube al hacer click en "Editar SKU"', () => {
    const row = makeTnRow();
    setRows([row]);

    let emitted: { channel: string; row: TnRow } | undefined;
    component.editSku.subscribe((v) => (emitted = v));

    const btn = fixture.nativeElement.querySelector('.btn-action.ghost') as HTMLButtonElement;
    btn.click();

    expect(emitted?.channel).toBe('tiendanube');
    expect(emitted?.row).toEqual(row);
  });

  it('debería emitir linkFromTn al hacer click en "Vincular"', () => {
    const row = makeTnRow();
    setRows([row]);

    let emitted: TnRow | undefined;
    component.linkFromTn.subscribe((v) => (emitted = v));

    const btn = fixture.nativeElement.querySelector('.btn-action.link-btn') as HTMLButtonElement;
    btn.click();

    expect(emitted).toEqual(row);
  });

  it('debería emitir pageChange al ir a la página siguiente', () => {
    setRows([makeTnRow()], { page: 1, limit: 25, total: 50, pages: 2 });

    let emittedPage: number | undefined;
    component.pageChange.subscribe((p) => (emittedPage = p));

    const nextBtn = fixture.nativeElement.querySelectorAll('zc-pagination button.page-btn')[1] as HTMLButtonElement;
    nextBtn.click();

    expect(emittedPage).toBe(2);
  });
});
