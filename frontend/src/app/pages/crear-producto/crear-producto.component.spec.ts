import { ComponentFixture, TestBed, fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';

import { CrearProductoComponent } from './crear-producto.component';
import {
  CatalogService,
  MlCategoryAttribute,
  MlCategoryNode,
  MlCategoryPrediction,
  MlCategoryRef,
  PublishResponse,
  TnCategory,
  UploadedImage
} from '../../core/services/catalog.service';
import { Channel, emptyDraft } from './product-draft.model';

/** Mock de CatalogService con respuestas controlables por test. */
class CatalogServiceMock {
  tnCategories: TnCategory[] = [];
  mlRoots: MlCategoryRef[] = [];
  mlNodes: Record<string, MlCategoryNode> = {};
  mlAttributes: MlCategoryAttribute[] = [];
  mlPredictions: MlCategoryPrediction[] = [];
  publishResponse: PublishResponse = {
    results: [
      { channel: 'ml', status: 'ok', detail: 'Publicación MLA-1 creada' },
      { channel: 'tn', status: 'ok', detail: 'Producto #1 creado' }
    ]
  };
  lastPublishPayload: any = null;

  getTiendaNubeCategories = jasmine.createSpy('getTn').and.callFake(() => Promise.resolve(this.tnCategories));
  getMlRootCategories = jasmine.createSpy('getRoots').and.callFake(() => Promise.resolve(this.mlRoots));
  getMlCategory = jasmine.createSpy('getCat').and.callFake((id: string) => Promise.resolve(this.mlNodes[id]));
  getMlCategoryAttributes = jasmine
    .createSpy('getAttrs')
    .and.callFake(() => Promise.resolve(this.mlAttributes));
  predictMlCategory = jasmine.createSpy('predict').and.callFake(() => Promise.resolve(this.mlPredictions));
  publishProduct = jasmine.createSpy('publish').and.callFake((payload: any) => {
    this.lastPublishPayload = payload;
    const chans: ('ml' | 'tn')[] | undefined = payload?.channels;
    const results = chans
      ? this.publishResponse.results.filter((r) => chans.includes(r.channel))
      : this.publishResponse.results;
    return Promise.resolve({ results });
  });

  uploadResponse: UploadedImage = { id: 'IMG1', name: 'a.jpg', mime: 'image/jpeg', size: 3 };
  uploadImage = jasmine.createSpy('upload').and.callFake(() => Promise.resolve(this.uploadResponse));
  deleteImage = jasmine.createSpy('del').and.callFake(() => Promise.resolve({ ok: true }));

  listingPrices = { currency_id: 'ARS', sale_fee_amount: 130, listing_fee_amount: 0, percentage_fee: 13, net: 870 };
  getMlListingPrices = jasmine.createSpy('fees').and.callFake(() => Promise.resolve(this.listingPrices));

  seoResponse = {
    seoTitle: 'Cuaderno A4 | Zona Cuaderno',
    seoDescription: 'Cuaderno premium de tapa dura.',
    tags: 'cuaderno a4, tapa dura, escolar'
  };
  lastSeoInput: any = null;
  generateSeo = jasmine.createSpy('seo').and.callFake((input: any) => {
    this.lastSeoInput = input;
    return Promise.resolve(this.seoResponse);
  });
}

/** Agrega una imagen directamente a la galería del draft (evita el FileReader en tests). */
function seedImage(component: CrearProductoComponent, channel: Channel, id: string): void {
  const d = component.draft();
  (channel === 'ml' ? d.ml.images : d.tn.images).push({ id, name: `${id}.jpg`, previewUrl: 'data:img' });
  component.draft.set({ ...d });
}

describe('CrearProductoComponent', () => {
  let component: CrearProductoComponent;
  let fixture: ComponentFixture<CrearProductoComponent>;
  let catalog: CatalogServiceMock;

  const clearDraftStorage = () => {
    localStorage.removeItem('zc-crear-producto-draft');
    localStorage.removeItem('zc-crear-producto-drafts');
  };

  beforeEach(async () => {
    // Aísla los borradores locales entre tests (ngOnInit intenta restaurar de localStorage).
    clearDraftStorage();
    catalog = new CatalogServiceMock();
    await TestBed.configureTestingModule({
      imports: [CrearProductoComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: CatalogService, useValue: catalog }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(CrearProductoComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    clearDraftStorage();
  });

  it('se crea correctamente', () => {
    expect(component).toBeTruthy();
  });

  describe('estado inicial (vacío)', () => {
    it('arranca con los campos comunes vacíos (sin datos de ejemplo prellenados)', () => {
      expect(component.draft().common.baseName).toBe('');
      expect(component.draft().common.sku).toBe('');
      expect(component.draft().common.brand).toBe('');
    });

    it('no arranca con variantes ni ejes', () => {
      expect(component.draft().axes).toEqual([]);
      expect(component.draft().variants).toEqual([]);
    });

    it('no muestra resultados de publicación y no está publicando', () => {
      expect(component.publishResults()).toBeNull();
      expect(component.publishing()).toBeFalse();
    });

    it('el título de ML arranca heredado del común y vacío', () => {
      expect(component.draft().ml.title.inherited).toBeTrue();
      expect(component.draft().ml.title.value).toBe('');
    });

    it('el nombre (es) de TN arranca heredado del común y vacío', () => {
      expect(component.draft().tn.nameEs.inherited).toBeTrue();
      expect(component.draft().tn.nameEs.value).toBe('');
    });

    it('no arranca con categorías, atributos ni imágenes precargadas', () => {
      expect(component.draft().ml.categoryId).toBe('');
      expect(component.draft().ml.attributes).toEqual([]);
      expect(component.draft().ml.images).toEqual([]);
      expect(component.draft().tn.categories).toEqual([]);
    });
  });

  describe('hasVariants / proyecciones', () => {
    it('hasVariants() es false cuando no hay ejes', () => {
      expect(component.hasVariants()).toBeFalse();
    });

    it('hasVariants() es true después de agregar un eje', () => {
      component.addAxis();
      expect(component.hasVariants()).toBeTrue();
    });

    it('mlProjection y tnProjection reflejan el modo por defecto (single_with_variants, sin variantes)', () => {
      expect(component.mlProjection()).toBe('1 publicación');
      expect(component.tnProjection()).toBe('1 producto');
    });

    it('mlProjection cambia al agregar variantes', () => {
      // addAxis() solo crea la primera variante automáticamente; para tener más de una
      // variante (y que el modo single_with_variants muestre "con N variantes") hace
      // falta agregar una variante extra explícitamente.
      component.addAxis();
      component.addVariant();
      expect(component.draft().variants.length).toBeGreaterThan(1);
      expect(component.mlProjection()).toContain('con');
    });

    it('mlProjection refleja el modo one_per_variant', () => {
      component.addAxis();
      component.addVariant();
      component.setMode('ml', 'one_per_variant');
      expect(component.mlProjection()).toContain('publicaciones');
    });
  });

  describe('override-on-demand: effective / makeOwn / revert', () => {
    it('effective() devuelve el valor común cuando el campo está heredado', () => {
      const field = { inherited: true, value: 'propio' };
      expect(component.effective(field, 'común')).toBe('común');
    });

    it('effective() devuelve el valor propio cuando el campo no está heredado', () => {
      const field = { inherited: false, value: 'propio' };
      expect(component.effective(field, 'común')).toBe('propio');
    });

    it('makeOwn() marca el campo como propio y copia el valor común si está vacío', () => {
      const field = { inherited: true, value: '' };
      component.makeOwn(field, 'Nombre común');
      expect(field.inherited).toBeFalse();
      expect(field.value).toBe('Nombre común');
    });

    it('makeOwn() no pisa un valor propio ya cargado', () => {
      const field = { inherited: true, value: 'ya tenía algo' };
      component.makeOwn(field, 'Nombre común');
      expect(field.inherited).toBeFalse();
      expect(field.value).toBe('ya tenía algo');
    });

    it('revert() vuelve a marcar el campo como heredado', () => {
      const field = { inherited: false, value: 'propio' };
      component.revert(field);
      expect(field.inherited).toBeTrue();
    });

    it('makeOwn() y revert() disparan una nueva referencia de la señal draft', () => {
      const before = component.draft();
      component.makeOwn(component.draft().tn.nameEs, component.draft().common.baseName);
      const after = component.draft();
      expect(after).not.toBe(before);
    });
  });

  describe('setMode()', () => {
    it('cambia el mappingMode de ML sin afectar el de TN', () => {
      component.setMode('ml', 'one_per_variant');
      expect(component.draft().ml.mappingMode).toBe('one_per_variant');
      expect(component.draft().tn.mappingMode).toBe('single_with_variants');
    });

    it('cambia el mappingMode de TN sin afectar el de ML', () => {
      component.setMode('tn', 'one_per_variant');
      expect(component.draft().tn.mappingMode).toBe('one_per_variant');
      expect(component.draft().ml.mappingMode).toBe('single_with_variants');
    });
  });

  describe('variantes: addAxis / removeAxis / addVariant / removeVariant', () => {
    it('addAxis() agrega un eje vacío', () => {
      component.addAxis();
      expect(component.draft().axes.length).toBe(1);
      expect(component.draft().axes[0].name).toBe('');
    });

    it('addAxis() crea automáticamente una primera variante si no existía ninguna', () => {
      expect(component.draft().variants.length).toBe(0);
      component.addAxis();
      expect(component.draft().variants.length).toBe(1);
      expect(component.draft().variants[0].values).toEqual(['']);
    });

    it('addAxis() agrega un valor vacío por cada variante existente al sumar un segundo eje', () => {
      component.addAxis();
      component.addVariant();
      expect(component.draft().variants.length).toBe(2);

      component.addAxis();
      expect(component.draft().axes.length).toBe(2);
      for (const v of component.draft().variants) {
        expect(v.values.length).toBe(2);
      }
    });

    it('addAxis() no permite más de 3 ejes', () => {
      component.addAxis();
      component.addAxis();
      component.addAxis();
      expect(component.draft().axes.length).toBe(3);

      component.addAxis();
      expect(component.draft().axes.length).toBe(3);
    });

    it('removeAxis() quita el eje y el valor correspondiente de cada variante', () => {
      component.addAxis();
      component.addAxis();
      component.draft().variants[0].values = ['Negro', 'A4'];

      component.removeAxis(0);

      expect(component.draft().axes.length).toBe(1);
      expect(component.draft().variants[0].values).toEqual(['A4']);
    });

    it('removeAxis() vacía las variantes cuando no queda ningún eje', () => {
      component.addAxis();
      expect(component.draft().variants.length).toBe(1);

      component.removeAxis(0);

      expect(component.draft().axes).toEqual([]);
      expect(component.draft().variants).toEqual([]);
    });

    it('addVariant() agrega una variante con precio/stock en null y valores vacíos por eje', () => {
      component.addAxis();
      const countBefore = component.draft().variants.length;

      component.addVariant();

      const variants = component.draft().variants;
      expect(variants.length).toBe(countBefore + 1);
      const nueva = variants[variants.length - 1];
      expect(nueva.sku).toBe('');
      expect(nueva.values).toEqual(['']);
      expect(nueva.stock).toBeNull();
      expect(nueva.ml).toEqual({ price: null, pictureIds: [] });
      expect(nueva.tn).toEqual({ price: null, imageIds: [] });
      expect(nueva.id).toMatch(/^v\d+$/);
    });

    it('addVariant() genera ids únicos entre llamadas sucesivas', () => {
      component.addVariant();
      component.addVariant();
      const variants = component.draft().variants;
      const ids = variants.map((v) => v.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('removeVariant() quita solo la variante con el id indicado', () => {
      component.addVariant();
      component.addVariant();
      const [first, second] = component.draft().variants;

      component.removeVariant(first.id);

      expect(component.draft().variants.length).toBe(1);
      expect(component.draft().variants[0].id).toBe(second.id);
    });

    it('removeVariant() con un id inexistente no modifica la lista', () => {
      component.addVariant();
      const before = component.draft().variants.length;

      component.removeVariant('no-existe');

      expect(component.draft().variants.length).toBe(before);
    });
  });

  describe('atributos ML: required vs optional y envío', () => {
    it('buildPayloads() NO manda las características que quedaron vacías', () => {
      component.draft().ml.attributes = [
        { id: 'BRAND', name: 'Marca', value: 'Zona Cuaderno', required: true, inherited: false },
        { id: 'SHEETS_NUMBER', name: 'Cantidad de hojas', value: '', required: false, inherited: false },
        { id: 'SHEET_TYPE', name: 'Tipo de hoja', value: '   ', required: false, inherited: false }
      ];
      component.draft.set({ ...component.draft() });

      const ml = component.buildPayloads().ml as any;
      const ids = ml.attributes.map((a: any) => a.id);
      expect(ids).toContain('BRAND');
      // Las vacías (o solo espacios) se descartan.
      expect(ids).not.toContain('SHEETS_NUMBER');
      expect(ids).not.toContain('SHEET_TYPE');
    });

    it('buildPayloads() recorta espacios del value_name enviado', () => {
      component.draft().ml.attributes = [
        { id: 'MODEL', name: 'Modelo', value: '  A4-TD  ', required: false, inherited: false }
      ];
      component.draft.set({ ...component.draft() });

      const ml = component.buildPayloads().ml as any;
      expect(ml.attributes.find((a: any) => a.id === 'MODEL')).toEqual({ id: 'MODEL', value_name: 'A4-TD' });
    });

    it('mlRequiredAttrs()/mlOptionalAttrs() separan los atributos por obligatoriedad', () => {
      component.draft().ml.attributes = [
        { id: 'BRAND', name: 'Marca', value: '', required: true, inherited: false },
        { id: 'SHEETS_NUMBER', name: 'Cantidad de hojas', value: '', required: false, inherited: false }
      ];
      component.draft.set({ ...component.draft() });

      expect(component.mlRequiredAttrs().map((a) => a.id)).toEqual(['BRAND']);
      expect(component.mlOptionalAttrs().map((a) => a.id)).toEqual(['SHEETS_NUMBER']);
    });
  });

  describe('SEO con IA', () => {
    it('generateSeo() carga título, descripción Y tags en los campos SEO de TN', async () => {
      component.draft().common.baseName = 'Cuaderno A4 Tapa Dura';
      component.draft().common.brand = 'Zona Cuaderno';
      component.draft().ml.categoryName = 'Cuadernos';

      await component.generateSeo();

      expect(catalog.generateSeo).toHaveBeenCalled();
      expect(catalog.lastSeoInput.name).toBe('Cuaderno A4 Tapa Dura');
      expect(catalog.lastSeoInput.brand).toBe('Zona Cuaderno');
      expect(catalog.lastSeoInput.category).toBe('Cuadernos');
      expect(component.draft().tn.seoTitle).toBe('Cuaderno A4 | Zona Cuaderno');
      expect(component.draft().tn.seoDescription).toBe('Cuaderno premium de tapa dura.');
      // Las tags también las genera la IA (son parte del SEO).
      expect(component.draft().tn.tags).toBe('cuaderno a4, tapa dura, escolar');
      expect(component.seoError()).toBeNull();
    });

    it('generateSeo() usa las categorías de TN como contexto si no hay categoría de ML', async () => {
      component.draft().common.baseName = 'Cuaderno A4';
      component.draft().ml.categoryName = '';
      catalog.tnCategories = [
        { id: 10, name: 'Cuadernos', parent: null, subcategories: [], path: 'Librería › Cuadernos' }
      ];
      // ngOnInit ya cargó la lista vacía: la recargamos con el mock ya seteado.
      await component.loadTnCategories();
      component.draft().tn.categories = [10];

      await component.generateSeo();

      expect(catalog.lastSeoInput.category).toContain('Cuadernos');
    });

    it('generateSeo() sin nombre no llama a la IA y avisa', async () => {
      component.draft().common.baseName = '';
      await component.generateSeo();
      expect(catalog.generateSeo).not.toHaveBeenCalled();
      expect(component.seoError()).toContain('nombre');
    });

    it('generateSeo() muestra el error si el backend falla', async () => {
      catalog.generateSeo.and.returnValue(Promise.reject({ error: { error: 'Falta LLM_API_KEY' } }));
      component.draft().common.baseName = 'Cuaderno';

      await component.generateSeo();

      expect(component.seoError()).toBe('Falta LLM_API_KEY');
      expect(component.seoGenerating()).toBeFalse();
    });
  });

  describe('ML: "cuánto recibís" (comisiones)', () => {
    it('loadMlFee() con precio y categoría consulta las comisiones y setea el neto', async () => {
      component.draft().ml.basePrice = 1000;
      component.draft().ml.categoryId = 'MLA388307';
      catalog.listingPrices = { currency_id: 'ARS', sale_fee_amount: 130, listing_fee_amount: 0, percentage_fee: 13, net: 870 };

      await component.loadMlFee();

      expect(catalog.getMlListingPrices).toHaveBeenCalledWith(1000, 'MLA388307', component.draft().ml.listingType);
      expect(component.mlFee()).toEqual({ saleFee: 130, net: 870, currency: 'ARS', percentage: 13 });
    });

    it('loadMlFee() no consulta si falta precio o categoría (limpia el estado)', async () => {
      component.draft().ml.basePrice = null;
      component.draft().ml.categoryId = 'MLA388307';
      await component.loadMlFee();
      expect(catalog.getMlListingPrices).not.toHaveBeenCalled();
      expect(component.mlFee()).toBeNull();

      component.draft().ml.basePrice = 1000;
      component.draft().ml.categoryId = '';
      await component.loadMlFee();
      expect(catalog.getMlListingPrices).not.toHaveBeenCalled();
      expect(component.mlFee()).toBeNull();
    });
  });

  describe('imágenes: subida, galería, portada y por variante', () => {
    it('onImageFiles() sube el archivo al backend y agrega la imagen a la galería del canal', async () => {
      catalog.uploadResponse = { id: 'IMGX', name: 'foto.jpg', mime: 'image/jpeg', size: 3 };
      const file = new File([new Uint8Array([1, 2, 3])], 'foto.jpg', { type: 'image/jpeg' });

      await component.onImageFiles('ml', [file] as unknown as FileList);

      expect(catalog.uploadImage).toHaveBeenCalled();
      expect(component.draft().ml.images.length).toBe(1);
      expect(component.draft().ml.images[0].id).toBe('IMGX');
      expect(component.draft().tn.images.length).toBe(0);
    });

    it('onImageFiles() rechaza WEBP en ML con error inline y no sube', async () => {
      const file = new File([new Uint8Array([1])], 'x.webp', { type: 'image/webp' });
      await component.onImageFiles('ml', [file] as unknown as FileList);
      expect(catalog.uploadImage).not.toHaveBeenCalled();
      expect(component.imageError()).toContain('WEBP');
    });

    it('onImageFiles() respeta el tope de la galería (no supera mlMaxPictures)', async () => {
      component.mlMaxPictures.set(1);
      seedImage(component, 'ml', 'ya-hay');
      const file = new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' });
      await component.onImageFiles('ml', [file] as unknown as FileList);
      expect(catalog.uploadImage).not.toHaveBeenCalled();
      expect(component.draft().ml.images.length).toBe(1);
      expect(component.imageError()).toContain('Máximo');
    });

    it('makeCover() mueve la imagen elegida a la primera posición (portada)', () => {
      seedImage(component, 'ml', 'a');
      seedImage(component, 'ml', 'b');
      component.makeCover('ml', 1);
      expect(component.draft().ml.images.map((i) => i.id)).toEqual(['b', 'a']);
    });

    it('removeImage() quita la imagen, la desasigna de las variantes y la borra del backend', () => {
      seedImage(component, 'ml', 'a');
      component.addAxis();
      component.draft().variants[0].ml.pictureIds = ['a'];

      component.removeImage('ml', 0);

      expect(component.draft().ml.images.length).toBe(0);
      expect(component.draft().variants[0].ml.pictureIds).toEqual([]);
      expect(catalog.deleteImage).toHaveBeenCalledWith('a');
    });

    it('toggleVariantMlImage() agrega/quita y respeta el máximo por variación', () => {
      seedImage(component, 'ml', 'a');
      seedImage(component, 'ml', 'b');
      component.addAxis();
      const v = component.draft().variants[0];
      component.mlMaxPicturesPerVar.set(1);

      component.toggleVariantMlImage(v, 'a');
      expect(v.ml.pictureIds).toEqual(['a']);
      // ya llegó al máximo (1): no agrega la segunda.
      component.toggleVariantMlImage(v, 'b');
      expect(v.ml.pictureIds).toEqual(['a']);
      expect(component.imageError()).toContain('variación');
      // togglear la misma la quita.
      component.toggleVariantMlImage(v, 'a');
      expect(v.ml.pictureIds).toEqual([]);
    });

    it('toggleVariantTnImage() en single_with_variants deja SOLO UNA foto (TN limita a image_id)', () => {
      seedImage(component, 'tn', 'a');
      seedImage(component, 'tn', 'b');
      component.setMode('tn', 'single_with_variants');
      component.addAxis();
      const v = component.draft().variants[0];

      component.toggleVariantTnImage(v, 'a');
      expect(v.tn.imageIds).toEqual(['a']);
      // elegir otra reemplaza (no acumula) en modo single.
      component.toggleVariantTnImage(v, 'b');
      expect(v.tn.imageIds).toEqual(['b']);
      // togglear la misma la quita.
      component.toggleVariantTnImage(v, 'b');
      expect(v.tn.imageIds).toEqual([]);
    });

    it('toggleVariantTnImage() en one_per_variant permite VARIAS fotos por variante', () => {
      seedImage(component, 'tn', 'a');
      seedImage(component, 'tn', 'b');
      component.setMode('tn', 'one_per_variant');
      component.addAxis();
      const v = component.draft().variants[0];

      component.toggleVariantTnImage(v, 'a');
      component.toggleVariantTnImage(v, 'b');
      expect(v.tn.imageIds).toEqual(['a', 'b']);
      // togglear una la quita, deja la otra.
      component.toggleVariantTnImage(v, 'a');
      expect(v.tn.imageIds).toEqual(['b']);
    });
  });

  describe('publish()', () => {
    it('marca publishing en true y limpia publishResults al iniciar', () => {
      component.publish();
      expect(component.publishing()).toBeTrue();
      expect(component.publishResults()).toBeNull();
    });

    it('llama al backend y muestra los resultados por canal, apagando el flag de publicando', fakeAsync(() => {
      component.publish();
      flushMicrotasks();

      expect(catalog.publishProduct).toHaveBeenCalled();
      expect(component.publishing()).toBeFalse();
      const results = component.publishResults();
      expect(results).not.toBeNull();
      expect(results!.length).toBe(2);
      expect(results!.find((r) => r.channel === 'ml')?.status).toBe('ok');
      expect(results!.find((r) => r.channel === 'tn')?.status).toBe('ok');
    }));

    it('propaga el error como fallo en ambos canales si el backend rechaza', fakeAsync(() => {
      catalog.publishProduct.and.returnValue(Promise.reject({ error: { error: 'boom' } }));
      component.publish();
      flushMicrotasks();

      const results = component.publishResults()!;
      expect(results.every((r) => r.status === 'error')).toBeTrue();
      expect(results[0].detail).toBe('boom');
    }));

    it('buildPayloads() manda base_price y el base_stock compartido a ambos canales, y published:true en TN', () => {
      component.draft().ml.basePrice = 3500;
      component.draft().common.baseStock = 10;
      const payload = component.buildPayloads();
      const ml = payload.ml as any;
      const tn = payload.tn as any;
      expect(ml.base_price).toBe(3500);
      expect(ml.base_stock).toBe(10);
      expect(tn.base_stock).toBe(10);
      expect(tn.published).toBeTrue();
    });

    it('buildPayloads() manda image_ids por canal (en orden), picture_ids/image_ids por variante y el MISMO stock a ml y tn', () => {
      seedImage(component, 'ml', 'm1');
      seedImage(component, 'ml', 'm2');
      seedImage(component, 'tn', 't1');
      seedImage(component, 'tn', 't2');
      component.setMode('tn', 'one_per_variant');
      component.addAxis();
      const v = component.draft().variants[0];
      v.ml.pictureIds = ['m2'];
      v.tn.imageIds = ['t1', 't2'];
      v.stock = 7;

      const payload = component.buildPayloads();
      const ml = payload.ml as any;
      const tn = payload.tn as any;
      const variant = (payload.variants as any[])[0];

      expect(ml.image_ids).toEqual(['m1', 'm2']);
      expect(tn.image_ids).toEqual(['t1', 't2']);
      expect(variant.ml.picture_ids).toEqual(['m2']);
      expect(variant.tn.image_ids).toEqual(['t1', 't2']);
      expect(variant.ml.stock).toBe(7);
      expect(variant.tn.stock).toBe(7);
    });
  });

  describe('buildPayloads()', () => {
    // El formulario ahora arranca vacío; poblamos datos de ejemplo para ejercitar el armado.
    beforeEach(() => {
      const d = component.draft();
      d.common = {
        ...d.common,
        baseName: 'Cuaderno A4 Tapa Dura',
        sku: 'CUA-A4-TD',
        brand: 'Zona Cuaderno',
        barcode: '7791234567890',
        weightG: 480,
        lengthCm: 30,
        widthCm: 22,
        heightCm: 3
      };
      d.ml.title = { inherited: false, value: 'Cuaderno A4 Tapa Dura Premium Anillado 480g' };
      component.draft.set({ ...d });
    });

    it('no manda dimensions en shipping (peso/medidas van como SELLER_PACKAGE_* que arma el backend desde common)', () => {
      const payload = component.buildPayloads();
      const ml = payload.ml as any;
      expect(ml.shipping.dimensions).toBeUndefined();
      // Las medidas viajan en common para que el backend arme los atributos de paquete.
      expect(payload.common.weightG).toBe(480);
      expect(payload.common.lengthCm).toBe(30);
    });

    it('usa el valor efectivo (propio u heredado) para el título y la descripción de ML', () => {
      const payload = component.buildPayloads();
      const ml = payload.ml as any;
      expect(ml.title).toBe(component.draft().ml.title.value);
    });

    it('agrega el SELLER_SKU al final de los atributos de ML con el SKU común', () => {
      const payload = component.buildPayloads();
      const ml = payload.ml as any;
      const last = ml.attributes[ml.attributes.length - 1];
      expect(last).toEqual({ id: 'SELLER_SKU', value_name: component.draft().common.sku });
    });

    it('arma el nombre de TN con el idioma "es" efectivo y "pt" undefined si está vacío', () => {
      component.draft().tn.namePt = '';
      const payload = component.buildPayloads();
      const tn = payload.tn as any;
      expect(tn.name.es).toBe(component.draft().common.baseName);
      expect(tn.name.pt).toBeUndefined();
    });

    it('deja "handle" undefined en TN cuando no se cargó ninguno', () => {
      component.draft().tn.handle = '';
      const payload = component.buildPayloads();
      const tn = payload.tn as any;
      expect(tn.handle).toBeUndefined();
    });

    it('arma "handle" en TN como { es } cuando sí está cargado', () => {
      component.draft().tn.handle = 'mi-handle';
      const payload = component.buildPayloads();
      const tn = payload.tn as any;
      expect(tn.handle).toEqual({ es: 'mi-handle' });
    });

    it('sin variantes, arma un único registro de variante TN a partir de los datos comunes', () => {
      const payload = component.buildPayloads();
      const tn = payload.tn as any;
      expect(tn.variants.length).toBe(1);
      expect(tn.variants[0]).toEqual({
        sku: component.draft().common.sku,
        barcode: component.draft().common.barcode,
        weight: component.draft().common.weightG! / 1000,
        width: component.draft().common.widthCm,
        height: component.draft().common.heightCm,
        depth: component.draft().common.lengthCm
      });
    });

    it('con variantes, arma un registro TN por variante con nombres de eje, valores y el stock compartido', () => {
      component.addAxis();
      component.draft().axes[0].name = 'Color';
      component.draft().variants[0].sku = 'CUA-A4-TD-NEGRO';
      component.draft().variants[0].values = ['Negro'];
      component.draft().variants[0].stock = 5;
      component.draft().variants[0].tn = { price: 1000, imageIds: [] };

      const payload = component.buildPayloads();
      const tn = payload.tn as any;

      expect(tn.variants.length).toBe(1);
      expect(tn.variants[0].sku).toBe('CUA-A4-TD-NEGRO');
      expect(tn.variants[0].values).toEqual([{ es: 'Color: Negro' }]);
      expect(tn.variants[0].price).toBe(1000);
      expect(tn.variants[0].stock).toBe(5);
    });

    it('convierte el peso de gramos a kilogramos para TN, o lo deja en null si no hay peso', () => {
      component.draft().common.weightG = null;
      const payload = component.buildPayloads();
      const tn = payload.tn as any;
      expect(tn.variants[0].weight).toBeNull();
    });
  });

  describe('dismissResults() / retry()', () => {
    it('dismissResults() limpia los resultados de publicación', fakeAsync(() => {
      component.publish();
      flushMicrotasks();
      expect(component.publishResults()).not.toBeNull();

      component.dismissResults();

      expect(component.publishResults()).toBeNull();
    }));

    it('retry("ml") re-publica SOLO el canal ML (channels:["ml"]) y deja intacto el resultado previo de TN', fakeAsync(() => {
      component.publishResults.set([
        { channel: 'ml', status: 'error', detail: 'Error de categoría' },
        { channel: 'tn', status: 'ok', detail: 'Producto #1 creado' }
      ]);
      catalog.publishResponse = {
        results: [
          { channel: 'ml', status: 'ok', detail: 'Publicación MLA-9 creada' },
          { channel: 'tn', status: 'ok', detail: 'no-debería-usarse' }
        ]
      };

      component.retry('ml');
      flushMicrotasks();

      expect(catalog.publishProduct).toHaveBeenCalled();
      expect(catalog.lastPublishPayload.channels).toEqual(['ml']);
      const results = component.publishResults()!;
      const ml = results.find((r) => r.channel === 'ml')!;
      const tn = results.find((r) => r.channel === 'tn')!;
      expect(ml.status).toBe('ok');
      expect(ml.detail).toContain('MLA-9');
      // TN no se re-publicó: conserva su resultado anterior (no se duplica).
      expect(tn.status).toBe('ok');
      expect(tn.detail).toBe('Producto #1 creado');
    }));

    it('retry("tn") re-publica SOLO el canal TN sin tocar ML', fakeAsync(() => {
      component.publishResults.set([
        { channel: 'ml', status: 'ok', detail: 'Publicación MLA-5 creada' },
        { channel: 'tn', status: 'error', detail: 'stock inválido' }
      ]);
      catalog.publishResponse = {
        results: [
          { channel: 'ml', status: 'ok', detail: 'no-debería-usarse' },
          { channel: 'tn', status: 'ok', detail: 'Producto #7 creado' }
        ]
      };

      component.retry('tn');
      flushMicrotasks();

      expect(catalog.lastPublishPayload.channels).toEqual(['tn']);
      const results = component.publishResults()!;
      expect(results.find((r) => r.channel === 'ml')!.detail).toBe('Publicación MLA-5 creada');
      const tn = results.find((r) => r.channel === 'tn')!;
      expect(tn.status).toBe('ok');
      expect(tn.detail).toContain('#7');
    }));
  });

  describe('borradores locales (guardar / restaurar / listar / eliminar)', () => {
    it('saveDraft() persiste el draft en la lista y setea draftSavedAt + currentDraftId', () => {
      component.draft().common.baseName = 'Cuaderno Test';
      expect(component.draftSavedAt()).toBeNull();
      expect(component.currentDraftId()).toBeNull();

      component.saveDraft();

      expect(component.draftSavedAt()).not.toBeNull();
      expect(component.currentDraftId()).not.toBeNull();
      const list = JSON.parse(localStorage.getItem('zc-crear-producto-drafts')!);
      expect(list.length).toBe(1);
      expect(list[0].draft.common.baseName).toBe('Cuaderno Test');
    });

    it('saveDraft() no persiste el previewUrl de las imágenes (solo id/name)', () => {
      seedImage(component, 'ml', 'img-1');
      component.saveDraft();
      const list = JSON.parse(localStorage.getItem('zc-crear-producto-drafts')!);
      expect(list[0].draft.ml.images).toEqual([{ id: 'img-1', name: 'img-1.jpg' }]);
    });

    it('guardar dos veces seguidas mientras se edita el MISMO borrador actualiza la entrada (no duplica)', () => {
      component.draft().common.baseName = 'Versión 1';
      component.saveDraft();
      const idAfterFirst = component.currentDraftId();

      component.draft().common.baseName = 'Versión 2';
      component.saveDraft();

      expect(component.currentDraftId()).toBe(idAfterFirst);
      const list = JSON.parse(localStorage.getItem('zc-crear-producto-drafts')!);
      expect(list.length).toBe(1);
      expect(list[0].draft.common.baseName).toBe('Versión 2');
    });

    it('startNewDraft() + saveDraft() crea una SEGUNDA entrada distinta (varios borradores a la vez)', () => {
      component.draft().common.baseName = 'Producto A';
      component.saveDraft();

      component.startNewDraft();
      component.draft().common.baseName = 'Producto B';
      component.saveDraft();

      const list = JSON.parse(localStorage.getItem('zc-crear-producto-drafts')!);
      expect(list.length).toBe(2);
      const names = list.map((e: any) => e.draft.common.baseName).sort();
      expect(names).toEqual(['Producto A', 'Producto B']);
    });

    it('el borrador guardado más reciente se restaura al crear el componente de nuevo (ngOnInit)', () => {
      component.draft().common.baseName = 'Restaurado';
      component.mlMaxPictures.set(7);
      seedImage(component, 'tn', 'img-9');
      component.saveDraft();

      // Nueva instancia del componente: simula reabrir la página.
      const fixture2 = TestBed.createComponent(CrearProductoComponent);
      const component2 = fixture2.componentInstance;
      fixture2.detectChanges();

      expect(component2.draft().common.baseName).toBe('Restaurado');
      expect(component2.mlMaxPictures()).toBe(7);
      expect(component2.draftRestored()).toBeTrue();
      expect(component2.draft().tn.images[0].id).toBe('img-9');
      // El previewUrl se reconstruye apuntando al endpoint del backend, no queda vacío/roto.
      expect(component2.draft().tn.images[0].previewUrl).toContain('/products/images/img-9');
    });

    it('sin borradores guardados, draftRestored() queda en false y savedDrafts() vacío', () => {
      expect(component.draftRestored()).toBeFalse();
      expect(component.savedDrafts()).toEqual([]);
    });

    it('un borrador corrupto en localStorage no rompe la página (se ignora)', () => {
      localStorage.setItem('zc-crear-producto-drafts', '{not-json');
      const fixture2 = TestBed.createComponent(CrearProductoComponent);
      expect(() => fixture2.detectChanges()).not.toThrow();
      expect(fixture2.componentInstance.draftRestored()).toBeFalse();
    });

    it('migra automáticamente el borrador de la versión anterior (clave singular) a la lista nueva', () => {
      localStorage.setItem(
        'zc-crear-producto-draft',
        JSON.stringify({ savedAt: Date.now(), mlMaxPictures: 12, mlMaxPicturesPerVar: 10, draft: { ...emptyDraft(), common: { ...emptyDraft().common, baseName: 'Viejo' } } })
      );
      const fixture2 = TestBed.createComponent(CrearProductoComponent);
      fixture2.detectChanges();

      expect(fixture2.componentInstance.draft().common.baseName).toBe('Viejo');
      // La clave vieja se borra tras migrar.
      expect(localStorage.getItem('zc-crear-producto-draft')).toBeNull();
      expect(JSON.parse(localStorage.getItem('zc-crear-producto-drafts')!).length).toBe(1);
    });

    it('savedDrafts() lista todos los borradores guardados, más reciente primero', () => {
      component.draft().common.baseName = 'Primero';
      component.saveDraft();
      component.startNewDraft();
      component.draft().common.baseName = 'Segundo';
      component.saveDraft();

      const list = component.savedDrafts();
      expect(list.length).toBe(2);
      expect(list[0].label).toBe('Segundo');
      expect(list[1].label).toBe('Primero');
    });

    it('openDraft() carga el borrador elegido y actualiza currentDraftId', () => {
      component.draft().common.baseName = 'A';
      component.saveDraft();
      const idA = component.currentDraftId()!;
      component.startNewDraft();
      component.draft().common.baseName = 'B';
      component.saveDraft();

      component.openDraft(idA);

      expect(component.draft().common.baseName).toBe('A');
      expect(component.currentDraftId()).toBe(idA);
      expect(component.draftsPanelOpen()).toBeFalse();
    });

    it('deleteDraft() elimina la entrada de la lista sin tocar los demás borradores', () => {
      component.draft().common.baseName = 'A';
      component.saveDraft();
      const idA = component.currentDraftId()!;
      component.startNewDraft();
      component.draft().common.baseName = 'B';
      component.saveDraft();

      component.deleteDraft(idA);

      const list = component.savedDrafts();
      expect(list.length).toBe(1);
      expect(list[0].label).toBe('B');
    });

    it('deleteDraft() del borrador que se está editando también limpia el formulario', () => {
      component.draft().common.baseName = 'A';
      component.saveDraft();
      const idA = component.currentDraftId()!;

      component.deleteDraft(idA);

      expect(component.draft().common.baseName).toBe('');
      expect(component.currentDraftId()).toBeNull();
    });

    it('startNewDraft() limpia el formulario pero NO borra el borrador ya guardado', () => {
      component.draft().common.baseName = 'Algo';
      component.mlMaxPictures.set(5);
      component.saveDraft();

      component.startNewDraft();

      expect(component.draft().common.baseName).toBe('');
      expect(component.mlMaxPictures()).toBe(12);
      expect(component.draftSavedAt()).toBeNull();
      expect(component.draftRestored()).toBeFalse();
      expect(component.currentDraftId()).toBeNull();
      // El borrador previamente guardado sigue en la lista.
      expect(component.savedDrafts().length).toBe(1);
    });

    it('al publicar con éxito en AMBOS canales, se borra el borrador actual de la lista', fakeAsync(() => {
      component.saveDraft();
      expect(component.savedDrafts().length).toBe(1);

      component.publish();
      flushMicrotasks();

      expect(component.savedDrafts().length).toBe(0);
      expect(component.draftSavedAt()).toBeNull();
      expect(component.currentDraftId()).toBeNull();
    }));

    it('si un canal falla al publicar, el borrador guardado se conserva', fakeAsync(() => {
      catalog.publishResponse = {
        results: [
          { channel: 'ml', status: 'ok', detail: 'Publicación MLA-1 creada' },
          { channel: 'tn', status: 'error', detail: 'stock inválido' }
        ]
      };
      component.saveDraft();

      component.publish();
      flushMicrotasks();

      expect(component.savedDrafts().length).toBe(1);
    }));
  });

  describe('Categorías TN (multi-select)', () => {
    it('toggleTnCategory() agrega y luego quita el id', () => {
      expect(component.isTnCategorySelected(10)).toBeFalse();
      component.toggleTnCategory(10);
      expect(component.draft().tn.categories).toEqual([10]);
      expect(component.isTnCategorySelected(10)).toBeTrue();
      component.toggleTnCategory(10);
      expect(component.draft().tn.categories).toEqual([]);
    });

    it('permite seleccionar varias categorías', () => {
      component.toggleTnCategory(10);
      component.toggleTnCategory(20);
      expect(component.draft().tn.categories).toEqual([10, 20]);
    });

    it('tnCategoryName() devuelve el path de la categoría o un fallback con el id', () => {
      catalog.tnCategories = [{ id: 10, name: 'Cuadernos', parent: null, subcategories: [], path: 'Librería › Cuadernos' }];
      component.tnCategories.set(catalog.tnCategories);
      expect(component.tnCategoryName(10)).toBe('Librería › Cuadernos');
      expect(component.tnCategoryName(99)).toBe('#99');
    });

    it('buildPayloads() manda categories como array de ids (no string)', () => {
      component.toggleTnCategory(10);
      component.toggleTnCategory(20);
      const tn = component.buildPayloads().tn as any;
      expect(tn.categories).toEqual([10, 20]);
    });
  });

  describe('Categorías ML (predictor + atributos)', () => {
    it('applyMlPrediction() fija la categoría y precarga TODAS las características (obligatorias + opcionales)', fakeAsync(() => {
      catalog.mlAttributes = [
        { id: 'BRAND', name: 'Marca', valueType: 'string', required: true, allowedValues: [] },
        { id: 'SHEETS_NUMBER', name: 'Cantidad de hojas', valueType: 'number', required: false, allowedValues: [] },
        { id: 'PRODUCT_TYPE', name: 'Tipo', valueType: 'list', required: true, allowedValues: [{ id: '1', name: 'Cuaderno' }] }
      ];
      const pred: MlCategoryPrediction = {
        domain_id: 'MLA-NOTEBOOKS',
        domain_name: 'Cuadernos',
        category_id: 'MLA388307',
        category_name: 'Cuadernos',
        attributes: [{ id: 'PRODUCT_TYPE', name: 'Tipo', value_id: '1', value_name: 'Cuaderno' }]
      };

      component.applyMlPrediction(pred);
      tick();

      expect(component.draft().ml.categoryId).toBe('MLA388307');
      expect(component.draft().ml.categoryName).toBe('Cuadernos');
      // Carga TODAS (incluida la opcional "Cantidad de hojas"), respetando el orden del backend.
      const ids = component.draft().ml.attributes.map((a) => a.id);
      expect(ids).toEqual(['BRAND', 'SHEETS_NUMBER', 'PRODUCT_TYPE']);
      // La opcional queda marcada como no obligatoria.
      expect(component.mlOptionalAttrs().map((a) => a.id)).toEqual(['SHEETS_NUMBER']);
      // BRAND hereda de la marca común.
      const brand = component.draft().ml.attributes.find((a) => a.id === 'BRAND')!;
      expect(brand.inherited).toBeTrue();
      expect(brand.value).toBe(component.draft().common.brand);
      // PRODUCT_TYPE trae el value_id pre-inferido por el predictor.
      const type = component.draft().ml.attributes.find((a) => a.id === 'PRODUCT_TYPE')!;
      expect(type.valueId).toBe('1');
    }));

    it('buildPayloads() manda value_id para atributos de lista y value_name para el resto', fakeAsync(() => {
      catalog.mlAttributes = [
        { id: 'PRODUCT_TYPE', name: 'Tipo', valueType: 'list', required: true, allowedValues: [{ id: '1', name: 'Cuaderno' }] }
      ];
      component.applyMlPrediction({
        domain_id: 'd', domain_name: 'd', category_id: 'MLA388307', category_name: 'Cuadernos',
        attributes: [{ id: 'PRODUCT_TYPE', name: 'Tipo', value_id: '1', value_name: 'Cuaderno' }]
      });
      tick();

      const ml = component.buildPayloads().ml as any;
      const productType = ml.attributes.find((a: any) => a.id === 'PRODUCT_TYPE');
      expect(productType).toEqual({ id: 'PRODUCT_TYPE', value_id: '1' });
      // SELLER_SKU sigue yendo por value_name.
      const last = ml.attributes[ml.attributes.length - 1];
      expect(last).toEqual({ id: 'SELLER_SKU', value_name: component.draft().common.sku });
    }));

    it('clearMlCategory() limpia id, nombre y atributos', () => {
      component.draft().ml.categoryId = 'MLA1';
      component.draft().ml.categoryName = 'X';
      component.clearMlCategory();
      expect(component.draft().ml.categoryId).toBe('');
      expect(component.draft().ml.categoryName).toBe('');
      expect(component.draft().ml.attributes).toEqual([]);
    });

    it('predictMlCategory() sin título no llama al servicio y setea error', fakeAsync(() => {
      component.draft().common.baseName = '';
      component.draft().ml.title = { inherited: false, value: '' };
      component.predictMlCategory();
      tick();
      expect(catalog.predictMlCategory).not.toHaveBeenCalled();
      expect(component.mlPredictError()).toContain('título');
    }));

    it('openMlNode() carga el detalle de la categoría en el árbol', fakeAsync(() => {
      catalog.mlNodes['MLA1367'] = {
        id: 'MLA1367', name: 'Arte, Librería', path_from_root: [], leaf: false, listing_allowed: true,
        children_categories: [{ id: 'MLA111', name: 'Librería' }], max_pictures: 12, max_pictures_per_var: 10
      };
      component.openMlNode('MLA1367');
      tick();
      expect(component.mlTreeNode()?.id).toBe('MLA1367');
      expect(component.currentMlChildren().length).toBe(1);
    }));
  });
});
