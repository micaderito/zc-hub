import { ComponentFixture, TestBed } from '@angular/core/testing';

import { PairCardComponent, PairPrices } from './pair-card.component';
import { MlRow, TnRow } from '../../../../core/services/conflicts.service';

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

describe('PairCardComponent', () => {
  let fixture: ComponentFixture<PairCardComponent>;
  let component: PairCardComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PairCardComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(PairCardComponent);
    component = fixture.componentInstance;
  });

  function setInputs(overrides: {
    pair?: { ml: MlRow; tn: TnRow; sku?: string };
    prices?: PairPrices;
    displayStockML?: number;
    displayStockTN?: number;
    isPending?: boolean;
    isCollapsed?: boolean;
    syncError?: string | null;
  } = {}) {
    fixture.componentRef.setInput('pair', overrides.pair ?? { ml: makeMlRow(), tn: makeTnRow() });
    fixture.componentRef.setInput('prices', overrides.prices ?? { priceML: 5000, priceTN: 5000, syncStock: 10 });
    fixture.componentRef.setInput('displayStockML', overrides.displayStockML ?? 10);
    fixture.componentRef.setInput('displayStockTN', overrides.displayStockTN ?? 10);
    if ('isPending' in overrides) fixture.componentRef.setInput('isPending', overrides.isPending);
    if ('isCollapsed' in overrides) fixture.componentRef.setInput('isCollapsed', overrides.isCollapsed);
    if ('syncError' in overrides) fixture.componentRef.setInput('syncError', overrides.syncError);
    fixture.detectChanges();
  }

  it('debería mostrar el SKU del par cuando está definido', () => {
    setInputs({ pair: { ml: makeMlRow(), tn: makeTnRow(), sku: 'SKU-PAR' } });

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.pair-sku code')?.textContent?.trim()).toBe('SKU-PAR');
  });

  it('debería usar el SKU de ML como fallback cuando el par no tiene sku propio', () => {
    setInputs({ pair: { ml: makeMlRow({ sku: 'SKU-ML' }), tn: makeTnRow({ sku: null }) } });

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.pair-sku code')?.textContent?.trim()).toBe('SKU-ML');
  });

  it('debería mostrar "—" cuando ningún lado tiene SKU', () => {
    setInputs({ pair: { ml: makeMlRow({ sku: null }), tn: makeTnRow({ sku: null }) } });

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.pair-sku code')?.textContent?.trim()).toBe('—');
  });

  it('debería mostrar el badge "Mismo stock" cuando displayStockML y displayStockTN coinciden', () => {
    setInputs({ displayStockML: 10, displayStockTN: 10 });

    const el: HTMLElement = fixture.nativeElement;
    const badge = el.querySelector('.pair-header .zc-badge');
    expect(badge?.classList.contains('ok')).toBeTrue();
    expect(badge?.textContent).toContain('Mismo stock');
  });

  it('debería mostrar el badge "Stock distinto" cuando displayStockML y displayStockTN difieren', () => {
    setInputs({ displayStockML: 10, displayStockTN: 3 });

    const el: HTMLElement = fixture.nativeElement;
    const badge = el.querySelector('.pair-header .zc-badge');
    expect(badge?.classList.contains('warn')).toBeTrue();
    expect(badge?.textContent).toContain('Stock distinto');
  });

  it('debería mostrar los stocks de cada canal en sus chips', () => {
    setInputs({ displayStockML: 7, displayStockTN: 3 });

    const el: HTMLElement = fixture.nativeElement;
    const chips = el.querySelectorAll('.stock-chip');
    expect(chips[0].textContent?.trim()).toBe('7');
    expect(chips[1].textContent?.trim()).toBe('3');
  });

  it('debería ocultar los canales y el footer cuando isCollapsed es true', () => {
    setInputs({ isCollapsed: true });

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.channels')).toBeNull();
    expect(el.querySelector('.pair-footer')).toBeNull();
    expect(el.querySelector('.pair-card')?.classList.contains('pair-collapsed')).toBeTrue();
  });

  it('debería mostrar los canales y el footer cuando isCollapsed es false', () => {
    setInputs({ isCollapsed: false });

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.channels')).not.toBeNull();
    expect(el.querySelector('.pair-footer')).not.toBeNull();
  });

  it('debería emitir toggleCollapse al hacer click en el header', () => {
    setInputs();

    let emitted = false;
    component.toggleCollapse.subscribe(() => (emitted = true));

    (fixture.nativeElement.querySelector('.pair-header') as HTMLElement).click();

    expect(emitted).toBeTrue();
  });

  it('debería mostrar la imagen del producto cuando hay thumbnail y el placeholder cuando no hay', () => {
    setInputs({ pair: { ml: makeMlRow({ thumbnail: 'https://example.com/ml.jpg' }), tn: makeTnRow({ thumbnail: null }) } });

    const el: HTMLElement = fixture.nativeElement;
    const mlCard = el.querySelector('.ch-card.ml-card');
    const tnCard = el.querySelector('.ch-card.tn-card');
    expect(mlCard?.querySelector('img.thumb')).not.toBeNull();
    expect(mlCard?.querySelector('.no-thumb')).toBeNull();
    expect(tnCard?.querySelector('img.thumb')).toBeNull();
    expect(tnCard?.querySelector('.no-thumb')).not.toBeNull();
  });

  it('debería mostrar el nombre del producto de cada canal usando mlLabel/tnLabel', () => {
    setInputs({
      pair: {
        ml: makeMlRow({ variationId: 'V1', variationName: 'Negro' }),
        tn: makeTnRow({ variantName: 'A4' }),
      },
    });

    const el: HTMLElement = fixture.nativeElement;
    const labels = el.querySelectorAll('.product-label');
    expect(labels[0].textContent).toContain('Cuaderno Rivadavia Tapa Dura (Negro)');
    expect(labels[1].textContent).toContain('Cuaderno Rivadavia Tapa Dura (A4)');
  });

  it('no debería mostrar el mensaje de error de sincronización cuando syncError es null', () => {
    setInputs({ syncError: null });

    expect(fixture.nativeElement.querySelector('.pair-sync-error')).toBeNull();
  });

  it('debería mostrar el mensaje de error de sincronización cuando syncError tiene un valor', () => {
    setInputs({ syncError: 'ML rechazó el precio distinto por variación' });

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.pair-sync-error')?.textContent).toContain('ML rechazó el precio distinto por variación');
  });

  it('debería emitir syncStock al hacer click en "Sincronizar"', () => {
    setInputs({ isPending: false });

    let emitted = false;
    component.syncStock.subscribe(() => (emitted = true));

    (fixture.nativeElement.querySelector('.btn-sync') as HTMLButtonElement).click();

    expect(emitted).toBeTrue();
  });

  it('debería emitir updatePrices al hacer click en "Actualizar precios"', () => {
    setInputs({ isPending: false });

    let emitted = false;
    component.updatePrices.subscribe(() => (emitted = true));

    (fixture.nativeElement.querySelector('.btn-prices') as HTMLButtonElement).click();

    expect(emitted).toBeTrue();
  });

  it('debería deshabilitar los botones de acción y cambiar sus textos cuando isPending es true', () => {
    setInputs({ isPending: true });

    const el: HTMLElement = fixture.nativeElement;
    const syncBtn = el.querySelector('.btn-sync') as HTMLButtonElement;
    const pricesBtn = el.querySelector('.btn-prices') as HTMLButtonElement;

    expect(syncBtn.disabled).toBeTrue();
    expect(syncBtn.textContent).toContain('…');
    expect(pricesBtn.disabled).toBeTrue();
    expect(pricesBtn.textContent).toContain('Actualizando…');
  });

  it('debería habilitar los botones de acción con sus textos normales cuando isPending es false', () => {
    setInputs({ isPending: false });

    const el: HTMLElement = fixture.nativeElement;
    const syncBtn = el.querySelector('.btn-sync') as HTMLButtonElement;
    const pricesBtn = el.querySelector('.btn-prices') as HTMLButtonElement;

    expect(syncBtn.disabled).toBeFalse();
    expect(syncBtn.textContent).toContain('Sincronizar');
    expect(pricesBtn.disabled).toBeFalse();
    expect(pricesBtn.textContent).toContain('Actualizar precios');
  });

  it('debería actualizar prices().priceML al editar el campo de precio de ML (ngModel + appCurrencyInput)', () => {
    const prices: PairPrices = { priceML: 1000, priceTN: 2000, syncStock: 5 };
    setInputs({ prices });

    const input = fixture.nativeElement.querySelector('input[aria-label="Precio Mercado Libre"]') as HTMLInputElement;
    input.dispatchEvent(new Event('focus'));
    input.value = '1500,50';
    input.dispatchEvent(new Event('blur'));
    fixture.detectChanges();

    expect(prices.priceML).toBe(1500.5);
  });

  it('debería actualizar prices().syncStock al editar el campo de stock a sincronizar', () => {
    const prices: PairPrices = { priceML: 1000, priceTN: 2000, syncStock: 5 };
    setInputs({ prices });

    const input = fixture.nativeElement.querySelector('input[aria-label="Nuevo stock para sincronizar"]') as HTMLInputElement;
    input.value = '25';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(prices.syncStock).toBe(25);
  });
});
