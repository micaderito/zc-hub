import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ConflictRowComponent } from './conflict-row.component';

describe('ConflictRowComponent', () => {
  let fixture: ComponentFixture<ConflictRowComponent>;
  let component: ConflictRowComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ConflictRowComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(ConflictRowComponent);
    component = fixture.componentInstance;
  });

  function setInputs(overrides: {
    channel?: 'mercadolibre' | 'tiendanube';
    name?: string;
    thumbnail?: string | null;
    sku?: string | null;
  }) {
    fixture.componentRef.setInput('channel', overrides.channel ?? 'mercadolibre');
    fixture.componentRef.setInput('name', overrides.name ?? 'Cuaderno Rivadavia Tapa Dura');
    if ('thumbnail' in overrides) {
      fixture.componentRef.setInput('thumbnail', overrides.thumbnail);
    }
    if ('sku' in overrides) {
      fixture.componentRef.setInput('sku', overrides.sku);
    }
    fixture.detectChanges();
  }

  it('debería mostrar el badge ML y aplicar la clase ml-card cuando el canal es mercadolibre', () => {
    setInputs({ channel: 'mercadolibre', sku: 'CUAD-RIV-01' });

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.row-card')?.classList.contains('ml-card')).toBeTrue();
    expect(el.querySelector('.row-card')?.classList.contains('tn-card')).toBeFalse();
    expect(el.querySelector('.zc-badge')?.classList.contains('ml')).toBeTrue();
    expect(el.querySelector('.zc-badge')?.textContent?.trim()).toBe('ML');
  });

  it('debería mostrar el badge TN y aplicar la clase tn-card cuando el canal es tiendanube', () => {
    setInputs({ channel: 'tiendanube', sku: 'CUAD-RIV-01' });

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.row-card')?.classList.contains('tn-card')).toBeTrue();
    expect(el.querySelector('.row-card')?.classList.contains('ml-card')).toBeFalse();
    expect(el.querySelector('.zc-badge')?.classList.contains('tn')).toBeTrue();
    expect(el.querySelector('.zc-badge')?.textContent?.trim()).toBe('TN');
  });

  it('debería mostrar el nombre del producto', () => {
    setInputs({ name: 'Repuesto A4 Rivadavia 50 hojas' });

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.row-name')?.textContent).toContain('Repuesto A4 Rivadavia 50 hojas');
  });

  it('debería mostrar el SKU cuando está presente', () => {
    setInputs({ sku: 'REP-A4-50' });

    const el: HTMLElement = fixture.nativeElement;
    const code = el.querySelector('.sku-code');
    expect(code?.textContent?.trim()).toBe('REP-A4-50');
    expect(code?.classList.contains('sku-missing')).toBeFalse();
  });

  it('debería mostrar "sin SKU" cuando el sku es null', () => {
    setInputs({ sku: null });

    const el: HTMLElement = fixture.nativeElement;
    const code = el.querySelector('.sku-code');
    expect(code?.textContent?.trim()).toBe('sin SKU');
    expect(code?.classList.contains('sku-missing')).toBeTrue();
  });

  it('debería mostrar "sin SKU" cuando el sku es undefined', () => {
    setInputs({ sku: undefined });

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.sku-code')?.textContent?.trim()).toBe('sin SKU');
  });

  it('debería pasar el thumbnail al componente zc-product-thumb', () => {
    setInputs({ thumbnail: 'https://example.com/thumb.jpg' });

    const thumb = fixture.nativeElement.querySelector('zc-product-thumb img.thumb-img');
    expect(thumb?.getAttribute('src')).toBe('https://example.com/thumb.jpg');
  });

  it('debería proyectar contenido en row-actions mediante ng-content', () => {
    const el: HTMLElement = fixture.nativeElement;
    setInputs({});

    const actionsContainer = el.querySelector('.row-actions');
    expect(actionsContainer).not.toBeNull();
  });
});
