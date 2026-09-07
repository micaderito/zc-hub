import { ComponentFixture, TestBed, fakeAsync, flush, flushMicrotasks, tick } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of } from 'rxjs';

import { CrearProductoComponent } from './crear-producto.component';
import {
  CatalogService,
  MlCategoryAttribute,
  MlCategoryNode,
  MlCategoryPrediction,
  MlCategoryRef,
  PublishJobSummary,
  PublishResponse,
  TnCategory,
  UploadedImage
} from '../../core/services/catalog.service';
import { PricingConfig, PricingService } from '../../core/services/pricing.service';
import { Channel, ProductVariant, emptyDraft, inherited } from './product-draft.model';

/** Config default de /precios (idéntica a DEFAULT_SETTINGS de pricing-math.ts). */
const PRICING_CONFIG: PricingConfig = {
  settings: {
    commissionPct: 15,
    taxes: 300,
    shippingCost: 6500,
    freeShippingThreshold: 33000,
    cardMultiplier: 1.3,
    roundStep: 50,
    defaultMarginPct: 100,
    defaultDiscount1: 25,
    defaultDiscount2: 5
  },
  tiers: [
    { maxPrice: 15000, fixedFee: 1115 },
    { maxPrice: 25000, fixedFee: 2300 },
    { maxPrice: 33000, fixedFee: 2810 },
    { maxPrice: null, fixedFee: 0 }
  ],
  updatedAt: null
};

class PricingServiceMock {
  getConfig = jasmine.createSpy('getConfig').and.callFake(() => of(PRICING_CONFIG));
}

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

  /*
   * Borradores + publicación en background (backend): un Map en memoria hace de "base de datos"
   * para que guardar/reabrir/listar se comporten de forma realista dentro de un mismo test — y
   * `getPublishJob` sintetiza { job, units } a partir de `publishResponse` (arriba), así que los
   * tests que ya seteaban `catalog.publishResponse = {...}` para el POST síncrono viejo siguen
   * funcionando igual con el flujo nuevo (encolar + pollear), sin tener que reescribirlos.
   */
  draftsDb = new Map<string, { name: string | null; sku: string | null; draft: any; createdAt: string; updatedAt: string }>();
  private draftSeq = 0;
  private jobSeq = 0;
  private jobChannels = new Map<string, ('ml' | 'tn')[] | undefined>();

  private draftSummary(id: string) {
    const d = this.draftsDb.get(id)!;
    return { id, name: d.name, sku: d.sku, status: 'draft' as const, createdAt: d.createdAt, updatedAt: d.updatedAt };
  }

  listDrafts = jasmine.createSpy('listDrafts').and.callFake(() =>
    Promise.resolve([...this.draftsDb.keys()].map((id) => this.draftSummary(id)).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)))
  );
  createDraft = jasmine.createSpy('createDraft').and.callFake((body: { name?: string; sku?: string; draft: unknown }) => {
    const id = `d${++this.draftSeq}`;
    const now = new Date(Date.now() + this.draftSeq).toISOString(); // ids crecientes → updatedAt creciente, sin depender del reloj real
    this.draftsDb.set(id, { name: body.name ?? null, sku: body.sku ?? null, draft: body.draft, createdAt: now, updatedAt: now });
    return Promise.resolve({ id });
  });
  updateDraft = jasmine.createSpy('updateDraft').and.callFake((id: string, body: { name?: string; sku?: string; draft: unknown }) => {
    const d = this.draftsDb.get(id);
    if (!d) return Promise.resolve({ ok: false });
    d.name = body.name ?? null;
    d.sku = body.sku ?? null;
    d.draft = body.draft;
    d.updatedAt = new Date(Date.now() + ++this.draftSeq).toISOString();
    return Promise.resolve({ ok: true });
  });
  getDraft = jasmine.createSpy('getDraft').and.callFake((id: string) => {
    const d = this.draftsDb.get(id);
    if (!d) return Promise.reject({ error: { error: 'Borrador no encontrado' } });
    return Promise.resolve({ ...this.draftSummary(id), draft: d.draft, jobs: [] });
  });
  deleteDraft = jasmine.createSpy('deleteDraft').and.callFake((id: string) => {
    this.draftsDb.delete(id);
    return Promise.resolve({ ok: true });
  });

  retryPublishJob = jasmine.createSpy('retryPublishJob').and.callFake(() => Promise.resolve({ ok: true }));
  deletePublishJob = jasmine.createSpy('deletePublishJob').and.callFake(() => Promise.resolve({ ok: true }));

  publishDraft = jasmine
    .createSpy('publishDraft')
    .and.callFake((id: string, payload: unknown, channels?: ('ml' | 'tn')[]) => {
      this.lastPublishPayload = { ...(payload as object), channels };
      const jobId = `j${++this.jobSeq}`;
      this.jobChannels.set(jobId, channels);
      return Promise.resolve({ jobId });
    });

  getPublishJob = jasmine.createSpy('getPublishJob').and.callFake((jobId: string) => {
    const channels = this.jobChannels.get(jobId);
    const results = channels ? this.publishResponse.results.filter((r) => channels.includes(r.channel)) : this.publishResponse.results;
    const units = results.map((r, i) => ({ channel: r.channel, unitKey: '', seq: i, status: r.status, externalId: null, detail: r.detail, updatedAt: '' }));
    const status = results.length && results.every((r) => r.status === 'ok') ? 'done' : 'error';
    return Promise.resolve({
      job: {
        id: jobId,
        draftId: 'd',
        channels: (channels ?? ['ml', 'tn']).join(','),
        status,
        attempts: 1,
        lastError: status === 'error' ? (results.find((r) => r.status === 'error')?.detail ?? null) : null,
        createdAt: '',
        updatedAt: '',
        finishedAt: ''
      },
      units
    });
  });

  uploadResponse: UploadedImage = { id: 'IMG1', name: 'a.jpg', mime: 'image/jpeg', size: 3 };
  uploadImage = jasmine.createSpy('upload').and.callFake(() => Promise.resolve(this.uploadResponse));
  uploadImageFile = jasmine.createSpy('uploadFile').and.callFake(() => Promise.resolve(this.uploadResponse));
  uploadThumb = jasmine.createSpy('uploadThumb').and.callFake(() => Promise.resolve({ ok: true }));
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

/**
 * Mock controlable de `uploadImageFile`: la subida queda pendiente hasta llamar a `.resolve()`.
 * `onImageFiles()` genera la miniatura en un Worker real antes de llamar a `uploadImageFile`
 * (createImageBitmap corre en el browser real de Karma), así que hay un salto async genuino entre
 * "se agregó el placeholder" y "se llamó a uploadImageFile" — `.called` deja esperar ese salto en
 * vez de asumir que ya pasó (evita un test flaky por timing del worker).
 */
function deferredUpload(catalog: CatalogServiceMock): { called: Promise<void>; resolve(v: UploadedImage): void } {
  let resolveFn: ((v: UploadedImage) => void) | null = null;
  let notifyCalled!: () => void;
  const called = new Promise<void>((res) => {
    notifyCalled = res;
  });
  catalog.uploadImageFile.and.callFake(
    () =>
      new Promise<UploadedImage>((res) => {
        resolveFn = res;
        notifyCalled();
      })
  );
  return {
    called,
    resolve(v: UploadedImage) {
      if (!resolveFn) throw new Error('uploadImageFile todavía no fue llamado');
      resolveFn(v);
    }
  };
}

describe('CrearProductoComponent', () => {
  let component: CrearProductoComponent;
  let fixture: ComponentFixture<CrearProductoComponent>;
  let catalog: CatalogServiceMock;

  const clearDraftStorage = () => {
    localStorage.removeItem('zc-crear-producto-draft');
    localStorage.removeItem('zc-crear-producto-drafts');
    localStorage.removeItem('zc-crear-producto-drafts-migrated-to-backend');
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
        { provide: CatalogService, useValue: catalog },
        { provide: PricingService, useValue: new PricingServiceMock() }
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
      expect(nueva.id).toMatch(/^v[a-z0-9]+$/);
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

  describe('rentabilidad: costPreview() / mlBreakdown() / tnBreakdown()', () => {
    it('sin costo cargado, no hay preview ni desglose', () => {
      expect(component.hasCost()).toBeFalse();
      expect(component.costPreview()).toBeNull();
      expect(component.mlBreakdown(19900)).toBeNull();
    });

    it('con costo por bulto, calcula lo mismo que el motor de /precios (fila 30700 de Punto Cero)', () => {
      const d = component.draft();
      d.cost = { mode: 'bulk', bulkPrice: 70400, bulkQty: 8, discount1: 25, discount2: 5, unitCost: null, marginPct: 100 };
      component.touch();

      const cp = component.costPreview();
      expect(cp).toBeTruthy();
      expect(cp!.unitCost).toBe(6270);
      expect(cp!.valorFinal).toBe(12540);
      expect(cp!.tn.transfer).toBe(12550);
      expect(cp!.tn.list).toBe(16350);
    });

    it('con costo unitario directo, mlBreakdown() del precio ingresado neteá al menos el costo con la ganancia pedida', () => {
      const d = component.draft();
      d.cost = { mode: 'unit', bulkPrice: null, bulkQty: null, discount1: 0, discount2: 0, unitCost: 7000, marginPct: 100 };
      component.touch();

      const cp = component.costPreview()!;
      const b = component.mlBreakdown(cp.ml)!;
      expect(b.net).toBeGreaterThanOrEqual(cp.valorFinal - 1e-6);
      expect(b.marginPct).not.toBeNull();
    });

    it('mlFreeShippingZone() es true solo cuando el precio de ML supera el umbral de envío gratis', () => {
      component.draft().ml.basePrice = 20000;
      component.touch(); // computed() solo recalcula cuando cambia la referencia de la señal draft
      expect(component.mlFreeShippingZone()).toBeFalse();
      component.draft().ml.basePrice = 40000;
      component.touch();
      expect(component.mlFreeShippingZone()).toBeTrue();
    });
  });

  describe('imágenes: subida, galería, portada y por variante', () => {
    it('onImageFiles() sube el archivo ORIGINAL (sin base64/JSON) y agrega la imagen a la galería del canal', async () => {
      catalog.uploadResponse = { id: 'IMGX', name: 'foto.jpg', mime: 'image/jpeg', size: 3 };
      const file = new File([new Uint8Array([1, 2, 3])], 'foto.jpg', { type: 'image/jpeg' });

      await component.onImageFiles('ml', [file] as unknown as FileList);

      expect(catalog.uploadImageFile).toHaveBeenCalledWith(file);
      expect(component.draft().ml.images.length).toBe(1);
      expect(component.draft().ml.images[0].id).toBe('IMGX');
      expect(component.draft().ml.images[0].uploading).toBeFalse();
      expect(component.draft().tn.images.length).toBe(0);
    });

    it('onImageFiles() marca la fila como uploading mientras el original se sube (bloquea publish/saveDraft)', async () => {
      const upload = deferredUpload(catalog);
      const file = new File([new Uint8Array([1, 2, 3])], 'foto.jpg', { type: 'image/jpeg' });

      // El placeholder se agrega SINCRÓNICAMENTE (antes de la primera pausa async): se puede
      // ver de entrada, incluso mientras el original todavía se está subiendo.
      const pending = component.onImageFiles('ml', [file] as unknown as FileList);
      expect(component.draft().ml.images.length).toBe(1);
      expect(component.draft().ml.images[0].uploading).toBeTrue();
      expect(component.hasPendingUploads()).toBeTrue();

      await upload.called; // espera a que termine la miniatura y arranque la subida del original
      upload.resolve({ id: 'IMGY', name: 'foto.jpg', mime: 'image/jpeg', size: 3 });
      await pending;

      expect(component.draft().ml.images[0].uploading).toBeFalse();
      expect(component.draft().ml.images[0].id).toBe('IMGY');
      expect(component.hasPendingUploads()).toBeFalse();
    });

    it('onImageFiles() rechaza WEBP en ML con error inline y no sube', async () => {
      const file = new File([new Uint8Array([1])], 'x.webp', { type: 'image/webp' });
      await component.onImageFiles('ml', [file] as unknown as FileList);
      expect(catalog.uploadImageFile).not.toHaveBeenCalled();
      expect(component.imageError()).toContain('WEBP');
    });

    it('onImageFiles() respeta el tope de la galería (no supera mlMaxPictures)', async () => {
      component.mlMaxPictures.set(1);
      seedImage(component, 'ml', 'ya-hay');
      const file = new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' });
      await component.onImageFiles('ml', [file] as unknown as FileList);
      expect(catalog.uploadImageFile).not.toHaveBeenCalled();
      expect(component.draft().ml.images.length).toBe(1);
      expect(component.imageError()).toContain('Máximo');
    });

    it('onImageFiles() sube varias fotos EN PARALELO, no una detrás de la otra', async () => {
      const files = [1, 2, 3].map((n) => new File([new Uint8Array([n])], `f${n}.jpg`, { type: 'image/jpeg' }));
      let inFlight = 0;
      let maxInFlight = 0;
      catalog.uploadImageFile.and.callFake(
        (f: File) =>
          new Promise<UploadedImage>((resolve) => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            setTimeout(() => {
              inFlight--;
              resolve({ id: `IMG-${f.name}`, name: f.name, mime: 'image/jpeg', size: 1 });
            }, 0);
          })
      );

      await component.onImageFiles('ml', files as unknown as FileList);

      expect(maxInFlight).toBeGreaterThan(1);
      expect(component.draft().ml.images.map((i) => i.id).sort()).toEqual(['IMG-f1.jpg', 'IMG-f2.jpg', 'IMG-f3.jpg']);
    });

    it('publish() y saveDraft() se bloquean mientras haya fotos subiendo', async () => {
      const upload = deferredUpload(catalog);
      const file = new File([new Uint8Array([1])], 'foto.jpg', { type: 'image/jpeg' });
      const pending = component.onImageFiles('ml', [file] as unknown as FileList);

      await component.publish();
      expect(catalog.publishProduct).not.toHaveBeenCalled();
      expect(component.imageError()).toContain('publicar');

      component.saveDraft();
      expect(component.currentDraftId()).toBeNull();
      expect(component.imageError()).toContain('guardar');

      await upload.called;
      upload.resolve({ id: 'IMGZ', name: 'foto.jpg', mime: 'image/jpeg', size: 1 });
      await pending;
    });

    it('removeImage() de una foto todavía "uploading" no intenta borrarla del backend (el id es local)', async () => {
      catalog.uploadImageFile.and.callFake(() => new Promise<UploadedImage>(() => {}));
      component.onImageFiles('ml', [new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' })] as unknown as FileList);
      expect(component.draft().ml.images[0].uploading).toBeTrue();

      component.removeImage('ml', 0);

      expect(component.draft().ml.images.length).toBe(0);
      expect(catalog.deleteImage).not.toHaveBeenCalled();
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

  describe('regresiones de fotos por variante (el bug reportado con 33 fotos)', () => {
    it('con una categoría de ML que informa límite 0, la foto SÍ se puede seleccionar', () => {
      // ML devuelve max_pictures_per_item_var: 0 en categorías mal configuradas. Antes ese 0
      // llegaba entero y `0 >= 0` bloqueaba TODOS los clicks de ML (los de TN funcionaban).
      seedImage(component, 'ml', 'a');
      component.addAxis();
      const v = component.draft().variants[0];
      component.mlMaxPicturesPerVar.set(0);

      component.toggleVariantMlImage(v, 'a');

      expect(v.ml.pictureIds).toEqual(['a']);
      expect(component.imageError()).toBeNull();
    });

    it('al topear el límite, el aviso se muestra junto a la grilla de variantes, no en la galería', () => {
      seedImage(component, 'ml', 'a');
      seedImage(component, 'ml', 'b');
      component.addAxis();
      const v = component.draft().variants[0];
      component.mlMaxPicturesPerVar.set(1);

      component.toggleVariantMlImage(v, 'a');
      component.toggleVariantMlImage(v, 'b');

      expect(v.ml.pictureIds).toEqual(['a']);
      expect(component.imageError()).toContain('variación');
      expect(component.imageErrorScope()).toBe('variant');
    });

    it('un borrador guardado con el límite en 0 se cura al restaurarlo', fakeAsync(() => {
      localStorage.setItem(
        'zc-crear-producto-drafts',
        JSON.stringify([
          {
            id: 'd1',
            savedAt: Date.now(),
            mlMaxPictures: 0,
            mlMaxPicturesPerVar: 0,
            draft: { ...emptyDraft(), ml: { ...emptyDraft().ml, images: [] }, tn: { ...emptyDraft().tn, images: [] } }
          }
        ])
      );
      const fx = TestBed.createComponent(CrearProductoComponent);
      fx.detectChanges();
      flushMicrotasks();

      expect(fx.componentInstance.mlMaxPicturesPerVar()).toBe(10);
      expect(fx.componentInstance.mlMaxPictures()).toBe(12);
    }));

    it('restaurar un borrador viejo SIN ml.pictureIds no rompe el render', fakeAsync(() => {
      localStorage.setItem(
        'zc-crear-producto-drafts',
        JSON.stringify([
          {
            id: 'd2',
            savedAt: Date.now(),
            mlMaxPictures: 12,
            mlMaxPicturesPerVar: 10,
            draft: {
              ...emptyDraft(),
              axes: [{ name: 'Color' }],
              // Variante de una versión anterior: sin ml, sin barcode, sin titles.
              variants: [{ id: 'v1', sku: 'CUA-N', values: ['Negro'], stock: 1, tn: { imageId: 'img-1' } }],
              ml: { ...emptyDraft().ml, images: [] },
              tn: { ...emptyDraft().tn, images: [] }
            }
          }
        ])
      );
      const fx = TestBed.createComponent(CrearProductoComponent);
      expect(() => {
        fx.detectChanges();
        flushMicrotasks();
      }).not.toThrow();

      const v = fx.componentInstance.draft().variants[0];
      expect(v.ml.pictureIds).toEqual([]);
      expect(v.tn.imageIds).toEqual(['img-1']); // migrado desde el `imageId` viejo
      expect(v.titles.ml).toEqual({ inherited: true, value: '' });
    }));

    it('restaurar un borrador pide la MINIATURA, no el original', fakeAsync(() => {
      localStorage.setItem(
        'zc-crear-producto-drafts',
        JSON.stringify([
          {
            id: 'd3',
            savedAt: Date.now(),
            mlMaxPictures: 12,
            mlMaxPicturesPerVar: 10,
            draft: {
              ...emptyDraft(),
              ml: { ...emptyDraft().ml, images: [{ id: 'img-9', name: 'a.jpg' }] },
              tn: { ...emptyDraft().tn, images: [] }
            }
          }
        ])
      );
      const fx = TestBed.createComponent(CrearProductoComponent);
      fx.detectChanges();
      flushMicrotasks();

      // Servir el original acá era ~5 MB por foto: con 45 fotos, Chrome descartaba la pestaña.
      expect(fx.componentInstance.draft().ml.images[0].previewUrl).toContain('/products/images/img-9/thumb');
    }));

    it('agregar una variante después de restaurar un borrador no colisiona con sus ids ("v1", "v2")', fakeAsync(() => {
      // Bug reportado: con 3+ variantes el modal de "Elegir fotos" de la fila nueva abría los
      // datos de la primera. Causa: `addVariant()` generaba ids con un contador que se reinicia a
      // 1 en cada carga de página (`v${variantSeq++}`), así que agregar una variante después de
      // restaurar un borrador con variantes "v1"/"v2" (mismo esquema de ids) volvía a generar "v1"
      // — dos filas con el mismo id, y `.find(id)` resolvía siempre a la primera.
      localStorage.setItem(
        'zc-crear-producto-drafts',
        JSON.stringify([
          {
            id: 'd4',
            savedAt: Date.now(),
            mlMaxPictures: 12,
            mlMaxPicturesPerVar: 10,
            draft: {
              ...emptyDraft(),
              axes: [{ name: 'Color' }],
              variants: [
                { id: 'v1', sku: 'A', values: ['Rojo'], stock: 1, ml: { price: null, pictureIds: [] }, tn: { price: null, imageIds: [] } },
                { id: 'v2', sku: 'B', values: ['Azul'], stock: 1, ml: { price: null, pictureIds: [] }, tn: { price: null, imageIds: [] } }
              ],
              ml: { ...emptyDraft().ml, images: [] },
              tn: { ...emptyDraft().tn, images: [] }
            }
          }
        ])
      );
      const fx = TestBed.createComponent(CrearProductoComponent);
      fx.detectChanges();
      flushMicrotasks();

      fx.componentInstance.addVariant();

      const ids = fx.componentInstance.draft().variants.map((v) => v.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toContain('v1');
      expect(ids).toContain('v2');
      tick(1600); // drena el autoguardado que dispara addVariant()
    }));

    it('un borrador guardado con ids de variante duplicados (por el bug ya arreglado) se cura al restaurarlo', fakeAsync(() => {
      // Borradores guardados ANTES del fix de `addVariant()` pueden tener el bug ya cristalizado
      // en el JSON: dos variantes con el mismo id. `dedupeVariantIds` los separa al restaurar, sin
      // pedirle a la usuaria que empiece un producto nuevo ni tocar sus fotos/SKUs/precios.
      localStorage.setItem(
        'zc-crear-producto-drafts',
        JSON.stringify([
          {
            id: 'd5',
            savedAt: Date.now(),
            mlMaxPictures: 12,
            mlMaxPicturesPerVar: 10,
            draft: {
              ...emptyDraft(),
              axes: [{ name: 'Color' }],
              variants: [
                { id: 'v1', sku: 'STARDUST', values: ['Stardust'], stock: 5, ml: { price: 1000, pictureIds: ['a', 'b'] }, tn: { price: 1000, imageIds: [] } },
                { id: 'v2', sku: 'ROSIE', values: ['Rosie'], stock: 5, ml: { price: 1000, pictureIds: ['c'] }, tn: { price: 1000, imageIds: [] } },
                { id: 'v1', sku: 'AURORA', values: ['Aurora'], stock: 5, ml: { price: 1000, pictureIds: [] }, tn: { price: 1000, imageIds: [] } }
              ],
              ml: { ...emptyDraft().ml, images: [] },
              tn: { ...emptyDraft().tn, images: [] }
            }
          }
        ])
      );
      const fx = TestBed.createComponent(CrearProductoComponent);
      fx.detectChanges();
      flushMicrotasks();

      const variants = fx.componentInstance.draft().variants;
      const ids = variants.map((v) => v.id);
      expect(new Set(ids).size).toBe(3);
      // La primera ocurrencia conserva su id; solo la repetida cambia.
      expect(variants[0].id).toBe('v1');
      expect(variants[0].sku).toBe('STARDUST');
      expect(variants[2].id).not.toBe('v1');
      expect(variants[2].sku).toBe('AURORA');
    }));

    it('la selección hecha mientras la foto subía sigue viva cuando cambia el id', async () => {
      const upload = deferredUpload(catalog);
      const file = new File([new Uint8Array([1])], 'foto.jpg', { type: 'image/jpeg' });
      component.addAxis();
      const v = component.draft().variants[0];

      const pending = component.onImageFiles('ml', [file] as unknown as FileList);
      const localId = component.draft().ml.images[0].id;
      expect(localId).toContain('local-');

      // La usuaria la asigna a la variante mientras todavía sube.
      component.toggleVariantMlImage(v, localId);
      expect(v.ml.pictureIds).toEqual([localId]);

      await upload.called;
      upload.resolve({ id: 'IMG-REAL', name: 'foto.jpg', mime: 'image/jpeg', size: 1 });
      await pending;

      // Sin el remapeo, la selección quedaba apuntando al id local y desaparecía sola.
      expect(component.draft().variants[0].ml.pictureIds).toEqual(['IMG-REAL']);
    });

    it('el uid de la foto NO cambia aunque cambie el id (evita recrear el <img>)', async () => {
      const upload = deferredUpload(catalog);
      const file = new File([new Uint8Array([1])], 'foto.jpg', { type: 'image/jpeg' });

      const pending = component.onImageFiles('ml', [file] as unknown as FileList);
      const uid = component.draft().ml.images[0].uid;
      expect(uid).toBeTruthy();

      await upload.called;
      upload.resolve({ id: 'IMG-REAL', name: 'foto.jpg', mime: 'image/jpeg', size: 1 });
      await pending;

      expect(component.draft().ml.images[0].uid).toBe(uid);
      expect(component.draft().ml.images[0].id).toBe('IMG-REAL');
    });

    it('la subida del original arranca ANTES de que esté lista la miniatura', async () => {
      // El worker es una cola serial: esperarlo antes de subir dejaba los uploads concurrentes
      // formados detrás de él (33 fotos = varios segundos hasta ver la última preview).
      const upload = deferredUpload(catalog);
      const file = new File([new Uint8Array([1])], 'foto.jpg', { type: 'image/jpeg' });

      const pending = component.onImageFiles('ml', [file] as unknown as FileList);
      await upload.called;

      // Si todavía no hay preview cuando ya arrancó la subida, es que no la esperó.
      expect(catalog.uploadImageFile).toHaveBeenCalled();

      upload.resolve({ id: 'IMG-REAL', name: 'foto.jpg', mime: 'image/jpeg', size: 1 });
      await pending;
    });

    it('startNewDraft() libera los object URLs del borrador anterior', () => {
      const revoke = spyOn(URL, 'revokeObjectURL');
      const d = component.draft();
      d.ml.images.push({ id: 'a', uid: 'a', name: 'a.jpg', previewUrl: 'blob:http://x/1' });
      d.tn.images.push({ id: 'b', uid: 'b', name: 'b.jpg', previewUrl: 'blob:http://x/2' });
      component.touch();

      component.startNewDraft();

      expect(revoke).toHaveBeenCalledWith('blob:http://x/1');
      expect(revoke).toHaveBeenCalledWith('blob:http://x/2');
    });
  });

  describe('OnPush: los sub-componentes se refrescan cuando el store cambia desde afuera', () => {
    /*
     * La regla que hace que todo esto funcione: los hijos leen `store.draft()` en su template y NO
     * reciben datos del borrador por `input()`. `touch()` clona solo la raíz, así que un
     * `[algo]="draft().ml"` se compararía con Object.is, daría igual, y el hijo OnPush nunca se
     * marcaría. Estos tests fallan si alguien cachea `draft()` en un field del componente.
     */
    function valorDe(selector: string): string | undefined {
      return (fixture.nativeElement.querySelector(selector) as HTMLInputElement | null)?.value;
    }

    // ngModel sincroniza modelo→vista en un microtask, así que hay que dejarlo correr antes de
    // mirar el `value` del input; por eso estos dos van con fakeAsync.
    it('datos comunes: un cambio programático del nombre base se ve en el input del hijo', fakeAsync(() => {
      component.draft().common.baseName = 'Cambiado desde afuera';
      component.touch();
      fixture.detectChanges();
      flushMicrotasks();

      expect(valorDe('zc-common-data-section input.zc-input')).toBe('Cambiado desde afuera');
      component.store.cancelAutosave();
    }));

    it('sección TN: generateSeo() escribe el SEO y el input del hijo lo muestra', fakeAsync(() => {
      component.draft().common.baseName = 'Cuaderno A4';
      component.touch();
      void component.generateSeo();
      flushMicrotasks();
      fixture.detectChanges();
      flushMicrotasks();

      const seo = fixture.nativeElement.querySelector('zc-tn-section input[maxlength="70"]') as HTMLInputElement;
      expect(seo?.value).toBe(catalog.seoResponse.seoTitle);
      component.store.cancelAutosave();
    }));

    it('sección de variantes: agregar un eje desde el store renderiza la tabla en el hijo', () => {
      expect(fixture.nativeElement.querySelector('zc-variants-section .variant-table')).toBeNull();
      component.addAxis();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('zc-variants-section .variant-table')).not.toBeNull();
    });

    it('galería de ML: una foto agregada al store aparece en el hijo', () => {
      seedImage(component, 'ml', 'img-abc');
      fixture.detectChanges();
      const img = fixture.nativeElement.querySelector('zc-ml-section zc-image-gallery img') as HTMLImageElement;
      expect(img).not.toBeNull();
      expect(img.getAttribute('alt')).toBe('img-abc.jpg');
    });

    it('atributos de ML: los que carga la categoría se pintan en el hijo', fakeAsync(() => {
      catalog.mlAttributes = [
        { id: 'BRAND', name: 'Marca', valueType: 'string', required: true, allowedValues: [] }
      ];
      void component.loadMlAttributes('MLA388307');
      flushMicrotasks();
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('zc-ml-attributes')?.textContent).toContain('Marca');
    }));

    it('atributos con allowVariations van a mlVariationAttrs (selector de eje), no a la lista general', fakeAsync(() => {
      catalog.mlAttributes = [
        { id: 'BRAND', name: 'Marca', valueType: 'string', required: true, allowedValues: [] },
        { id: 'COLOR', name: 'Color', valueType: 'list', required: false, allowVariations: true, allowedValues: [{ id: '1', name: 'Negro' }] }
      ];
      void component.loadMlAttributes('MLA388307');
      flushMicrotasks();

      const ids = component.draft().ml.attributes.map((a) => a.id);
      expect(ids).toContain('BRAND');
      expect(ids).not.toContain('COLOR');
      expect(component.store.mlVariationAttrs().map((a) => a.id)).toEqual(['COLOR']);
    }));

    it('UNITS_PER_PACK (conditional_required): sube a obligatorios y se precarga en 1 cuando SALE_FORMAT ya tiene valor', fakeAsync(() => {
      catalog.mlAttributes = [
        {
          id: 'SALE_FORMAT',
          name: 'Formato de venta',
          valueType: 'list',
          required: false,
          allowedValues: [
            { id: '1359391', name: 'Unidad' },
            { id: '1359392', name: 'Pack' }
          ]
        },
        { id: 'UNITS_PER_PACK', name: 'Unidades por pack', valueType: 'number', required: false, conditionalRequired: true, allowedValues: [] }
      ];
      // el predictor ya infirió SALE_FORMAT = Unidad
      void component.loadMlAttributes('MLA388307', [
        { id: 'SALE_FORMAT', name: 'Formato de venta', value_id: '1359391', value_name: 'Unidad' }
      ]);
      flushMicrotasks();

      const ups = component.draft().ml.attributes.find((a) => a.id === 'UNITS_PER_PACK')!;
      expect(ups.value).toBe('1');
      expect(component.store.attrIsRequired(ups)).toBeTrue();
      expect(component.mlRequiredAttrs().map((a) => a.id)).toContain('UNITS_PER_PACK');
    }));

    it('UNITS_PER_PACK sigue opcional mientras SALE_FORMAT esté vacío', fakeAsync(() => {
      catalog.mlAttributes = [
        { id: 'SALE_FORMAT', name: 'Formato de venta', valueType: 'list', required: false, allowedValues: [{ id: '1359391', name: 'Unidad' }] },
        { id: 'UNITS_PER_PACK', name: 'Unidades por pack', valueType: 'number', required: false, conditionalRequired: true, allowedValues: [] }
      ];
      void component.loadMlAttributes('MLA388307');
      flushMicrotasks();

      const ups = component.draft().ml.attributes.find((a) => a.id === 'UNITS_PER_PACK')!;
      expect(ups.value).toBe('');
      expect(component.store.attrIsRequired(ups)).toBeFalse();
      expect(component.mlOptionalAttrs().map((a) => a.id)).toContain('UNITS_PER_PACK');

      // al elegir SALE_FORMAT, UNITS_PER_PACK pasa a obligatorio y se precarga
      const sf = component.draft().ml.attributes.find((a) => a.id === 'SALE_FORMAT')!;
      component.store.setMlAttributeValue(sf, '1359391');
      expect(ups.value).toBe('1');
      expect(component.mlRequiredAttrs().map((a) => a.id)).toContain('UNITS_PER_PACK');
      tick(1600); // autosave que disparó setMlAttributeValue -> touch()
    }));

    it('selector de eje: elegir un atributo real de ML guarda mlAttributeId y sus allowedValues en el eje', fakeAsync(() => {
      catalog.mlAttributes = [
        { id: 'COLOR', name: 'Color', valueType: 'list', required: false, allowVariations: true, allowedValues: [{ id: '1', name: 'Negro' }] }
      ];
      void component.loadMlAttributes('MLA388307');
      flushMicrotasks();
      component.addAxis();
      component.draft().axes[0].name = 'Color';
      fixture.detectChanges();

      const select = fixture.nativeElement.querySelector('zc-variants-section .axis-ml-attr') as HTMLSelectElement;
      expect(select).not.toBeNull();
      select.value = 'COLOR';
      select.dispatchEvent(new Event('change'));
      fixture.detectChanges();

      expect(component.draft().axes[0].mlAttributeId).toBe('COLOR');
      expect(component.draft().axes[0].allowedValues).toEqual([{ id: '1', name: 'Negro' }]);
      tick(1600); // drena el timer de autosave que dispararon addAxis()/touch() (fakeAsync exige la cola vacía)
    }));
  });

  describe('autoguardado', () => {
    it('guarda solo después de que se deja de escribir, y actualiza la MISMA entrada', fakeAsync(() => {
      component.draft().common.baseName = 'Cuaderno A4';
      component.touch();
      expect(component.currentDraftId()).toBeNull(); // todavía no

      tick(1500);
      const id = component.currentDraftId();
      expect(id).toBeTruthy();
      expect(component.savedDrafts().length).toBe(1);

      // Un segundo cambio actualiza la entrada existente, no crea otra.
      component.draft().common.baseName = 'Cuaderno A4 Tapa Dura';
      component.touch();
      tick(1500);
      expect(component.currentDraftId()).toBe(id);
      expect(component.savedDrafts().length).toBe(1);
    }));

    it('escribir de nuevo antes del debounce reagenda: guarda una sola vez', fakeAsync(() => {
      component.draft().common.baseName = 'A';
      component.touch();
      tick(500);
      component.draft().common.baseName = 'AB';
      component.touch();
      tick(500);
      expect(component.currentDraftId()).toBeNull(); // el timer se reinició

      tick(1500);
      expect(component.savedDrafts().length).toBe(1);
      expect(component.savedDrafts()[0].label).toBe('AB');
    }));

    it('un borrador vacío NO se autoguarda (entrar a la página no ensucia "Mis borradores")', fakeAsync(() => {
      component.touch();
      tick(5000);
      expect(component.savedDrafts().length).toBe(0);
      expect(component.currentDraftId()).toBeNull();
    }));

    it('con fotos a medio subir no guarda (persistiría ids locales) y reagenda', fakeAsync(() => {
      component.draft().common.baseName = 'Con fotos';
      component.draft().ml.images.push({ id: 'local-1', uid: 'local-1', name: 'a.jpg', previewUrl: '', uploading: true });
      component.touch();

      tick(1500);
      expect(component.savedDrafts().length).toBe(0);

      // Cuando termina la subida, el siguiente ciclo del debounce sí guarda. El `touch()` es lo
      // que hace el código real al resolver la subida (y lo que invalida `hasPendingUploads`).
      component.draft().ml.images[0].uploading = false;
      component.draft().ml.images[0].id = 'IMG-REAL';
      component.touch();
      tick(1500);
      expect(component.savedDrafts().length).toBe(1);
    }));

    it('startNewDraft() cancela el autoguardado pendiente (no pisa la entrada nueva)', fakeAsync(() => {
      component.draft().common.baseName = 'Viejo';
      component.touch();
      tick(500);

      component.startNewDraft();
      tick(5000);

      expect(component.savedDrafts().length).toBe(0);
    }));
  });

  describe('publish()', () => {
    it('marca publishing en true y limpia publishResults al iniciar', () => {
      component.publish();
      expect(component.publishing()).toBeTrue();
      expect(component.publishResults()).toBeNull();
    });

    it('guarda el borrador, encola el job y muestra los resultados por canal (polleando hasta que termina), apagando el flag de publicando', fakeAsync(() => {
      component.publish();
      flushMicrotasks();

      expect(catalog.createDraft).toHaveBeenCalled(); // primera publicación: crea el borrador en el backend
      expect(catalog.publishDraft).toHaveBeenCalled();
      expect(catalog.getPublishJob).toHaveBeenCalled();
      expect(component.publishing()).toBeFalse();
      const results = component.publishResults();
      expect(results).not.toBeNull();
      expect(results!.length).toBe(2);
      expect(results!.find((r) => r.channel === 'ml')?.status).toBe('ok');
      expect(results!.find((r) => r.channel === 'tn')?.status).toBe('ok');
    }));

    it('propaga el error como fallo en ambos canales si el backend rechaza al encolar', fakeAsync(() => {
      catalog.publishDraft.and.returnValue(Promise.reject({ error: { error: 'boom' } }));
      component.publish();
      flushMicrotasks();

      const results = component.publishResults()!;
      expect(results.every((r) => r.status === 'error')).toBeTrue();
      expect(results[0].detail).toBe('boom');
    }));

    it('mientras el job sigue "processing", pollea de nuevo (con el intervalo configurado) hasta terminar', fakeAsync(() => {
      let call = 0;
      catalog.getPublishJob.and.callFake((jobId: string) => {
        call++;
        if (call === 1) {
          return Promise.resolve({ job: { id: jobId, draftId: 'd', channels: 'ml,tn', status: 'processing', attempts: 1, lastError: null, createdAt: '', updatedAt: '', finishedAt: null }, units: [{ channel: 'ml', unitKey: '', seq: 0, status: 'ok', externalId: null, detail: 'Publicación MLA-1 creada', updatedAt: '' }] });
        }
        return Promise.resolve({ job: { id: jobId, draftId: 'd', channels: 'ml,tn', status: 'done', attempts: 1, lastError: null, createdAt: '', updatedAt: '', finishedAt: '' }, units: [
          { channel: 'ml', unitKey: '', seq: 0, status: 'ok', externalId: null, detail: 'Publicación MLA-1 creada', updatedAt: '' },
          { channel: 'tn', unitKey: '', seq: 0, status: 'ok', externalId: null, detail: 'Producto #1 creado', updatedAt: '' }
        ] });
      });

      component.publish();
      flushMicrotasks();
      expect(component.publishing()).toBeTrue(); // todavía "processing": sigue publicando
      expect(component.publishProgress().length).toBe(1); // progreso parcial ya visible (solo ML por ahora)

      tick(1500); // el siguiente poll
      flushMicrotasks();

      expect(component.publishing()).toBeFalse();
      expect(call).toBe(2);
      const results = component.publishResults()!;
      expect(results.every((r) => r.status === 'ok')).toBeTrue();
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

    it('sin variantes, arma un único registro de variante TN a partir de los datos comunes (+ age_group/gender por default)', () => {
      const payload = component.buildPayloads();
      const tn = payload.tn as any;
      expect(tn.variants.length).toBe(1);
      expect(tn.variants[0]).toEqual({
        sku: component.draft().common.sku,
        barcode: component.draft().common.barcode,
        weight: component.draft().common.weightG! / 1000,
        width: component.draft().common.widthCm,
        height: component.draft().common.heightCm,
        depth: component.draft().common.lengthCm,
        age_group: 'adult',
        gender: 'unisex'
      });
    });

    it('sin ejes, TN no manda "attributes" (no hay eje que nombrar)', () => {
      const tn = component.buildPayloads().tn as any;
      expect(tn.attributes).toBeUndefined();
    });

    it('con variantes, arma un registro TN por variante con valores LIMPIOS (sin el nombre del eje adentro) y manda "attributes" con los nombres de eje', () => {
      component.addAxis();
      component.draft().axes[0].name = 'Color';
      component.draft().variants[0].sku = 'CUA-A4-TD-NEGRO';
      component.draft().variants[0].values = ['Negro'];
      component.draft().variants[0].stock = 5;
      component.draft().variants[0].tn = { price: 1000, imageIds: [] };

      const payload = component.buildPayloads();
      const tn = payload.tn as any;

      expect(tn.attributes).toEqual([{ es: 'Color' }]);
      expect(tn.variants.length).toBe(1);
      expect(tn.variants[0].sku).toBe('CUA-A4-TD-NEGRO');
      // Antes viajaba [{ es: 'Color: Negro' }] — el nombre del eje ya no se mete en el valor.
      expect(tn.variants[0].values).toEqual([{ es: 'Negro' }]);
      expect(tn.variants[0].price).toBe(1000);
      expect(tn.variants[0].stock).toBe(5);
    });

    it('manda mpn/age_group/gender de "Datos generales" en cada variante TN (Instagram/Google Shopping)', () => {
      component.addAxis();
      component.draft().axes[0].name = 'Color';
      component.draft().variants[0].values = ['Negro'];
      component.draft().common.mpn = 'MPN-123';
      component.draft().common.ageGroup = 'kids';
      component.draft().common.gender = 'female';

      const tn = component.buildPayloads().tn as any;
      expect(tn.variants[0].mpn).toBe('MPN-123');
      expect(tn.variants[0].age_group).toBe('kids');
      expect(tn.variants[0].gender).toBe('female');
    });

    it('mpn vacío no manda el campo (undefined, no string vacío)', () => {
      component.draft().common.mpn = '';
      const tn = component.buildPayloads().tn as any;
      expect(tn.variants[0].mpn).toBeUndefined();
    });

    it('convierte el peso de gramos a kilogramos para TN, o lo deja en null si no hay peso', () => {
      component.draft().common.weightG = null;
      const payload = component.buildPayloads();
      const tn = payload.tn as any;
      expect(tn.variants[0].weight).toBeNull();
    });
  });

  describe('títulos por variante y por canal (one_per_variant) + código de barras', () => {
    let v1: ProductVariant;
    let v2: ProductVariant;

    beforeEach(() => {
      const d = component.draft();
      d.common = { ...d.common, baseName: 'Cuaderno A4', sku: '', barcode: '7790000000000' };
      d.ml.title = inherited('');
      d.tn.nameEs = inherited('');
      component.addAxis();
      component.draft().axes[0].name = 'Color';
      v1 = component.draft().variants[0];
      v1.sku = 'CUA-N';
      v1.values = ['Negro'];
      component.addVariant();
      v2 = component.draft().variants[1];
      v2.sku = 'CUA-R';
      v2.values = ['Rojo'];
      component.touch();
    });

    it('variantDefaultTitle() combina el título/nombre base efectivo con los valores de la variante', () => {
      expect(component.variantDefaultTitle('ml', v1)).toBe('Cuaderno A4 - Negro');
      expect(component.variantDefaultTitle('tn', v1)).toBe('Cuaderno A4 - Negro');
    });

    it('buildPayloads() manda el título automático por variante mientras titles quede heredado', () => {
      const payload = component.buildPayloads();
      const variants = payload.variants as any[];
      expect(variants[0].ml.title).toBe('Cuaderno A4 - Negro');
      expect(variants[0].name).toBe('Cuaderno A4 - Negro');
      expect(variants[1].ml.title).toBe('Cuaderno A4 - Rojo');
      expect(variants[1].name).toBe('Cuaderno A4 - Rojo');
    });

    it('buildPayloads() manda el título propio de ML sin afectar el de TN de la misma variante (uno por canal)', () => {
      component.makeOwn(v1.titles.ml, component.variantDefaultTitle('ml', v1));
      v1.titles.ml.value = 'Cuaderno A4 Negro Edición Especial';
      component.touch();

      const payload = component.buildPayloads();
      const variants = payload.variants as any[];
      expect(variants[0].ml.title).toBe('Cuaderno A4 Negro Edición Especial');
      // TN de la MISMA variante sigue en automático: el override es por canal, no global.
      expect(variants[0].name).toBe('Cuaderno A4 - Negro');
    });

    it('revert() vuelve el título de la variante al automático', () => {
      component.makeOwn(v1.titles.ml, 'algo propio');
      component.revert(v1.titles.ml);
      component.touch();
      const payload = component.buildPayloads();
      expect((payload.variants as any[])[0].ml.title).toBe('Cuaderno A4 - Negro');
    });

    it('buildPayloads() manda el código de barras propio de la variante si se cargó uno', () => {
      v1.barcode = '7791111111111';
      component.touch();
      const payload = component.buildPayloads();
      const variants = payload.variants as any[];
      expect(variants[0].barcode).toBe('7791111111111');
      // v2 no tiene propio: cae al común.
      expect(variants[1].barcode).toBe('7790000000000');
    });

    it('variantChipLabel() antepone los valores de eje; sin valores cae al SKU', () => {
      expect(component.variantChipLabel(v1)).toBe('Negro');
      v2.values = [''];
      expect(component.variantChipLabel(v2)).toBe('CUA-R');
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

      expect(catalog.publishDraft).toHaveBeenCalled();
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

    it('un solo resultado (publicar un único canal) no rompe el render — antes indexaba results()[1]', () => {
      component.publishResults.set([{ channel: 'ml', status: 'ok', detail: 'Publicación MLA-1 creada' }]);
      expect(() => fixture.detectChanges()).not.toThrow();
      expect(component.publishPhase()).toBe('done');
      const icon = fixture.nativeElement.querySelector('.publish-progress .block-head > i.ti') as HTMLElement;
      expect(icon.classList.contains('ti-circle-check')).toBeTrue();
      expect(icon.classList.contains('ti-alert-triangle')).toBeFalse();
    });

    it('un solo resultado con error muestra el panel en fase "partial" con su ícono de alerta', () => {
      component.publishResults.set([{ channel: 'tn', status: 'error', detail: 'stock inválido' }]);
      fixture.detectChanges();
      expect(component.publishPhase()).toBe('partial');
      const icon = fixture.nativeElement.querySelector('.publish-progress .block-head > i.ti') as HTMLElement;
      expect(icon.classList.contains('ti-alert-triangle')).toBeTrue();
      expect(icon.classList.contains('ti-circle-check')).toBeFalse();
      // y ofrece reintentar el canal que falló
      const retryBtn = fixture.nativeElement.querySelector('.progress-actions .zc-btn') as HTMLElement;
      expect(retryBtn.textContent).toContain('Tienda Nube');
    });
  });

  describe('reabrir un borrador con una publicación previa (persistencia)', () => {
    const jobRow = (over: Partial<PublishJobSummary> = {}): PublishJobSummary => ({
      id: 'job-x',
      draftId: 'd1',
      channels: 'ml,tn',
      status: 'error',
      attempts: 1,
      lastError: 'tn: stock inválido',
      createdAt: '',
      updatedAt: '',
      finishedAt: null,
      ...over
    });
    const draftWithJobs = (jobs: PublishJobSummary[]) => () =>
      Promise.resolve({
        id: 'd1',
        name: null,
        sku: null,
        status: 'error' as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        draft: component.draft(),
        jobs
      });

    it('un job ya terminado se reconstruye: repuebla progreso + resultado SIN volver a publicar', fakeAsync(() => {
      catalog.getDraft.and.callFake(draftWithJobs([jobRow()]));
      catalog.getPublishJob.and.callFake((id: string) =>
        Promise.resolve({
          job: jobRow({ id, status: 'error' }),
          units: [
            { channel: 'ml', unitKey: '', seq: 0, status: 'ok', externalId: 'MLA1', detail: 'Publicación MLA1 creada', updatedAt: '' },
            { channel: 'tn', unitKey: '', seq: 1, status: 'error', externalId: null, detail: 'stock inválido', updatedAt: '' }
          ]
        })
      );

      component.store.openDraft('d1');
      flushMicrotasks();
      fixture.detectChanges(); // corre el effect que reconstruye el panel
      flushMicrotasks();

      expect(catalog.publishDraft).not.toHaveBeenCalled();
      expect(component.publishing()).toBeFalse();
      expect(component.publishProgress().length).toBe(2);
      expect(component.publishPhase()).toBe('partial');
      expect(component.publishTotals()).toEqual(jasmine.objectContaining({ total: 2, ok: 1, err: 1 }));
      expect(component.publishResults()!.find((r) => r.channel === 'tn')!.status).toBe('error');
    }));

    it('un job en curso (processing) retoma el polling hasta que el servidor lo termina', fakeAsync(() => {
      catalog.getDraft.and.callFake(draftWithJobs([jobRow({ status: 'processing', channels: 'ml' })]));
      let calls = 0;
      catalog.getPublishJob.and.callFake((id: string) => {
        const done = ++calls > 1;
        return Promise.resolve({
          job: jobRow({ id, status: done ? 'done' : 'processing', channels: 'ml' }),
          units: [
            {
              channel: 'ml',
              unitKey: '',
              seq: 0,
              status: done ? 'ok' : 'pending',
              externalId: null,
              detail: done ? 'Publicación MLA1 creada' : null,
              updatedAt: ''
            }
          ]
        });
      });

      component.store.openDraft('d1');
      flushMicrotasks();
      fixture.detectChanges();
      flushMicrotasks();
      expect(component.publishing()).toBeTrue();
      expect(component.publishPhase()).toBe('running');

      flush(); // agota el setTimeout del polling; la 2ª vuelta ve 'done'
      expect(component.publishing()).toBeFalse();
      expect(component.publishPhase()).toBe('done');
      expect(component.publishProgress()[0].status).toBe('ok');
    }));

    it('sin jobs previos no muestra nada de publicación', fakeAsync(() => {
      catalog.getDraft.and.callFake(draftWithJobs([]));
      component.store.openDraft('d1');
      flushMicrotasks();
      fixture.detectChanges();
      flushMicrotasks();
      expect(component.publishPhase()).toBe('idle');
      expect(catalog.getPublishJob).not.toHaveBeenCalled();
    }));
  });

  describe('publishErrorSummary()', () => {
    it('traduce el error de UNITS_PER_PACK de ML a una frase clara', () => {
      expect(component.publishErrorSummary('Attribute [UNITS_PER_PACK] to be added with values [(null,1)]')).toContain(
        'Unidades por pack'
      );
    });
    it('devuelve null si no reconoce el error (se muestra el texto crudo)', () => {
      expect(component.publishErrorSummary('algo raro que nunca vimos')).toBeNull();
      expect(component.publishErrorSummary('')).toBeNull();
    });
  });

  describe('borradores en el backend (guardar / restaurar / listar / eliminar)', () => {
    it('saveDraft() crea el borrador en el backend y setea draftSavedAt + currentDraftId', fakeAsync(() => {
      component.draft().common.baseName = 'Cuaderno Test';
      expect(component.draftSavedAt()).toBeNull();
      expect(component.currentDraftId()).toBeNull();

      component.saveDraft();
      flushMicrotasks();

      expect(component.draftSavedAt()).not.toBeNull();
      expect(component.currentDraftId()).not.toBeNull();
      expect(catalog.createDraft).toHaveBeenCalled();
      expect(catalog.draftsDb.size).toBe(1);
      expect([...catalog.draftsDb.values()][0].draft.common.baseName).toBe('Cuaderno Test');
    }));

    it('saveDraft() no persiste el previewUrl de las imágenes (solo id/name)', fakeAsync(() => {
      seedImage(component, 'ml', 'img-1');
      component.saveDraft();
      flushMicrotasks();
      const [entry] = catalog.draftsDb.values();
      expect(entry.draft.ml.images).toEqual([{ id: 'img-1', name: 'img-1.jpg' }]);
    }));

    it('guardar dos veces seguidas mientras se edita el MISMO borrador actualiza la entrada (no duplica: PUT, no POST)', fakeAsync(() => {
      component.draft().common.baseName = 'Versión 1';
      component.saveDraft();
      flushMicrotasks();
      const idAfterFirst = component.currentDraftId();

      component.draft().common.baseName = 'Versión 2';
      component.saveDraft();
      flushMicrotasks();

      expect(component.currentDraftId()).toBe(idAfterFirst);
      expect(catalog.createDraft).toHaveBeenCalledTimes(1);
      expect(catalog.updateDraft).toHaveBeenCalledTimes(1);
      expect(catalog.draftsDb.size).toBe(1);
      expect([...catalog.draftsDb.values()][0].draft.common.baseName).toBe('Versión 2');
    }));

    it('startNewDraft() + saveDraft() crea una SEGUNDA entrada distinta (varios borradores a la vez)', fakeAsync(() => {
      component.draft().common.baseName = 'Producto A';
      component.saveDraft();
      flushMicrotasks();

      component.startNewDraft();
      component.draft().common.baseName = 'Producto B';
      component.saveDraft();
      flushMicrotasks();

      expect(catalog.draftsDb.size).toBe(2);
      const names = [...catalog.draftsDb.values()].map((e) => e.draft.common.baseName).sort();
      expect(names).toEqual(['Producto A', 'Producto B']);
    }));

    it('el borrador guardado más reciente se restaura al crear el componente de nuevo (ngOnInit)', fakeAsync(() => {
      component.draft().common.baseName = 'Restaurado';
      seedImage(component, 'tn', 'img-9');
      component.saveDraft();
      flushMicrotasks();

      // Nueva instancia del componente: simula reabrir la página.
      const fixture2 = TestBed.createComponent(CrearProductoComponent);
      const component2 = fixture2.componentInstance;
      fixture2.detectChanges();
      flushMicrotasks();

      expect(component2.draft().common.baseName).toBe('Restaurado');
      expect(component2.draftRestored()).toBeTrue();
      expect(component2.draft().tn.images[0].id).toBe('img-9');
      // El previewUrl se reconstruye apuntando al endpoint del backend, no queda vacío/roto.
      expect(component2.draft().tn.images[0].previewUrl).toContain('/products/images/img-9');
    }));

    it('sin borradores guardados, draftRestored() queda en false y savedDrafts() vacío', () => {
      expect(component.draftRestored()).toBeFalse();
      expect(component.savedDrafts()).toEqual([]);
    });

    it('un borrador corrupto en localStorage (versión localStorage vieja) no rompe la migración ni la página', fakeAsync(() => {
      localStorage.setItem('zc-crear-producto-drafts', '{not-json');
      const fixture2 = TestBed.createComponent(CrearProductoComponent);
      expect(() => {
        fixture2.detectChanges();
        flushMicrotasks();
      }).not.toThrow();
      expect(fixture2.componentInstance.draftRestored()).toBeFalse();
    }));

    it('migra automáticamente el borrador de la versión anterior (clave singular localStorage) al backend, una sola vez', fakeAsync(() => {
      localStorage.setItem(
        'zc-crear-producto-draft',
        JSON.stringify({ savedAt: Date.now(), mlMaxPictures: 12, mlMaxPicturesPerVar: 10, draft: { ...emptyDraft(), common: { ...emptyDraft().common, baseName: 'Viejo' } } })
      );
      const fixture2 = TestBed.createComponent(CrearProductoComponent);
      fixture2.detectChanges();
      flushMicrotasks();

      expect(fixture2.componentInstance.draft().common.baseName).toBe('Viejo');
      // Las claves viejas se borran tras migrar; el borrador quedó en el backend, no en localStorage.
      expect(localStorage.getItem('zc-crear-producto-draft')).toBeNull();
      expect(localStorage.getItem('zc-crear-producto-drafts')).toBeNull();
      expect(catalog.draftsDb.size).toBe(1);
      expect(localStorage.getItem('zc-crear-producto-drafts-migrated-to-backend')).toBe('1');
    }));

    it('la migración es de una sola vez: si ya corrió, un segundo ngOnInit no vuelve a migrar', fakeAsync(() => {
      localStorage.setItem('zc-crear-producto-drafts-migrated-to-backend', '1');
      localStorage.setItem(
        'zc-crear-producto-drafts',
        JSON.stringify([{ id: 'x', savedAt: Date.now(), mlMaxPictures: 12, mlMaxPicturesPerVar: 10, draft: emptyDraft() }])
      );
      const fixture2 = TestBed.createComponent(CrearProductoComponent);
      fixture2.detectChanges();
      flushMicrotasks();

      expect(catalog.createDraft).not.toHaveBeenCalled();
    }));

    it('savedDrafts() lista todos los borradores guardados, más reciente primero', fakeAsync(() => {
      component.draft().common.baseName = 'Primero';
      component.saveDraft();
      flushMicrotasks();
      component.startNewDraft();
      component.draft().common.baseName = 'Segundo';
      component.saveDraft();
      flushMicrotasks();

      const list = component.savedDrafts();
      expect(list.length).toBe(2);
      expect(list[0].label).toBe('Segundo');
      expect(list[1].label).toBe('Primero');
    }));

    it('openDraft() carga el borrador elegido y actualiza currentDraftId', fakeAsync(() => {
      component.draft().common.baseName = 'A';
      component.saveDraft();
      flushMicrotasks();
      const idA = component.currentDraftId()!;
      component.startNewDraft();
      component.draft().common.baseName = 'B';
      component.saveDraft();
      flushMicrotasks();

      component.openDraft(idA);
      flushMicrotasks();

      expect(component.draft().common.baseName).toBe('A');
      expect(component.currentDraftId()).toBe(idA);
      expect(component.draftsPanelOpen()).toBeFalse();
    }));

    it('deleteDraft() elimina la entrada de la lista sin tocar los demás borradores', fakeAsync(() => {
      component.draft().common.baseName = 'A';
      component.saveDraft();
      flushMicrotasks();
      const idA = component.currentDraftId()!;
      component.startNewDraft();
      component.draft().common.baseName = 'B';
      component.saveDraft();
      flushMicrotasks();

      component.deleteDraft(idA);
      flushMicrotasks();

      expect(catalog.deleteDraft).toHaveBeenCalledWith(idA);
      const list = component.savedDrafts();
      expect(list.length).toBe(1);
      expect(list[0].label).toBe('B');
    }));

    it('deleteDraft() del borrador que se está editando también limpia el formulario', fakeAsync(() => {
      component.draft().common.baseName = 'A';
      component.saveDraft();
      flushMicrotasks();
      const idA = component.currentDraftId()!;

      component.deleteDraft(idA);
      flushMicrotasks();

      expect(component.draft().common.baseName).toBe('');
      expect(component.currentDraftId()).toBeNull();
    }));

    it('startNewDraft() limpia el formulario pero NO borra el borrador ya guardado', fakeAsync(() => {
      component.draft().common.baseName = 'Algo';
      component.saveDraft();
      flushMicrotasks();
      component.mlMaxPictures.set(5); // simula una categoría con límite propio ya cargada

      component.startNewDraft();

      expect(component.draft().common.baseName).toBe('');
      expect(component.mlMaxPictures()).toBe(12);
      expect(component.draftSavedAt()).toBeNull();
      expect(component.draftRestored()).toBeFalse();
      expect(component.currentDraftId()).toBeNull();
      // El borrador previamente guardado sigue en el backend.
      expect(catalog.draftsDb.size).toBe(1);
    }));

    it('al publicar con éxito en AMBOS canales, el borrador NO se borra — queda en el historial', fakeAsync(() => {
      component.saveDraft();
      flushMicrotasks();
      expect(catalog.draftsDb.size).toBe(1);
      const id = component.currentDraftId();

      component.publish();
      flushMicrotasks();

      // A diferencia del flujo síncrono viejo, publicar con éxito YA NO borra el borrador: el
      // estado ("publicado") lo recalcula el backend cuando el job termina, y el historial de
      // publicación se conserva para poder verlo o reintentar un canal más tarde.
      expect(catalog.deleteDraft).not.toHaveBeenCalled();
      expect(catalog.draftsDb.size).toBe(1);
      expect(component.currentDraftId()).toBe(id);
    }));

    it('si un canal falla al publicar, el borrador guardado se conserva igual', fakeAsync(() => {
      catalog.publishResponse = {
        results: [
          { channel: 'ml', status: 'ok', detail: 'Publicación MLA-1 creada' },
          { channel: 'tn', status: 'error', detail: 'stock inválido' }
        ]
      };
      component.saveDraft();
      flushMicrotasks();

      component.publish();
      flushMicrotasks();

      expect(catalog.draftsDb.size).toBe(1);
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
