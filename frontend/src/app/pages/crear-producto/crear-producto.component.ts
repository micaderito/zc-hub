import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/services/api.service';
import {
  CatalogService,
  MlCategoryNode,
  MlCategoryPrediction,
  MlCategoryRef,
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
  imports: [CommonModule, FormsModule],
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

  protected readonly listingTypeLabel = listingTypeLabel;

  /** Resultado de "Publicar en ambos" (null = todavía no se publicó). */
  readonly publishResults = signal<PublishResult[] | null>(null);
  readonly publishing = signal(false);

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
    this.store.migrateLegacyDraft();
    this.store.refreshSavedDraftsList();
    this.store.restoreMostRecentDraft();
    void this.store.loadPricingSettings();
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
  saveDraft(): void { this.store.saveDraft(); }
  openDraft(id: string): void { this.store.openDraft(id); }
  deleteDraft(id: string): void { this.store.deleteDraft(id); }
  startNewDraft(): void { this.store.startNewDraft(); }
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
          inherited: isBrand,
          valueType: a.valueType,
          allowedValues: a.allowedValues,
          allowedUnits: a.allowedUnits
        };
      });
      this.draft().ml.attributes = mapped;
      this.store.touch();
    } catch (e) {
      this.mlAttrsError.set(this.errMsg(e));
    } finally {
      this.mlAttrsLoading.set(false);
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
   * Publica vía POST /api/products (fan-out real en el backend). Sin `channels` publica en ambos;
   * con `channels` (ej. ['ml']) reintenta solo ese canal y fusiona el resultado con los anteriores
   * (así no se re-publica el canal que ya salió OK).
   */
  async publish(channels?: Channel[]): Promise<void> {
    if (this.hasPendingUploads()) {
      this.store.setImageError('draft', 'Esperá a que terminen de subirse las fotos antes de publicar.');
      return;
    }
    this.publishing.set(true);
    if (!channels) this.publishResults.set(null);
    try {
      const payload = { ...this.buildPayloads(), channels };
      const res = await this.catalog.publishProduct(payload);
      this.applyResults(res.results as PublishResult[], channels);
    } catch (e) {
      // Falla de red / servidor: marcamos error en los canales publicados.
      const detail = this.errMsg(e);
      const failed = (channels ?? ['ml', 'tn']).map(
        (channel) => ({ channel, status: 'error', detail }) as PublishResult
      );
      this.applyResults(failed, channels);
    } finally {
      this.publishing.set(false);
    }
  }

  /** Fusiona resultados: reemplaza solo los canales recién publicados; el resto queda igual. */
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
    // Ya no hace falta el borrador local si los dos canales quedaron publicados.
    if (merged.length === 2 && merged.every((r) => r.status === 'ok')) this.store.clearSavedDraft();
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
    if (d.variants.length === 0) {
      return [
        {
          sku: d.common.sku,
          barcode: d.common.barcode,
          weight: weightKg,
          width: d.common.widthCm,
          height: d.common.heightCm,
          depth: d.common.lengthCm
        }
      ];
    }
    // Peso y dimensiones son iguales para todas las variantes (vienen del común). El código de
    // barras es propio de cada una si se cargó uno; si no, cae al común (no todas traen el mismo).
    return d.variants.map((v) => ({
      sku: v.sku,
      values: v.values.map((value, i) => ({ es: `${d.axes[i]?.name ?? ''}: ${value}` })),
      price: v.tn.price,
      stock: v.stock,
      barcode: v.barcode || d.common.barcode,
      weight: weightKg,
      width: d.common.widthCm,
      height: d.common.heightCm,
      depth: d.common.lengthCm
    }));
  }

  dismissResults(): void {
    this.publishResults.set(null);
  }

  /** Reintenta la publicación solo del canal que falló (vuelve a llamar al backend). */
  retry(channel: Channel): void {
    void this.publish([channel]);
  }
}
