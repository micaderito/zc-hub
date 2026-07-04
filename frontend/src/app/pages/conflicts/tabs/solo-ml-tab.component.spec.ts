import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SoloMlTabComponent } from './solo-ml-tab.component';
import { MlRow } from '../../../core/services/conflicts.service';

function makeMlRow(overrides: Partial<MlRow> = {}): MlRow {
  return {
    type: 'ml',
    itemId: 'MLA123',
    variationId: null,
    title: 'Cuaderno Rivadavia Tapa Dura',
    sku: null,
    hasSku: false,
    price: 5000,
    stock: 10,
    thumbnail: null,
    ...overrides,
  };
}

describe('SoloMlTabComponent', () => {
  let fixture: ComponentFixture<SoloMlTabComponent>;
  let component: SoloMlTabComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SoloMlTabComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(SoloMlTabComponent);
    component = fixture.componentInstance;
  });

  function setRows(rows: MlRow[], paging = { page: 1, limit: 25, total: rows.length, pages: 1 }) {
    component.rows = rows;
    component.paging = paging;
    fixture.detectChanges();
  }

  it('debería mostrar el hint con el total en plural', () => {
    setRows([makeMlRow(), makeMlRow({ itemId: 'MLA2' })]);

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.tab-hint')?.textContent).toContain('2 publicaciones de ML sin par en TN');
  });

  it('debería mostrar el hint en singular cuando hay una sola publicación', () => {
    setRows([makeMlRow()]);

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.tab-hint')?.textContent).toContain('1 publicación de ML sin par en TN');
  });

  it('debería renderizar una fila zc-conflict-row por cada publicación', () => {
    setRows([makeMlRow(), makeMlRow({ itemId: 'MLA2', title: 'Repuesto A4' })]);

    const rows = fixture.nativeElement.querySelectorAll('zc-conflict-row');
    expect(rows.length).toBe(2);
    expect(rows[1].textContent).toContain('Repuesto A4');
  });

  it('debería mostrar el nombre con variante cuando la fila tiene variationId', () => {
    setRows([makeMlRow({ variationId: 'V1', variationName: 'Negro · A4' })]);

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.row-name')?.textContent).toContain('Cuaderno Rivadavia Tapa Dura (Negro · A4)');
  });

  it('debería mostrar el mensaje de "sin resultados" cuando no hay filas', () => {
    setRows([]);

    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('Sin resultados para la búsqueda.');
  });

  it('debería emitir editSku con canal mercadolibre al hacer click en "Editar SKU"', () => {
    const row = makeMlRow();
    setRows([row]);

    let emitted: { channel: string; row: MlRow } | undefined;
    component.editSku.subscribe((v) => (emitted = v));

    const btn = fixture.nativeElement.querySelector('.btn-action.ghost') as HTMLButtonElement;
    btn.click();

    expect(emitted?.channel).toBe('mercadolibre');
    expect(emitted?.row).toEqual(row);
  });

  it('debería emitir linkFromMl al hacer click en "Vincular"', () => {
    const row = makeMlRow();
    setRows([row]);

    let emitted: MlRow | undefined;
    component.linkFromMl.subscribe((v) => (emitted = v));

    const btn = fixture.nativeElement.querySelector('.btn-action.link-btn') as HTMLButtonElement;
    btn.click();

    expect(emitted).toEqual(row);
  });

  it('debería emitir pageChange al ir a la página anterior', () => {
    setRows([makeMlRow()], { page: 2, limit: 25, total: 50, pages: 2 });

    let emittedPage: number | undefined;
    component.pageChange.subscribe((p) => (emittedPage = p));

    const prevBtn = fixture.nativeElement.querySelectorAll('zc-pagination button.page-btn')[0] as HTMLButtonElement;
    prevBtn.click();

    expect(emittedPage).toBe(1);
  });
});
