import { ComponentFixture, TestBed } from '@angular/core/testing';

import { CoincidenciasTabComponent } from './coincidencias-tab.component';
import { MlRow, TnRow } from '../../../core/services/conflicts.service';

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
    thumbnail: 'https://example.com/ml-thumb.jpg',
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
    thumbnail: 'https://example.com/tn-thumb.jpg',
    ...overrides,
  };
}

describe('CoincidenciasTabComponent', () => {
  let fixture: ComponentFixture<CoincidenciasTabComponent>;
  let component: CoincidenciasTabComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CoincidenciasTabComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(CoincidenciasTabComponent);
    component = fixture.componentInstance;
  });

  function setPairs(pairs: { ml: MlRow; tn: TnRow; sku?: string }[], paging = { page: 1, limit: 25, total: pairs.length, pages: 1 }) {
    component.pairs = pairs;
    component.paging = paging;
    fixture.detectChanges();
  }

  it('debería mostrar el hint con el total en plural', () => {
    setPairs([{ ml: makeMlRow(), tn: makeTnRow() }, { ml: makeMlRow({ itemId: 'MLA2' }), tn: makeTnRow({ productId: 2 }) }]);

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.tab-hint')?.textContent).toContain('2 pares con el mismo SKU');
  });

  it('debería mostrar el hint en singular cuando hay un solo par', () => {
    setPairs([{ ml: makeMlRow(), tn: makeTnRow() }]);

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.tab-hint')?.textContent).toContain('1 par con el mismo SKU');
  });

  it('debería renderizar una tarjeta por par con los nombres de ML y TN', () => {
    setPairs([{ ml: makeMlRow(), tn: makeTnRow() }]);

    const el: HTMLElement = fixture.nativeElement;
    const cards = el.querySelectorAll('.pair-card');
    expect(cards.length).toBe(1);
    expect(cards[0].textContent).toContain('Cuaderno Rivadavia Tapa Dura');
    expect(cards[0].querySelector('.zc-badge.ml')).not.toBeNull();
    expect(cards[0].querySelector('.zc-badge.tn')).not.toBeNull();
  });

  it('debería mostrar el SKU del par cuando está definido', () => {
    setPairs([{ ml: makeMlRow(), tn: makeTnRow(), sku: 'SKU-PAR' }]);

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.pair-footer .sku-code')?.textContent?.trim()).toBe('SKU-PAR');
  });

  it('debería usar el SKU de ML como fallback cuando el par no tiene sku propio', () => {
    setPairs([{ ml: makeMlRow({ sku: 'SKU-ML' }), tn: makeTnRow({ sku: null }) }]);

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.pair-footer .sku-code')?.textContent?.trim()).toBe('SKU-ML');
  });

  it('debería mostrar "—" cuando ningún lado tiene SKU', () => {
    setPairs([{ ml: makeMlRow({ sku: null }), tn: makeTnRow({ sku: null }) }]);

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.pair-footer .sku-code')?.textContent?.trim()).toBe('—');
  });

  it('debería mostrar el mensaje de "sin resultados" cuando no hay pares', () => {
    setPairs([]);

    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('Sin resultados para la búsqueda.');
  });

  it('debería emitir editSku con canal mercadolibre al hacer click en "SKU ML"', () => {
    const pair = { ml: makeMlRow(), tn: makeTnRow() };
    setPairs([pair]);

    let emitted: { channel: string; row: unknown } | undefined;
    component.editSku.subscribe((v) => (emitted = v));

    const btn = fixture.nativeElement.querySelector('.pair-actions .btn-action.ghost') as HTMLButtonElement;
    btn.click();

    expect(emitted?.channel).toBe('mercadolibre');
    expect(emitted?.row).toEqual(pair.ml);
  });

  it('debería emitir editSku con canal tiendanube al hacer click en "SKU TN"', () => {
    const pair = { ml: makeMlRow(), tn: makeTnRow() };
    setPairs([pair]);

    let emitted: { channel: string; row: unknown } | undefined;
    component.editSku.subscribe((v) => (emitted = v));

    const buttons = fixture.nativeElement.querySelectorAll('.pair-actions .btn-action.ghost');
    (buttons[1] as HTMLButtonElement).click();

    expect(emitted?.channel).toBe('tiendanube');
    expect(emitted?.row).toEqual(pair.tn);
  });

  it('debería emitir editBothSku con ambas filas al hacer click en "Ambos SKU"', () => {
    const pair = { ml: makeMlRow(), tn: makeTnRow() };
    setPairs([pair]);

    let emitted: { ml: MlRow; tn: TnRow } | undefined;
    component.editBothSku.subscribe((v) => (emitted = v));

    const btn = fixture.nativeElement.querySelector('.pair-actions .btn-action:not(.ghost)') as HTMLButtonElement;
    btn.click();

    expect(emitted?.ml).toEqual(pair.ml);
    expect(emitted?.tn).toEqual(pair.tn);
  });

  it('debería emitir pageChange al ir a la página siguiente', () => {
    setPairs(
      [{ ml: makeMlRow(), tn: makeTnRow() }],
      { page: 1, limit: 25, total: 50, pages: 2 }
    );

    let emittedPage: number | undefined;
    component.pageChange.subscribe((p) => (emittedPage = p));

    const nextBtn = fixture.nativeElement.querySelectorAll('zc-pagination button.page-btn')[1] as HTMLButtonElement;
    nextBtn.click();

    expect(emittedPage).toBe(2);
  });
});
