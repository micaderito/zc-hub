import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';

import { VariantPhotosDialogComponent } from './variant-photos-dialog.component';
import { ProductDraftStore } from '../../product-draft.store';
import { DraftImage, ProductVariant } from '../../product-draft.model';

describe('VariantPhotosDialogComponent', () => {
  let fixture: ComponentFixture<VariantPhotosDialogComponent>;
  let store: ProductDraftStore;

  const img = (id: string): DraftImage => ({ id, uid: id, name: `${id}.jpg`, previewUrl: `blob:${id}` });

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [VariantPhotosDialogComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), ProductDraftStore]
    }).compileComponents();

    fixture = TestBed.createComponent(VariantPhotosDialogComponent);
    store = TestBed.inject(ProductDraftStore);
  });

  /** Deja el store cargado y bindea la variante que abre el modal. */
  function setup(opts: { mlImages?: number; tnImages?: number } = {}): ProductVariant {
    const d = store.draft();
    for (let i = 0; i < (opts.mlImages ?? 0); i++) d.ml.images.push(img(`ml-${i}`));
    for (let i = 0; i < (opts.tnImages ?? 0); i++) d.tn.images.push(img(`tn-${i}`));
    store.addAxis();
    d.axes[0].name = 'Color';
    const v = d.variants[0];
    v.sku = 'CUA-N';
    v.values = ['Negro'];
    store.touch();
    fixture.componentRef.setInput('variant', v);
    fixture.detectChanges();
    return v;
  }

  it('muestra una sección por canal, con la galería UNA sola vez', () => {
    setup({ mlImages: 3, tnImages: 2 });
    const secciones = fixture.nativeElement.querySelectorAll('.vpd-channel');
    expect(secciones.length).toBe(2);
    // 3 + 2 tiles en total, no 3+2 por variante.
    expect(fixture.nativeElement.querySelectorAll('.vpd-tile').length).toBe(5);
  });

  it('clickear un tile lo marca, y volver a clickearlo lo desmarca', () => {
    const v = setup({ mlImages: 2 });
    const tile = fixture.nativeElement.querySelectorAll('.vpd-tile')[0];

    tile.click();
    fixture.detectChanges();
    expect(v.ml.pictureIds).toEqual(['ml-0']);
    expect(fixture.nativeElement.querySelectorAll('.vpd-tile')[0].classList).toContain('sel');

    fixture.nativeElement.querySelectorAll('.vpd-tile')[0].click();
    fixture.detectChanges();
    expect(v.ml.pictureIds).toEqual([]);
  });

  it('con el límite de ML en 0 (lo que informa ML en categorías rotas) igual se puede elegir', () => {
    // Es el bug reportado: con 0, la guarda `length >= limite` daba `0 >= 0` y no marcaba nada.
    const v = setup({ mlImages: 2 });
    store.mlMaxPicturesPerVar.set(0);
    fixture.detectChanges();

    fixture.nativeElement.querySelectorAll('.vpd-tile')[0].click();
    fixture.detectChanges();

    expect(v.ml.pictureIds).toEqual(['ml-0']);
  });

  it('al llegar al tope de ML, los tiles no elegidos se deshabilitan y el aviso sale DENTRO del modal', () => {
    const v = setup({ mlImages: 3 });
    store.mlMaxPicturesPerVar.set(1);
    fixture.detectChanges();

    fixture.nativeElement.querySelectorAll('.vpd-tile')[0].click();
    fixture.detectChanges();

    const tiles = fixture.nativeElement.querySelectorAll('.vpd-tile');
    expect(v.ml.pictureIds).toEqual(['ml-0']);
    // El elegido sigue clickeable (para poder sacarlo); los otros no.
    expect(tiles[0].disabled).toBeFalse();
    expect(tiles[1].disabled).toBeTrue();
    expect(fixture.nativeElement.textContent).toContain('máximo de 1 fotos');
    expect(fixture.nativeElement.querySelector('.vpd-count').classList).toContain('warn');
  });

  it('TN en single_with_variants reemplaza la foto en vez de acumular', () => {
    const v = setup({ tnImages: 2 });
    store.setMode('tn', 'single_with_variants');
    fixture.detectChanges();

    const tiles = fixture.nativeElement.querySelectorAll('.vpd-tile');
    tiles[0].click();
    fixture.detectChanges();
    fixture.nativeElement.querySelectorAll('.vpd-tile')[1].click();
    fixture.detectChanges();

    expect(v.tn.imageIds).toEqual(['tn-1']);
  });

  it('TN en one_per_variant acumula varias', () => {
    const v = setup({ tnImages: 2 });
    store.setMode('tn', 'one_per_variant');
    fixture.detectChanges();

    fixture.nativeElement.querySelectorAll('.vpd-tile')[0].click();
    fixture.detectChanges();
    fixture.nativeElement.querySelectorAll('.vpd-tile')[1].click();
    fixture.detectChanges();

    expect(v.tn.imageIds).toEqual(['tn-0', 'tn-1']);
  });

  it('con más de 24 fotos pagina en vez de renderizarlas todas', () => {
    setup({ tnImages: 33 });
    expect(fixture.nativeElement.querySelectorAll('.vpd-tile').length).toBe(24);

    fixture.nativeElement.querySelector('zc-pagination .page-btn:last-of-type').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.vpd-tile').length).toBe(9);
  });

  it('emite close al tocar el backdrop y con Escape', () => {
    setup({ mlImages: 1 });
    let cerrado = 0;
    fixture.componentInstance.close.subscribe(() => cerrado++);

    fixture.nativeElement.querySelector('.vpd-backdrop').click();
    expect(cerrado).toBe(1);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(cerrado).toBe(2);
  });
});
