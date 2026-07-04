import { ComponentFixture, TestBed } from '@angular/core/testing';

import { DuplicadosTabComponent } from './duplicados-tab.component';
import { MlRow, TnRow } from '../../../core/services/conflicts.service';

function makeMlRow(overrides: Partial<MlRow> = {}): MlRow {
  return {
    type: 'ml',
    itemId: 'MLA123',
    variationId: null,
    title: 'Cuaderno Rivadavia Tapa Dura',
    sku: 'DUP-1',
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
    productName: 'Repuesto A4 removible',
    sku: 'DUP-2',
    hasSku: true,
    price: 5000,
    stock: 10,
    thumbnail: null,
    ...overrides,
  };
}

describe('DuplicadosTabComponent', () => {
  let fixture: ComponentFixture<DuplicadosTabComponent>;
  let component: DuplicadosTabComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DuplicadosTabComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(DuplicadosTabComponent);
    component = fixture.componentInstance;
  });

  function setGroups(duplicateSkuML: { sku: string; items: MlRow[] }[], duplicateSkuTN: { sku: string; items: TnRow[] }[]) {
    component.duplicateSkuML = duplicateSkuML;
    component.duplicateSkuTN = duplicateSkuTN;
    fixture.detectChanges();
  }

  it('debería mostrar el hint general', () => {
    setGroups([], []);

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.tab-hint')?.textContent).toContain('El mismo SKU está usado por varios ítems');
  });

  it('debería renderizar un grupo de ML con su SKU, cantidad de ítems y sus filas', () => {
    const group = { sku: 'DUP-1', items: [makeMlRow(), makeMlRow({ itemId: 'MLA2' })] };
    setGroups([group], []);

    const el: HTMLElement = fixture.nativeElement;
    const mlGroup = el.querySelector('.dup-group.ml-group');
    expect(mlGroup?.querySelector('.sku-code')?.textContent?.trim()).toBe('DUP-1');
    expect(mlGroup?.querySelector('.dup-count')?.textContent).toContain('2 ítems');
    expect(mlGroup?.querySelectorAll('.dup-item').length).toBe(2);
  });

  it('debería renderizar un grupo de TN con su SKU, cantidad de variantes y sus filas', () => {
    const group = { sku: 'DUP-2', items: [makeTnRow(), makeTnRow({ productId: 2, variantId: 2 })] };
    setGroups([], [group]);

    const el: HTMLElement = fixture.nativeElement;
    const tnGroup = el.querySelector('.dup-group.tn-group');
    expect(tnGroup?.querySelector('.sku-code')?.textContent?.trim()).toBe('DUP-2');
    expect(tnGroup?.querySelector('.dup-count')?.textContent).toContain('2 variantes');
    expect(tnGroup?.querySelectorAll('.dup-item').length).toBe(2);
  });

  it('debería mostrar "sin resultados" cuando no hay grupos duplicados', () => {
    setGroups([], []);

    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('Sin resultados para la búsqueda.');
  });

  it('debería filtrar los grupos de ML según searchQuery', () => {
    setGroups(
      [{ sku: 'DUP-1', items: [makeMlRow({ title: 'Cuaderno Rivadavia' }), makeMlRow({ itemId: 'MLA2', title: 'Repuesto A4' })] }],
      []
    );

    component.searchQuery = 'repuesto';
    fixture.detectChanges();

    expect(component.filteredML.length).toBe(1);
    expect(component.filteredML[0].items.length).toBe(1);
    expect(component.filteredML[0].items[0].title).toBe('Repuesto A4');
  });

  it('debería excluir un grupo de ML cuando ningún ítem coincide con la búsqueda', () => {
    setGroups([{ sku: 'DUP-1', items: [makeMlRow({ title: 'Cuaderno Rivadavia' })] }], []);

    component.searchQuery = 'inexistente';
    fixture.detectChanges();

    expect(component.filteredML.length).toBe(0);
  });

  it('debería resetear currentPage al cambiar searchQuery', () => {
    setGroups([], []);
    const internal = component as unknown as { currentPage: { set: (v: number) => void } & (() => number) };
    internal.currentPage.set(3);

    component.searchQuery = 'algo';

    expect(internal.currentPage()).toBe(1);
  });

  it('debería emitir editSku con canal mercadolibre al hacer click en "Editar SKU" de un ítem ML', () => {
    const row = makeMlRow();
    setGroups([{ sku: 'DUP-1', items: [row] }], []);

    let emitted: { channel: string; row: MlRow | TnRow } | undefined;
    component.editSku.subscribe((v) => (emitted = v));

    const btn = fixture.nativeElement.querySelector('.dup-item .btn-action.ghost') as HTMLButtonElement;
    btn.click();

    expect(emitted?.channel).toBe('mercadolibre');
    expect(emitted?.row).toEqual(row);
  });

  it('debería emitir editBulkSku al hacer click en "Editar en lote" de un grupo ML', () => {
    const items = [makeMlRow(), makeMlRow({ itemId: 'MLA2' })];
    setGroups([{ sku: 'DUP-1', items }], []);

    let emitted: { channel: string; sku: string; items: (MlRow | TnRow)[] } | undefined;
    component.editBulkSku.subscribe((v) => (emitted = v));

    const btn = fixture.nativeElement.querySelector('.dup-group-header .btn-action') as HTMLButtonElement;
    btn.click();

    expect(emitted?.channel).toBe('mercadolibre');
    expect(emitted?.sku).toBe('DUP-1');
    expect(emitted?.items).toEqual(items);
  });

  it('debería emitir editBulkSku con canal tiendanube al hacer click en "Editar en lote" de un grupo TN', () => {
    const items = [makeTnRow()];
    setGroups([], [{ sku: 'DUP-2', items }]);

    let emitted: { channel: string; sku: string; items: (MlRow | TnRow)[] } | undefined;
    component.editBulkSku.subscribe((v) => (emitted = v));

    const btn = fixture.nativeElement.querySelector('.dup-group-header .btn-action') as HTMLButtonElement;
    btn.click();

    expect(emitted?.channel).toBe('tiendanube');
    expect(emitted?.sku).toBe('DUP-2');
  });

  it('debería paginar los grupos combinados de a 20 entre ML y TN', () => {
    const mlGroups = Array.from({ length: 15 }, (_, i) => ({ sku: `ML-${i}`, items: [makeMlRow({ itemId: `MLA${i}` })] }));
    const tnGroups = Array.from({ length: 10 }, (_, i) => ({ sku: `TN-${i}`, items: [makeTnRow({ productId: i, variantId: i })] }));
    setGroups(mlGroups, tnGroups);

    expect(component.totalPages).toBe(2);
    expect(component.pageML.length).toBe(15);
    expect(component.pageTN.length).toBe(5);

    (component as unknown as { currentPage: { set: (v: number) => void } }).currentPage.set(2);
    expect(component.pageML.length).toBe(0);
    expect(component.pageTN.length).toBe(5);
  });
});
