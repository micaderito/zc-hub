import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, effect, inject, signal } from '@angular/core';
import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { ApiService } from '../../core/services/api.service';
import {
  CatalogService,
  MlCategoryNode,
  MlCategoryPrediction,
  MlCategoryRef,
  PublishJobSummary,
  PublishUnit,
  TnCategory
} from '../../core/services/catalog.service';
import {
  Channel,
  MlAttribute,
  OverrideField,
  ProductDraft,
  ProductVariant,
  PublishResult,
  listingTypeLabel,
  positiveLimit
} from './product-draft.model';
import {
  ML_MAX_PICTURES_FALLBACK,
  ML_MAX_PICTURES_PER_VAR_FALLBACK,
  ProductDraftStore
} from './product-draft.store';
import { CommonDataSectionComponent } from './components/common-data-section/common-data-section.component';
import { DraftsPanelComponent } from './components/drafts-panel/drafts-panel.component';
import { MlCategoryDialogComponent } from './components/ml-category-dialog/ml-category-dialog.component';
import { MlSectionComponent } from './components/ml-section/ml-section.component';
import { PriceProfitSectionComponent } from './components/price-profit-section/price-profit-section.component';
import { TnSectionComponent } from './components/tn-section/tn-section.component';
import { VariantsSectionComponent } from './components/variants-section/variants-section.component';

/**
 * Página de creación de producto.
 *
 * El ESTADO del borrador vive en `ProductDraftStore` (provisto acá abajo, una instancia por
 * pantalla) y no en el componente: los sub-componentes lo inyectan y leen sus señales directo en
 * sus templates, que es lo que los hace compatibles con `OnPush` — ver el comentario largo del
 * store. Acá quedan las llamadas a las APIs (categorías de ML/TN, SEO), la publicación y el armado
 * del payload.
 */
@Component({
  selector: 'app-crear-producto',
  standalone: true,
  imports: [
    DatePipe,
    NgTemplateOutlet,
    CommonDataSectionComponent,
    DraftsPanelComponent,
    MlCategoryDialogComponent,
    MlSectionComponent,
    PriceProfitSectionComponent,
    TnSectionComponent,
    VariantsSectionComponent
  ],
  templateUrl: './crear-producto.component.html',
  styleUrl: './crear-producto.component.scss',
  providers: [ProductDraftStore],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class CrearProductoComponent implements OnInit, OnDestroy {
  private readonly catalog = inject(CatalogService);
  private readonly api = inject(ApiService);
  /** Público: los sub-componentes y el template leen el estado del borrador de acá. */
  readonly store = inject(ProductDraftStore);

  /* ---------- alias del store ----------
   * El template y los tests siguen hablándole al componente; el estado vive en el store.
   * `draft` es la MISMA WritableSignal, así que un `.set()` de un test sigue funcionando. */
  readonly draft = this.store.draft;
  readonly currentDraftId = this.store.currentDraftId;
  readonly draftSavedAt = this.store.draftSavedAt;
  readonly draftRestored = this.store.draftRestored;
  readonly savedDrafts = this.store.savedDrafts;
  readonly draftsPanelOpen = this.store.draftsPanelOpen;
  readonly hasVariants = this.store.hasVariants;
  readonly mlProjection = this.store.mlProjection;
  readonly tnProjection = this.store.tnProjection;
  readonly tnMultiPerVariant = this.store.tnMultiPerVariant;
  readonly mlMaxPictures = this.store.mlMaxPictures;
  readonly mlMaxPicturesPerVar = this.store.mlMaxPicturesPerVar;
  readonly TN_MAX_PICTURES = this.store.TN_MAX_PICTURES;
  readonly imageError = this.store.imageError;
  readonly imageErrorScope = this.store.imageErrorScope;
  readonly hasPendingUploads = this.store.hasPendingUploads;
  readonly mlRequiredAttrs = this.store.mlRequiredAttrs;
  readonly mlOptionalAttrs = this.store.mlOptionalAttrs;
  readonly mlOptionalOpen = this.store.mlOptionalOpen;
  readonly pricingSettings = this.store.pricingSettings;
  readonly hasCost = this.store.hasCost;
  readonly costPreview = this.store.costPreview;
  readonly mlFreeShippingZone = this.store.mlFreeShippingZone;
  readonly variantRows = this.store.variantRows;
  readonly variantBreakdowns = this.store.variantBreakdowns;
  readonly publishBlockers = this.store.publishBlockers;
  readonly canPublish = this.store.canPublish;

  protected readonly listingTypeLabel = listingTypeLabel;

  /** Resultado de "Publicar en ambos" (null = todavía no se publicó). */
  readonly publishResults = signal<PublishResult[] | null>(null);
  readonly publishing = signal(false);
  /** Menú desplegable de "Publicar en ambos ▾" para elegir publicar solo ML o solo TN. */
  readonly publishMenuOpen = signal(false);
  /**
   * Progreso granular del job en curso (una fila por ítem ML / producto TN ya confirmado o
   * fallido) — se actualiza en cada vuelta del polling, así la usuaria ve "2 de 3 en ML" sin
   * tener que esperar a que termine todo el job.
   */
  readonly publishProgress = signal<PublishUnit[]>([]);
  /** Cuánto esperar entre cada `GET /jobs/:id` mientras el job sigue en curso. */
  private static readonly JOB_POLL_MS = 1500;
  /** Id del último job que ya reconstruimos/retomamos al abrir el borrador — evita repetirlo. */
  private resumedJobId: string | null = null;
  /** Job que está polleando ahora mismo — para poder cancelarlo. */
  readonly activeJobId = signal<string | null>(null);
  /** true cuando la usuaria canceló el job en curso (fase `cancelled` del panel). */
  readonly publishCancelled = signal(false);

  /**
   * Conteo del progreso: total de unidades planificadas y cuántas ya terminaron (ok o error).
   * El backend siembra TODAS como 'pending' al arrancar (ver seedPublishUnits), así que
   * `total` es real desde la primera vuelta del polling y se puede mostrar "3 de 8" + barra.
   */
  readonly publishTotals = computed(() => {
    const units = this.publishProgress();
    const ok = units.filter((u) => u.status === 'ok').length;
    const err = units.filter((u) => u.status === 'error').length;
    return { total: units.length, done: ok + err, ok, err, pending: units.length - ok - err };
  });

  /**
   * Fase visible del bloque de publicación:
   *  - `running`: el job sigue en curso (spinner + "X de Y")
   *  - `partial`: terminó con al menos una unidad en error (ícono alerta, botón Reintentar)
   *  - `done`: terminó y todas las unidades quedaron ok (ícono check)
   *  - `idle`: no hay nada que mostrar
   */
  readonly publishPhase = computed<'running' | 'partial' | 'done' | 'cancelled' | 'idle'>(() => {
    if (this.publishCancelled()) return 'cancelled';
    if (this.publishing()) return 'running';
    const results = this.publishResults();
    if (results?.length) return results.every((r) => r.status === 'ok') ? 'done' : 'partial';
    if (this.publishProgress().length) return this.publishTotals().err ? 'partial' : 'done';
    return 'idle';
  });

  constructor() {
    // Al abrir/restaurar un borrador con un intento de publicación previo, reconstruimos el panel
    // (qué pasó, con detalle por unidad) o retomamos el polling si el job sigue corriendo en el
    // servidor. Un `effect` cubre las dos vías de apertura por igual: el restore automático de
    // ngOnInit y "Mis borradores" (que llama a store.openDraft sin pasar por el componente).
    // `allowSignalWrites`: el resume arranca sincrónicamente poniendo `publishing` en true antes
    // del primer await (para mostrar el spinner ya), y eso es una escritura de señal dentro del
    // effect. Es justamente el caso para el que existe la opción: disparar un trabajo async que
    // actualiza señales.
    effect(
      () => {
        const job = this.store.lastPublishJob();
        if (job && !this.publishing() && this.resumedJobId !== job.id) {
          void this.resumeLastPublishJob(job);
        }
      },
      { allowSignalWrites: true }
    );
  }

  /* ================= Categorías: estado ================= */

  // --- Tienda Nube: categorías existentes de la tienda ---
  readonly tnCategories = signal<TnCategory[]>([]);
  readonly tnCategoriesLoading = signal(false);
  readonly tnCategoriesError = signal<string | null>(null);
  private readonly tnCategoryPathById = computed(() => new Map(this.tnCategories().map((c) => [c.id, c.path])));

  // --- Mercado Libre: predictor por título ---
  readonly mlPredictions = signal<MlCategoryPrediction[]>([]);
  readonly mlPredicting = signal(false);
  readonly mlPredictError = signal<string | null>(null);

  // --- Mercado Libre: explorador de árbol ---
  readonly mlTreeOpen = signal(false);
  readonly mlTreeRoots = signal<MlCategoryRef[]>([]);
  readonly mlTreeNode = signal<MlCategoryNode | null>(null);
  readonly mlTreeLoading = signal(false);
  readonly mlTreeError = signal<string | null>(null);

  // --- Mercado Libre: atributos de la categoría elegida ---
  readonly mlAttrsLoading = signal(false);
  readonly mlAttrsError = signal<string | null>(null);

  // --- SEO generado con IA (TN no expone API propia: lo generamos nosotros) ---
  readonly seoGenerating = signal(false);
  readonly seoError = signal<string | null>(null);

  /** Hijos a mostrar en el modal: los del nodo actual, o las raíces si estamos en el inicio. */
  readonly currentMlChildren = computed<MlCategoryRef[]>(() => {
    const node = this.mlTreeNode();
    return node ? node.children_categories : this.mlTreeRoots();
  });

  async ngOnInit(): Promise<void> {
    // Precargamos las categorías de TN para poblar el multi-select (requiere estar conectado).
    void this.loadTnCategories();
    // Los borradores vivían en localStorage; ahora viven en el backend (para poder retomar una
    // publicación fallida desde cualquier navegador). Migración única, antes de listar/restaurar.
    await this.store.migrateLocalDraftsToBackend();
    await this.store.refreshSavedDraftsList();
    await this.store.restoreMostRecentDraft();
    void this.store.loadPricingSettings();
    // El borrador restaurado ya trae sus atributos guardados (d.ml.attributes) y su categoría,
    // pero dos cosas NO se persisten en el borrador (son metadata de la categoría de ML, se pide
    // de nuevo): los candidatos a EJE (mlVariationAttrs) y el límite de fotos por categoría
    // (mlMaxPictures/mlMaxPicturesPerVar). Sin este refetch, un borrador restaurado mostraría el
    // selector de eje vacío y el límite de fotos en el fallback genérico.
    const categoryId = this.draft().ml.categoryId;
    if (categoryId) {
      void this.refreshMlVariationAttrs(categoryId);
      void this.refreshMlCategoryLimits(categoryId);
    }
  }

  ngOnDestroy(): void {
    this.store.destroy();
  }

  /* ---------- delegaciones al store (el template y los tests las llaman acá) ---------- */

  touch(): void { this.store.touch(); }
  effective(field: OverrideField<string>, common: string): string { return this.store.effective(field, common); }
  makeOwn(field: OverrideField<string>, common: string): void { this.store.makeOwn(field, common); }
  revert(field: OverrideField<string>): void { this.store.revert(field); }
  setMode(channel: Channel, mode: Parameters<ProductDraftStore['setMode']>[1]): void { this.store.setMode(channel, mode); }
  addAxis(): void { this.store.addAxis(); }
  removeAxis(index: number): void { this.store.removeAxis(index); }
  addVariant(): void { this.store.addVariant(); }
  removeVariant(id: string): void { this.store.removeVariant(id); }
  setMlAttributeValue(attr: MlAttribute, valueId: string): void { this.store.setMlAttributeValue(attr, valueId); }
  variantDefaultTitle(channel: Channel, v: ProductVariant): string { return this.store.variantDefaultTitle(channel, v); }
  variantTitle(channel: Channel, v: ProductVariant): string { return this.store.variantTitle(channel, v); }
  variantChipLabel(v: ProductVariant): string { return this.store.variantChipLabel(v); }
  mlBreakdown(price: number | null) { return this.store.mlBreakdown(price); }
  tnBreakdown(price: number | null) { return this.store.tnBreakdown(price); }
  images(channel: Channel) { return this.store.images(channel); }
  imageLimit(channel: Channel): number { return this.store.imageLimit(channel); }
  onImageFiles(channel: Channel, fileList: FileList | null): Promise<void> { return this.store.onImageFiles(channel, fileList); }
  removeImage(channel: Channel, index: number): void { this.store.removeImage(channel, index); }
  makeCover(channel: Channel, index: number): void { this.store.makeCover(channel, index); }
  reorderImage(channel: Channel, from: number, to: number): void { this.store.reorderImage(channel, from, to); }
  onImageDragStart(channel: Channel, index: number): void { this.store.onImageDragStart(channel, index); }
  onImageDrop(channel: Channel, index: number): void { this.store.onImageDrop(channel, index); }
  isVariantMlImage(v: ProductVariant, imageId: string): boolean { return this.store.isVariantMlImage(v, imageId); }
  toggleVariantMlImage(v: ProductVariant, imageId: string): void { this.store.toggleVariantMlImage(v, imageId); }
  isVariantTnImage(v: ProductVariant, imageId: string): boolean { return this.store.isVariantTnImage(v, imageId); }
  toggleVariantTnImage(v: ProductVariant, imageId: string): void { this.store.toggleVariantTnImage(v, imageId); }
  isTnCategorySelected(id: number): boolean { return this.store.isTnCategorySelected(id); }
  toggleTnCategory(id: number): void { this.store.toggleTnCategory(id); }
  saveDraft(): Promise<void> { return this.store.saveDraft(); }
  openDraft(id: string): Promise<void> { return this.store.openDraft(id); }
  deleteDraft(id: string): Promise<void> { return this.store.deleteDraft(id); }
  startNewDraft(): void {
    this.store.startNewDraft();
    // El panel de publicación es del borrador anterior: se va con él.
    this.resumedJobId = null;
    this.dismissResults();
  }
  toggleDraftsPanel(): void { this.store.toggleDraftsPanel(); }
  loadPricingSettings(): Promise<void> { return this.store.loadPricingSettings(); }

  /* ================= Tienda Nube: multi-select ================= */

  async loadTnCategories(): Promise<void> {
    this.tnCategoriesLoading.set(true);
    this.tnCategoriesError.set(null);
    try {
      this.tnCategories.set(await this.catalog.getTiendaNubeCategories());
    } catch (e) {
      this.tnCategoriesError.set(this.errMsg(e));
    } finally {
      this.tnCategoriesLoading.set(false);
    }
  }

  /** Nombre/path de una categoría TN por id (para los chips seleccionados). O(1) por índice. */
  tnCategoryName(id: number): string {
    return this.tnCategoryPathById().get(id) ?? `#${id}`;
  }

  /* ================= Mercado Libre: predictor ================= */

  async predictMlCategory(): Promise<void> {
    const d = this.draft();
    const title = this.effective(d.ml.title, d.common.baseName).trim();
    if (!title) {
      this.mlPredictError.set('Cargá primero un título para poder sugerir la categoría.');
      return;
    }
    this.mlPredicting.set(true);
    this.mlPredictError.set(null);
    try {
      this.mlPredictions.set(await this.catalog.predictMlCategory(title));
    } catch (e) {
      this.mlPredictError.set(this.errMsg(e));
    } finally {
      this.mlPredicting.set(false);
    }
  }

  /** Aplica una sugerencia del predictor: fija la categoría y precarga sus atributos. */
  async applyMlPrediction(p: MlCategoryPrediction): Promise<void> {
    const d = this.draft();
    d.ml.categoryId = p.category_id;
    d.ml.categoryName = p.category_name;
    // El predictor no trae los límites de fotos: usamos el fallback (12/10, casi universal en MLA).
    this.mlMaxPictures.set(ML_MAX_PICTURES_FALLBACK);
    this.mlMaxPicturesPerVar.set(ML_MAX_PICTURES_PER_VAR_FALLBACK);
    this.mlPredictions.set([]);
    this.store.touch();
    await this.loadMlAttributes(p.category_id, p.attributes);
  }

  /* ================= Mercado Libre: árbol ================= */

  async openMlTree(): Promise<void> {
    this.mlTreeOpen.set(true);
    this.mlTreeNode.set(null);
    this.mlTreeError.set(null);
    if (this.mlTreeRoots().length === 0) {
      this.mlTreeLoading.set(true);
      try {
        this.mlTreeRoots.set(await this.catalog.getMlRootCategories());
      } catch (e) {
        this.mlTreeError.set(this.errMsg(e));
      } finally {
        this.mlTreeLoading.set(false);
      }
    }
  }

  closeMlTree(): void {
    this.mlTreeOpen.set(false);
  }

  /** Navega a una categoría (carga su detalle: hijos, breadcrumb, si es hoja). */
  async openMlNode(id: string): Promise<void> {
    this.mlTreeLoading.set(true);
    this.mlTreeError.set(null);
    try {
      this.mlTreeNode.set(await this.catalog.getMlCategory(id));
    } catch (e) {
      this.mlTreeError.set(this.errMsg(e));
    } finally {
      this.mlTreeLoading.set(false);
    }
  }

  /** Salta a un nivel del breadcrumb; null = volver a las raíces. */
  async mlTreeBreadcrumb(id: string | null): Promise<void> {
    if (id === null) {
      this.mlTreeNode.set(null);
      return;
    }
    await this.openMlNode(id);
  }

  /** Selecciona el nodo actual si es hoja: fija la categoría y carga sus atributos. */
  async selectMlCurrentNode(): Promise<void> {
    const node = this.mlTreeNode();
    if (!node || !node.leaf) return;
    const d = this.draft();
    d.ml.categoryId = node.id;
    d.ml.categoryName = node.name;
    // La categoría define cuántas fotos admite (galería y por variación). positiveLimit y no
    // `??`: ML devuelve 0 en categorías mal configuradas, y un 0 acá bloqueaba toda selección.
    this.mlMaxPictures.set(positiveLimit(node.max_pictures, ML_MAX_PICTURES_FALLBACK));
    this.mlMaxPicturesPerVar.set(positiveLimit(node.max_pictures_per_var, ML_MAX_PICTURES_PER_VAR_FALLBACK));
    this.mlTreeOpen.set(false);
    this.store.touch();
    await this.loadMlAttributes(node.id);
  }

  clearMlCategory(): void {
    const d = this.draft();
    d.ml.categoryId = '';
    d.ml.categoryName = '';
    d.ml.attributes = [];
    this.store.mlVariationAttrs.set([]);
    this.mlMaxPictures.set(ML_MAX_PICTURES_FALLBACK);
    this.mlMaxPicturesPerVar.set(ML_MAX_PICTURES_PER_VAR_FALLBACK);
    this.store.touch();
  }

  /* ================= Mercado Libre: atributos required ================= */

  /**
   * Trae los atributos de la categoría y deja en el draft los OBLIGATORIOS listos para completar.
   * Precarga los valores que el predictor ya infirió (por id) y hereda BRAND de la marca común.
   */
  async loadMlAttributes(
    categoryId: string,
    predicted?: MlCategoryPrediction['attributes']
  ): Promise<void> {
    this.mlAttrsLoading.set(true);
    this.mlAttrsError.set(null);
    try {
      const attrs = await this.catalog.getMlCategoryAttributes(categoryId);
      const predById = new Map((predicted ?? []).map((p) => [p.id, p]));
      const brand = this.draft().common.brand;
      // Cargamos TODAS las características editables (obligatorias + opcionales), obligatorias primero.
      const mapped: MlAttribute[] = attrs.map((a) => {
        const pred = predById.get(a.id);
        const isBrand = a.id === 'BRAND';
        return {
          id: a.id,
          name: a.name,
          value: pred?.value_name ?? (isBrand ? brand : ''),
          valueId: pred?.value_id,
          required: a.required,
          conditionalRequired: a.conditionalRequired,
          inherited: isBrand,
          valueType: a.valueType,
          allowedValues: a.allowedValues,
          allowedUnits: a.allowedUnits,
          allowVariations: a.allowVariations
        };
      });
      // Los candidatos a EJE (allowVariations) se ofrecen en el selector de Variantes, no en la
      // lista general de características — si aparecieran en las dos, se podría terminar mandando
      // el mismo atributo (ej. COLOR) dos veces al publicar.
      this.draft().ml.attributes = mapped.filter((a) => !a.allowVariations);
      this.store.mlVariationAttrs.set(mapped.filter((a) => a.allowVariations));
      // Si el predictor ya dejó SALE_FORMAT con valor, UNITS_PER_PACK queda obligatorio → precarga 1.
      this.store.prefillConditionalRequired();
      this.store.touch();
    } catch (e) {
      this.mlAttrsError.set(this.errMsg(e));
    } finally {
      this.mlAttrsLoading.set(false);
    }
  }

  /**
   * Solo repone `mlVariationAttrs` (candidatos a eje) para una categoría YA elegida — a diferencia
   * de `loadMlAttributes`, NO toca `d.ml.attributes` (evitaría pisar los valores que el borrador
   * restaurado ya tenía cargados). Se usa al restaurar un borrador guardado.
   */
  private async refreshMlVariationAttrs(categoryId: string): Promise<void> {
    try {
      const attrs = await this.catalog.getMlCategoryAttributes(categoryId);
      this.store.mlVariationAttrs.set(
        attrs.filter((a) => a.allowVariations).map((a) => ({
          id: a.id,
          name: a.name,
          value: '',
          required: a.required,
          conditionalRequired: a.conditionalRequired,
          inherited: false,
          valueType: a.valueType,
          allowedValues: a.allowedValues,
          allowVariations: true
        }))
      );
    } catch {
      // silencioso: el selector de eje simplemente no ofrece opciones hasta que se reintente
      // (ej. re-eligiendo la categoría), no vale la pena un banner de error para esto.
    }
  }

  /**
   * Solo repone mlMaxPictures/mlMaxPicturesPerVar para una categoría YA elegida — se usa al
   * restaurar un borrador (esos límites no se persisten, ver product-draft.store.ts).
   */
  private async refreshMlCategoryLimits(categoryId: string): Promise<void> {
    try {
      const node = await this.catalog.getMlCategory(categoryId);
      this.mlMaxPictures.set(positiveLimit(node.max_pictures, ML_MAX_PICTURES_FALLBACK));
      this.mlMaxPicturesPerVar.set(positiveLimit(node.max_pictures_per_var, ML_MAX_PICTURES_PER_VAR_FALLBACK));
    } catch {
      // silencioso: quedan los fallback (12/10) hasta que se reintente
    }
  }

  /* ================= SEO con IA (título, descripción y tags de TN) ================= */

  /**
   * Genera SEO con IA (título, meta descripción y tags) a partir del nombre/descripción/marca y
   * la categoría, y lo carga en los campos de TN. Queda todo editable: es una sugerencia.
   */
  async generateSeo(): Promise<void> {
    const d = this.draft();
    const name = this.effective(d.tn.nameEs, d.common.baseName).trim();
    if (!name) {
      this.seoError.set('Cargá primero el nombre del producto.');
      return;
    }
    this.seoGenerating.set(true);
    this.seoError.set(null);
    try {
      // Contexto de categoría: la de ML es más descriptiva; si no hay, usamos las de TN.
      const category = d.ml.categoryName || d.tn.categories.map((id) => this.tnCategoryName(id)).join(', ');
      const seo = await this.catalog.generateSeo({
        name,
        description: this.effective(d.tn.description, ''),
        brand: d.common.brand,
        category
      });
      d.tn.seoTitle = seo.seoTitle;
      d.tn.seoDescription = seo.seoDescription;
      if (seo.tags) d.tn.tags = seo.tags;
      this.store.touch();
    } catch (e) {
      this.seoError.set(this.errMsg(e));
    } finally {
      this.seoGenerating.set(false);
    }
  }

  private errMsg(e: unknown): string {
    return this.store.errMsg(e);
  }

  /* ---------- publicar ---------- */

  /**
   * Publica el borrador en background: lo guarda (crea el id si hace falta), encola el job
   * (`POST /drafts/:id/publish`) y espera su resultado con polling — así la publicación sigue
   * corriendo en el servidor aunque se cierre la pestaña, y el reintento (`channels`, ej. ['ml'])
   * usa el MISMO job/borrador y no duplica lo que ya se publicó (ver publishWorker.js).
   */
  async publish(channels?: Channel[]): Promise<void> {
    if (this.hasPendingUploads()) {
      this.store.setImageError('draft', 'Esperá a que terminen de subirse las fotos antes de publicar.');
      return;
    }
    this.publishing.set(true);
    this.publishCancelled.set(false);
    if (!channels) {
      this.publishResults.set(null);
      this.publishProgress.set([]);
    }
    try {
      await this.store.saveDraft();
      const draftId = this.store.currentDraftId();
      if (!draftId) throw new Error('No se pudo guardar el borrador antes de publicar');
      const payload = this.buildPayloads();
      const { jobId } = await this.catalog.publishDraft(draftId, payload, channels);
      this.activeJobId.set(jobId);
      await this.pollJob(jobId, channels);
    } catch (e) {
      // Falla de red / servidor (guardando el borrador o encolando el job): marcamos error en
      // los canales que se intentaban publicar, igual que antes.
      const detail = this.errMsg(e);
      const failed = (channels ?? (['ml', 'tn'] as Channel[])).map(
        (channel) => ({ channel, status: 'error', detail }) as PublishResult
      );
      this.applyResults(failed, channels);
    } finally {
      this.publishing.set(false);
    }
  }

  /**
   * Reconstruye el estado de publicación de un borrador recién abierto a partir de su último job:
   * si sigue `pending`/`processing` retoma el polling (el job vive en el servidor); si ya terminó,
   * repuebla el progreso y el resultado SIN republicar nada. Nunca tira: un fallo acá no debe
   * romper la carga del borrador.
   */
  private async resumeLastPublishJob(job: PublishJobSummary): Promise<void> {
    this.resumedJobId = job.id;
    // Arrancamos de cero: si veníamos de otro borrador, no queremos que su resultado quede colgado
    // mientras se trae el de éste.
    this.publishResults.set(null);
    this.publishProgress.set([]);
    this.publishCancelled.set(false);
    this.activeJobId.set(job.id);
    const running = job.status === 'pending' || job.status === 'processing';
    try {
      if (running) {
        this.publishing.set(true);
        try {
          await this.pollJob(job.id);
        } finally {
          this.publishing.set(false);
        }
      } else {
        const { job: fresh, units } = await this.catalog.getPublishJob(job.id);
        this.publishProgress.set(units);
        this.applyResults(this.resultsFromJob(fresh, units), undefined);
      }
    } catch {
      // sin conexión / job borrado: se sigue mostrando solo el borrador, sin panel de publicación
    }
  }

  /** Pollea el job hasta que termina (done/error/cancelled), actualizando el progreso en cada vuelta. */
  private async pollJob(jobId: string, channels?: Channel[]): Promise<void> {
    try {
      for (;;) {
        if (this.publishCancelled()) return; // canceló mientras esperábamos el próximo poll
        const { job, units } = await this.catalog.getPublishJob(jobId);
        this.publishProgress.set(units);
        if (job.status === 'cancelled') {
          this.publishCancelled.set(true);
          return;
        }
        if (job.status === 'done' || job.status === 'error') {
          this.applyResults(this.resultsFromJob(job, units, channels), channels);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, CrearProductoComponent.JOB_POLL_MS));
      }
    } finally {
      this.activeJobId.set(null);
    }
  }

  /**
   * Cancela el job en curso (o trabado de una corrida anterior). No revierte lo ya creado en ML/TN
   * — solo frena el fan-out y saca el panel de "Publicando…". El worker corta entre unidad y unidad.
   */
  async cancelPublish(): Promise<void> {
    const jobId = this.activeJobId();
    if (!jobId) return;
    this.publishCancelled.set(true); // corta el polling ya, sin esperar la respuesta
    try {
      await this.catalog.cancelPublishJob(jobId);
    } catch {
      // aunque falle el request, para la usuaria el panel ya quedó cancelado; puede volver a publicar
    }
    this.publishing.set(false);
    void this.store.refreshSavedDraftsList();
  }

  /** Arma el `PublishResult` por canal a partir de las unidades del job (ok solo si TODAS lo están). */
  private resultsFromJob(job: PublishJobSummary, units: PublishUnit[], channels?: Channel[]): PublishResult[] {
    const chans = channels ?? (job.channels.split(',').filter(Boolean) as Channel[]);
    return chans.map((channel) => {
      const chUnits = units.filter((u) => u.channel === channel);
      const ok = chUnits.length > 0 && chUnits.every((u) => u.status === 'ok');
      let detail: string;
      if (ok) {
        detail = chUnits.length > 1 ? `${chUnits.length} publicaciones creadas` : (chUnits[0]?.detail ?? 'Publicado');
      } else {
        detail = chUnits.find((u) => u.status === 'error')?.detail ?? job.lastError ?? 'Error al publicar';
      }
      return { channel, status: ok ? 'ok' : 'error', detail } as PublishResult;
    });
  }

  /**
   * Fusiona resultados: reemplaza solo los canales recién publicados; el resto queda igual. El
   * borrador NUNCA se borra acá (a diferencia del flujo síncrono viejo): el estado que ve "Mis
   * borradores" (publicado / con errores / parcial) lo recalcula el propio backend cuando el job
   * termina, así el historial de publicación queda conservado y se puede reintentar más tarde.
   */
  private applyResults(incoming: PublishResult[], channels?: Channel[]): void {
    let merged: PublishResult[];
    if (!channels) {
      merged = incoming;
      this.publishResults.set(merged);
    } else {
      const byChannel = new Map((this.publishResults() ?? []).map((r) => [r.channel, r]));
      for (const r of incoming) byChannel.set(r.channel, r);
      merged = [...byChannel.values()];
      this.publishResults.set(merged);
    }
    void this.store.refreshSavedDraftsList();
  }

  /**
   * Arma el payload que consume el backend (POST /api/products), con forma cercana a cada API.
   * Incluye axes/variants crudos (para que el backend arme las variaciones de ML) y el
   * precio/stock base del producto simple.
   */
  buildPayloads(): {
    common: ProductDraft['common'];
    axes: ProductDraft['axes'];
    variants: unknown[];
    ml: unknown;
    tn: unknown;
  } {
    const d = this.draft();
    return {
      common: d.common,
      axes: d.axes,
      // Variantes con las referencias de imagen que espera el backend (snake_case).
      variants: d.variants.map((v) => ({
        sku: v.sku,
        values: v.values,
        // Código de barras propio de la variante; vacío = el backend no tiene fallback acá, así
        // que se resuelve el common ANTES de mandarlo (no todas las variantes traen el mismo).
        barcode: v.barcode || d.common.barcode || undefined,
        // Nombre de la publicación de TN cuando ese canal está en one_per_variant (uno por variante).
        name: this.variantTitle('tn', v),
        // El stock es el mismo en ambos canales: se manda igual a ML y a TN.
        ml: {
          price: v.ml.price,
          stock: v.stock,
          picture_ids: v.ml.pictureIds,
          // Título de la publicación de ML cuando ese canal está en one_per_variant.
          title: this.variantTitle('ml', v)
        },
        tn: { price: v.tn.price, stock: v.stock, image_ids: v.tn.imageIds }
      })),
      ml: {
        mapping_mode: d.ml.mappingMode,
        title: this.effective(d.ml.title, d.common.baseName),
        category_id: d.ml.categoryId,
        listing_type_id: d.ml.listingType,
        currency_id: d.ml.currency,
        condition: d.common.condition,
        buying_mode: 'buy_it_now',
        description: { plain_text: this.effective(d.ml.description, '') },
        attributes: [
          // Solo las características completadas: las vacías no se mandan (ML las rechaza).
          // Para atributos con valores cerrados mandamos value_id (ML lo prefiere); si no, value_name.
          ...d.ml.attributes
            .filter((a) => a.id && (a.valueId || a.value?.trim()))
            .map((a) => (a.valueId ? { id: a.id, value_id: a.valueId } : { id: a.id, value_name: a.value.trim() })),
          { id: 'SELLER_SKU', value_name: d.common.sku }
        ],
        // Garantía: si es "Sin garantía" no mandamos WARRANTY_TIME (ML lo rechaza / no aplica).
        sale_terms:
          d.ml.warrantyType === 'Sin garantía'
            ? [{ id: 'WARRANTY_TYPE', value_name: 'Sin garantía' }]
            : [
                { id: 'WARRANTY_TYPE', value_name: d.ml.warrantyType },
                { id: 'WARRANTY_TIME', value_name: d.ml.warrantyTime }
              ],
        // Peso/dimensiones van como atributos SELLER_PACKAGE_* (los arma el backend desde `common`).
        shipping: {
          mode: d.ml.shippingMode,
          free_shipping: d.ml.freeShipping,
          local_pick_up: d.ml.localPickup
        },
        // Ids de las imágenes ya subidas al backend, en orden (la primera es la portada).
        image_ids: d.ml.images.map((img) => img.id),
        // Precio/stock del producto simple (sin variantes); el stock es el mismo en ambos canales.
        base_price: d.ml.basePrice,
        base_stock: d.common.baseStock
      },
      tn: {
        mapping_mode: d.tn.mappingMode,
        name: { es: this.effective(d.tn.nameEs, d.common.baseName), pt: d.tn.namePt || undefined },
        handle: d.tn.handle ? { es: d.tn.handle } : undefined,
        description: { es: this.effective(d.tn.description, '') },
        // Nombres de los ejes (ej. "Color"), apareados por índice con `values` de cada variante —
        // sin esto TN no sabe qué representa cada valor (ver CLAUDE.md, bug "Color: Rojo").
        attributes: d.axes.length ? d.axes.map((a) => ({ es: a.name })) : undefined,
        // TN espera un array de IDs de categorías EXISTENTES (no nombres).
        categories: d.tn.categories,
        brand: d.common.brand,
        seo_title: d.tn.seoTitle,
        seo_description: d.tn.seoDescription,
        tags: d.tn.tags,
        free_shipping: d.tn.freeShipping,
        video_url: d.tn.videoUrl || undefined,
        // Ids de las imágenes ya subidas al backend, en orden (la primera es la portada).
        image_ids: d.tn.images.map((img) => img.id),
        variants: this.tnVariants(),
        // Precio/stock del producto simple (sin variantes); el backend los inyecta en la variante única.
        // El stock es el mismo en ambos canales.
        base_price: d.tn.basePrice,
        base_stock: d.common.baseStock,
        // Publicación real y visible en la tienda (ambos canales crean de verdad).
        published: true
      }
    };
  }

  private tnVariants(): unknown[] {
    const d = this.draft();
    const weightKg = d.common.weightG != null ? d.common.weightG / 1000 : null;
    // Instagram Shopping / Google Shopping: se cargan una vez en Datos generales y aplican a
    // TODAS las variantes (ver CLAUDE.md). `mpn` es opcional y se omite del todo si está vacío
    // (no se manda como `undefined`: es una clave menos, no una clave vacía); age_group/gender
    // siempre van (traen default "adult"/"unisex").
    const shopping: { mpn?: string; age_group: string; gender: string } = {
      age_group: d.common.ageGroup,
      gender: d.common.gender
    };
    if (d.common.mpn) shopping.mpn = d.common.mpn;
    if (d.variants.length === 0) {
      return [
        {
          sku: d.common.sku,
          barcode: d.common.barcode,
          weight: weightKg,
          width: d.common.widthCm,
          height: d.common.heightCm,
          depth: d.common.lengthCm,
          ...shopping
        }
      ];
    }
    // Peso y dimensiones son iguales para todas las variantes (vienen del común). El código de
    // barras es propio de cada una si se cargó uno; si no, cae al común (no todas traen el mismo).
    // `values` va LIMPIO (solo el valor, ej. "Rojo") — el nombre del eje ("Color") viaja aparte en
    // `tn.attributes`, apareado por índice; antes se metía acá adentro ("Color: Rojo").
    return d.variants.map((v) => ({
      sku: v.sku,
      values: v.values.map((value) => ({ es: value })),
      price: v.tn.price,
      stock: v.stock,
      barcode: v.barcode || d.common.barcode,
      weight: weightKg,
      width: d.common.widthCm,
      height: d.common.heightCm,
      depth: d.common.lengthCm,
      ...shopping
    }));
  }

  dismissResults(): void {
    this.publishResults.set(null);
    this.publishProgress.set([]);
    this.publishCancelled.set(false);
    this.activeJobId.set(null);
  }

  /**
   * Traduce los errores de publicación más comunes a una frase corta en castellano. El detalle
   * crudo de la API (útil para soporte) se sigue mostrando, colapsado bajo "Ver detalle técnico".
   * Devuelve `null` cuando no reconocemos el error → se muestra el texto crudo tal cual.
   */
  publishErrorSummary(detail: string | null | undefined): string | null {
    if (!detail) return null;
    const d = detail.toLowerCase();
    if (d.includes('units_per_pack') || d.includes('unidades por pack')) {
      return 'Falta completar "Unidades por pack" en los datos de Mercado Libre.';
    }
    if (d.includes('no conectado a mercado libre')) return 'No estás conectado a Mercado Libre.';
    if (d.includes('no conectado a tienda nube')) return 'No estás conectado a Tienda Nube.';
    if (d.includes('family name') || d.includes('family_name')) {
      return 'Mercado Libre rechazó las variantes (familia). Revisá los ejes de variante y la categoría.';
    }
    if (d.includes('leaf') || d.includes('categoría hoja') || d.includes('category_invalid')) {
      return 'La categoría de Mercado Libre no es una categoría final (hoja).';
    }
    if (/\b429\b/.test(d) || d.includes('rate limit') || d.includes('too many requests')) {
      return 'Mercado Libre está limitando los pedidos. Esperá un minuto y reintentá.';
    }
    return null;
  }

  /** Reintenta la publicación solo del canal que falló (vuelve a llamar al backend). */
  retry(channel: Channel): void {
    void this.publish([channel]);
  }
}
