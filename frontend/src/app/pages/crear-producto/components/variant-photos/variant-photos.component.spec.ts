import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';

import { VariantPhotosComponent } from './variant-photos.component';
import { ProductDraftStore } from '../../product-draft.store';
import { DraftImage } from '../../product-draft.model';

describe('VariantPhotosComponent', () => {
  let fixture: ComponentFixture<VariantPhotosComponent>;
  let store: ProductDraftStore;

  const img = (id: string): DraftImage => ({ id, uid: id, name: `${id}.jpg`, previewUrl: `blob:${id}` });

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [VariantPhotosComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), ProductDraftStore]
    }).compileComponents();

    fixture = TestBed.createComponent(VariantPhotosComponent);
    store = TestBed.inject(ProductDraftStore);
  });

  /** Deja el store con `mlImages` fotos de ML, `tnImages` de TN y `variants` variantes. */
  function seed(opts: { mlImages?: number; tnImages?: number; variants?: number } = {}): void {
    const d = store.draft();
    for (let i = 0; i < (opts.mlImages ?? 0); i++) d.ml.images.push(img(`ml-${i}`));
    for (let i = 0; i < (opts.tnImages ?? 0); i++) d.tn.images.push(img(`tn-${i}`));
    if (opts.variants) {
      store.addAxis(); // crea la primera variante sola
      for (let i = 1; i < opts.variants; i++) store.addVariant();
      d.axes[0].name = 'Color';
      d.variants.forEach((v, i) => {
        v.sku = `SKU-${i}`;
        v.values = [`Color${i}`];
      });
    }
    store.touch();
    fixture.detectChanges();
  }

  it('no muestra nada si todavía no hay fotos cargadas', () => {
    seed({ variants: 2 });
    expect(fixture.nativeElement.querySelector('.variant-photos')).toBeNull();
  });

  it('muestra una fila por variante con el conteo de fotos de cada canal', () => {
    seed({ mlImages: 3, tnImages: 2, variants: 2 });
    const v = store.draft().variants[0];
    store.toggleVariantMlImage(v, 'ml-0');
    store.toggleVariantMlImage(v, 'ml-1');
    store.toggleVariantTnImage(v, 'tn-0');
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('.vph-row');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('2 fotos');
    expect(rows[0].textContent).toContain('1 foto');
    expect(rows[1].textContent).toContain('Sin fotos');
  });

  it('con el modal CERRADO no renderiza ninguna miniatura (la regresión de performance)', () => {
    // Antes esta sección renderizaba variantes × (fotos ML + fotos TN): con 5 variantes y 45
    // fotos eran 225 <button> y 225 <img> permanentes en la página.
    seed({ mlImages: 12, tnImages: 33, variants: 5 });

    expect(fixture.nativeElement.querySelectorAll('.vpd-tile').length).toBe(0);
    expect(fixture.nativeElement.querySelectorAll('img').length).toBe(0);
    expect(fixture.nativeElement.querySelectorAll('.vph-row').length).toBe(5);
  });

  it('el botón "Elegir fotos" abre el modal de esa variante, y se cierra', () => {
    seed({ mlImages: 2, variants: 2 });

    const botones = fixture.nativeElement.querySelectorAll('.vph-row .zc-btn');
    botones[1].click();
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    // Es la variante en la que se hizo click, no la primera.
    expect(dialog.textContent).toContain('Color1');

    fixture.nativeElement.querySelector('.vpd-foot .zc-btn').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="dialog"]')).toBeNull();
  });

  it('si se borra la variante mientras el modal está abierto, el modal se cierra solo', () => {
    // El estado abierto se guarda por ID justamente para esto.
    seed({ mlImages: 2, variants: 2 });
    const id = store.draft().variants[0].id;
    fixture.nativeElement.querySelectorAll('.vph-row .zc-btn')[0].click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="dialog"]')).not.toBeNull();

    store.removeVariant(id);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[role="dialog"]')).toBeNull();
  });
});
