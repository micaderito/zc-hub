import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SinSkuTabComponent } from './sin-sku-tab.component';
import { MlRow, TnRow } from '../../../core/services/conflicts.service';

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

function makeTnRow(overrides: Partial<TnRow> = {}): TnRow {
  return {
    type: 'tn',
    productId: 1,
    variantId: 1,
    productName: 'Repuesto A4 removible',
    sku: null,
    hasSku: false,
    price: 5000,
    stock: 10,
    thumbnail: null,
    ...overrides,
  };
}

describe('SinSkuTabComponent', () => {
  let fixture: ComponentFixture<SinSkuTabComponent>;
  let component: SinSkuTabComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SinSkuTabComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(SinSkuTabComponent);
    component = fixture.componentInstance;
  });

  function setRows(noSkuML: MlRow[], noSkuTN: TnRow[]) {
    component.noSkuML = noSkuML;
    component.noSkuTN = noSkuTN;
    fixture.detectChanges();
  }

  it('debería mostrar el hint general', () => {
    setRows([], []);

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.tab-hint')?.textContent).toContain('Productos sin SKU en ML o TN');
  });

  it('debería mostrar el bloque de ML con el count cuando hay filas sin SKU en ML', () => {
    setRows([makeMlRow(), makeMlRow({ itemId: 'MLA2' })], []);

    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('Sin SKU en Mercado Libre (2)');
    expect(el.querySelectorAll('zc-conflict-row').length).toBe(2);
  });

  it('no debería mostrar el bloque de ML cuando no hay filas sin SKU en ML', () => {
    setRows([], [makeTnRow()]);

    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).not.toContain('Sin SKU en Mercado Libre');
  });

  it('debería mostrar el bloque de TN con el count cuando hay filas sin SKU en TN', () => {
    setRows([], [makeTnRow(), makeTnRow({ productId: 2, variantId: 2 })]);

    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('Sin SKU en Tienda Nube (2)');
    expect(el.querySelectorAll('zc-conflict-row').length).toBe(2);
  });

  it('debería mostrar "sin resultados" cuando ambas listas están vacías', () => {
    setRows([], []);

    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('Sin resultados para la búsqueda.');
  });

  it('debería filtrar las filas de ML según searchQuery', () => {
    setRows([makeMlRow({ title: 'Cuaderno Rivadavia' }), makeMlRow({ itemId: 'MLA2', title: 'Repuesto A4' })], []);

    component.searchQuery = 'repuesto';
    fixture.detectChanges();

    expect(component.filteredML.length).toBe(1);
    expect(component.filteredML[0].title).toBe('Repuesto A4');
  });

  it('debería filtrar las filas de TN según searchQuery', () => {
    setRows([], [makeTnRow({ productName: 'Cuaderno Rivadavia' }), makeTnRow({ productId: 2, variantId: 2, productName: 'Repuesto A4' })]);

    component.searchQuery = 'cuaderno';
    fixture.detectChanges();

    expect(component.filteredTN.length).toBe(1);
    expect(component.filteredTN[0].productName).toBe('Cuaderno Rivadavia');
  });

  it('debería resetear la paginación de ambas listas al cambiar searchQuery', () => {
    setRows([], []);
    const internal = component as unknown as { pageML_n: { set: (v: number) => number }; pageTN_n: { set: (v: number) => number } };
    internal.pageML_n.set(3);
    internal.pageTN_n.set(3);

    component.searchQuery = 'algo';

    const readable = component as unknown as { pageML_n: () => number; pageTN_n: () => number };
    expect(readable.pageML_n()).toBe(1);
    expect(readable.pageTN_n()).toBe(1);
  });

  it('debería paginar las filas de ML de a 20', () => {
    const rows = Array.from({ length: 25 }, (_, i) => makeMlRow({ itemId: `MLA${i}`, title: `Item ${i}` }));
    setRows(rows, []);

    expect(component.pageML.length).toBe(20);
    expect(component.totalPagesML).toBe(2);

    (component as unknown as { pageML_n: { set: (v: number) => void } }).pageML_n.set(2);
    expect(component.pageML.length).toBe(5);
  });

  it('debería emitir editSku con canal mercadolibre al hacer click en "Asignar SKU" de una fila ML', () => {
    const row = makeMlRow();
    setRows([row], []);

    let emitted: { channel: string; row: MlRow | TnRow } | undefined;
    component.editSku.subscribe((v) => (emitted = v));

    const btn = fixture.nativeElement.querySelector('.btn-action.ghost') as HTMLButtonElement;
    btn.click();

    expect(emitted?.channel).toBe('mercadolibre');
    expect(emitted?.row).toEqual(row);
  });

  it('debería emitir linkFromMl al hacer click en "Vincular" de una fila ML', () => {
    const row = makeMlRow();
    setRows([row], []);

    let emitted: MlRow | undefined;
    component.linkFromMl.subscribe((v) => (emitted = v));

    const btn = fixture.nativeElement.querySelector('.btn-action.link-btn') as HTMLButtonElement;
    btn.click();

    expect(emitted).toEqual(row);
  });

  it('debería emitir editSku con canal tiendanube y linkFromTn al interactuar con una fila TN', () => {
    const row = makeTnRow();
    setRows([], [row]);

    let emittedEdit: { channel: string; row: MlRow | TnRow } | undefined;
    let emittedLink: TnRow | undefined;
    component.editSku.subscribe((v) => (emittedEdit = v));
    component.linkFromTn.subscribe((v) => (emittedLink = v));

    const editBtn = fixture.nativeElement.querySelector('.btn-action.ghost') as HTMLButtonElement;
    editBtn.click();
    const linkBtn = fixture.nativeElement.querySelector('.btn-action.link-btn') as HTMLButtonElement;
    linkBtn.click();

    expect(emittedEdit?.channel).toBe('tiendanube');
    expect(emittedEdit?.row).toEqual(row);
    expect(emittedLink).toEqual(row);
  });
});
