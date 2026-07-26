import { Component, OnInit, computed, inject, signal } from '@angular/core';
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
  DraftImage,
  MappingMode,
  MlAttribute,
  OverrideField,
  ProductDraft,
  ProductVariant,
  PublishResult,
  emptyDraft,
  listingTypeLabel,
  projectionLabel
} from './product-draft.model';

let variantSeq = 1;

/** Imagen tal como se guarda en localStorage: sin `previewUrl` (se reconstruye al restaurar). */
interface StoredImageRef {
  id: string;
  name: string;
}

/** Un borrador guardado en localStorage (dentro de la lista de "Mis borradores"). */
interface StoredDraftEntry {
  id: string;
  savedAt: number;
  mlMaxPictures: number;
  mlMaxPicturesPerVar: number;
  draft: Omit<ProductDraft, 'ml' | 'tn'> & {
    ml: Omit<ProductDraft['ml'], 'images'> & { images: StoredImageRef[] };
    tn: Omit<ProductDraft['tn'], 'images'> & { images: StoredImageRef[] };
  };
}

@Component({
  selector: 'app-crear-producto',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './crear-producto.component.html',
  styleUrl: './crear-producto.component.scss'
})
export class CrearProductoComponent implements OnInit {
  private readonly catalog = inject(CatalogService);
  private readonly api = inject(ApiService);

  readonly draft = signal<ProductDraft>(emptyDraft());

  /* ---------- borradores locales (localStorage, varios a la vez) ---------- */
  private static readonly DRAFTS_KEY = 'zc-crear-producto-drafts';
  /** Clave vieja (versión de un solo borrador): se migra una vez y se borra. */
  private static readonly LEGACY_DRAFT_KEY = 'zc-crear-producto-draft';
  private static readonly MAX_DRAFTS = 20;

  /** Id del borrador que se está editando ahora (null = todavía no se guardó ninguno). */
  readonly currentDraftId = signal<string | null>(null);
  /** Momento del último guardado del borrador actual (null = no guardado en esta sesión). */
  readonly draftSavedAt = signal<Date | null>(null);
  /** true si al entrar se encontró y restauró el borrador más reciente. */
  readonly draftRestored = signal(false);
  /** Lista de borradores guardados (solo metadata, para el panel "Mis borradores"). */
  readonly savedDrafts = signal<{ id: string; label: string; savedAt: Date }[]>([]);
  readonly draftsPanelOpen = signal(false);

  /** Resultado de "Publicar en ambos" (null = todavía no se publicó). */
  readonly publishResults = signal<PublishResult[] | null>(null);
  readonly publishing = signal(false);

  protected readonly listingTypeLabel = listingTypeLabel;

  readonly hasVariants = computed(() => this.draft().axes.length > 0);

  readonly mlProjection = computed(() =>
    projectionLabel('ml', this.draft().ml.mappingMode, this.draft().variants.length)
  );
  readonly tnProjection = computed(() =>
    projectionLabel('tn', this.draft().tn.mappingMode, this.draft().variants.length)
  );

  /* ================= Categorías: estado ================= */

  // --- Tienda Nube: categorías existentes de la tienda ---
  readonly tnCategories = signal<TnCategory[]>([]);
  readonly tnCategoriesLoading = signal(false);
  readonly tnCategoriesError = signal<string | null>(null);

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

  // --- ML: comisiones / "cuánto recibís" ---
  readonly mlFee = signal<{ saleFee: number; net: number; currency: string; percentage: number | null } | null>(null);
  readonly mlFeeLoading = signal(false);
  readonly mlFeeError = signal<string | null>(null);
  private feeTimer: ReturnType<typeof setTimeout> | null = null;

  // --- Imágenes ---
  /** Límite de fotos por publicación ML (settings.max_pictures_per_item; fallback 12). */
  readonly mlMaxPictures = signal(12);
  /** Límite de fotos por variación ML (settings.max_pictures_per_item_var; fallback 10). */
  readonly mlMaxPicturesPerVar = signal(10);
  /** Tope de fotos por producto en TN (fijo por la API; error 422 al superar 250). */
  readonly TN_MAX_PICTURES = 250;
  readonly imageError = signal<string | null>(null);
  readonly uploadingImage = signal(false);
  /** Índice arrastrado en la galería (para reordenar con drag). */
  private dragIndex: { channel: Channel; index: number } | null = null;

  /** Hijos a mostrar en el modal: los del nodo actual, o las raíces si estamos en el inicio. */
  readonly currentMlChildren = computed<MlCategoryRef[]>(() => {
    const node = this.mlTreeNode();
    return node ? node.children_categories : this.mlTreeRoots();
  });

  ngOnInit(): void {
    // Precargamos las categorías de TN para poblar el multi-select (requiere estar conectado).
    void this.loadTnCategories();
    this.migrateLegacyDraft();
    this.refreshSavedDraftsList();
    this.restoreMostRecentDraft();
  }

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

  isTnCategorySelected(id: number): boolean {
    return this.draft().tn.categories.includes(id);
  }

  toggleTnCategory(id: number): void {
    const d = this.draft();
    d.tn.categories = d.tn.categories.includes(id)
      ? d.tn.categories.filter((x) => x !== id)
      : [...d.tn.categories, id];
    this.touch();
  }

  /** Nombre/path de una categoría TN por id (para los chips seleccionados). */
  tnCategoryName(id: number): string {
    return this.tnCategories().find((c) => c.id === id)?.path ?? `#${id}`;
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
    this.mlMaxPictures.set(12);
    this.mlMaxPicturesPerVar.set(10);
    this.mlPredictions.set([]);
    this.touch();
    await this.loadMlAttributes(p.category_id, p.attributes);
    void this.loadMlFee();
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
    // La categoría define cuántas fotos admite (galería y por variación).
    this.mlMaxPictures.set(node.max_pictures ?? 12);
    this.mlMaxPicturesPerVar.set(node.max_pictures_per_var ?? 10);
    this.mlTreeOpen.set(false);
    this.touch();
    await this.loadMlAttributes(node.id);
    void this.loadMlFee();
  }

  clearMlCategory(): void {
    const d = this.draft();
    d.ml.categoryId = '';
    d.ml.categoryName = '';
    d.ml.attributes = [];
    this.mlMaxPictures.set(12);
    this.mlMaxPicturesPerVar.set(10);
    this.touch();
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
      const d = this.draft();
      d.ml.attributes = mapped;
      this.touch();
    } catch (e) {
      this.mlAttrsError.set(this.errMsg(e));
    } finally {
      this.mlAttrsLoading.set(false);
    }
  }

  /** Al elegir un valor de un atributo tipo 'list', guardamos id y nombre. */
  setMlAttributeValue(attr: MlAttribute, valueId: string): void {
    const opt = attr.allowedValues?.find((v) => v.id === valueId);
    attr.valueId = valueId || undefined;
    attr.value = opt?.name ?? '';
    this.touch();
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
      this.touch();
    } catch (e) {
      this.seoError.set(this.errMsg(e));
    } finally {
      this.seoGenerating.set(false);
    }
  }

  /* ================= ML: "cuánto recibís" (comisiones) ================= */

  /** Se dispara al cambiar el precio ML: pide las comisiones con debounce. */
  onMlPriceChange(): void {
    if (this.feeTimer) clearTimeout(this.feeTimer);
    this.feeTimer = setTimeout(() => void this.loadMlFee(), 500);
  }

  /** Consulta las comisiones de ML para el precio simple + categoría + tipo de publicación. */
  async loadMlFee(): Promise<void> {
    const d = this.draft();
    const price = d.ml.basePrice;
    if (!price || price <= 0 || !d.ml.categoryId) {
      this.mlFee.set(null);
      this.mlFeeError.set(null);
      return;
    }
    this.mlFeeLoading.set(true);
    this.mlFeeError.set(null);
    try {
      const r = await this.catalog.getMlListingPrices(price, d.ml.categoryId, d.ml.listingType);
      this.mlFee.set({ saleFee: r.sale_fee_amount, net: r.net, currency: r.currency_id, percentage: r.percentage_fee });
    } catch (e) {
      this.mlFee.set(null);
      this.mlFeeError.set(this.errMsg(e));
    } finally {
      this.mlFeeLoading.set(false);
    }
  }

  private errMsg(e: unknown): string {
    const err = e as { error?: { error?: string }; message?: string };
    return err?.error?.error || err?.message || 'Error inesperado';
  }

  /* ---------- override-on-demand ---------- */

  /** El valor a mostrar/usar: el propio si fue editado, o el común si hereda. */
  effective(field: OverrideField<string>, common: string): string {
    return field.inherited ? common : field.value;
  }

  /** Marca un campo como propio del canal (copia el común como punto de partida). */
  makeOwn(field: OverrideField<string>, common: string): void {
    field.inherited = false;
    if (!field.value) field.value = common;
    this.touch();
  }

  /** Vuelve a heredar el campo del dato común. */
  revert(field: OverrideField<string>): void {
    field.inherited = true;
    this.touch();
  }

  /* ---------- mapping mode (Opción B) ---------- */

  setMode(channel: Channel, mode: MappingMode): void {
    const d = this.draft();
    if (channel === 'ml') d.ml.mappingMode = mode;
    else d.tn.mappingMode = mode;
    this.touch();
  }

  /* ---------- variantes ---------- */

  addAxis(): void {
    const d = this.draft();
    if (d.axes.length >= 3) return;
    d.axes.push({ name: '' });
    for (const v of d.variants) v.values.push('');
    if (d.variants.length === 0) this.addVariant();
    this.touch();
  }

  removeAxis(index: number): void {
    const d = this.draft();
    d.axes.splice(index, 1);
    for (const v of d.variants) v.values.splice(index, 1);
    if (d.axes.length === 0) d.variants = [];
    this.touch();
  }

  addVariant(): void {
    const d = this.draft();
    const variant: ProductVariant = {
      id: `v${variantSeq++}`,
      sku: '',
      values: d.axes.map(() => ''),
      stock: null,
      ml: { price: null, pictureIds: [] },
      tn: { price: null, imageIds: [] }
    };
    d.variants.push(variant);
    this.touch();
  }

  removeVariant(id: string): void {
    const d = this.draft();
    d.variants = d.variants.filter((v) => v.id !== id);
    this.touch();
  }

  /* ---------- atributos ML ---------- */

  /** Características obligatorias de la categoría (se muestran siempre). */
  readonly mlRequiredAttrs = computed(() => this.draft().ml.attributes.filter((a) => a.required));
  /** Características opcionales (se muestran en una sección colapsable para no saturar). */
  readonly mlOptionalAttrs = computed(() => this.draft().ml.attributes.filter((a) => !a.required));

  /**
   * Las características de la categoría no se agregan ni se quitan a mano: son las que define ML.
   * Se completan las que se quieran y las vacías simplemente no se envían (ver buildPayloads).
   */

  /* ---------- imágenes: subida real, galería, portada (drag) y por variante ---------- */

  /** Galería del canal. */
  images(channel: Channel): DraftImage[] {
    return channel === 'ml' ? this.draft().ml.images : this.draft().tn.images;
  }

  /** Tope de fotos de la galería del canal (ML depende de la categoría; TN es fijo). */
  imageLimit(channel: Channel): number {
    return channel === 'ml' ? this.mlMaxPictures() : this.TN_MAX_PICTURES;
  }

  /**
   * Sube los archivos elegidos: valida formato/tamaño/tope, sube cada uno al backend (base64) y
   * agrega la imagen a la galería del canal con su preview. Los errores se muestran inline.
   */
  async onImageFiles(channel: Channel, fileList: FileList | null): Promise<void> {
    if (!fileList || !fileList.length) return;
    this.imageError.set(null);
    const list = this.images(channel);
    const limit = this.imageLimit(channel);
    const channelName = channel === 'ml' ? 'Mercado Libre' : 'Tienda Nube';
    for (const file of Array.from(fileList)) {
      if (list.length >= limit) {
        this.imageError.set(`Máximo ${limit} fotos en ${channelName}.`);
        break;
      }
      if (!/^image\//.test(file.type)) {
        this.imageError.set(`"${file.name}" no es una imagen.`);
        continue;
      }
      if (channel === 'ml' && file.type === 'image/webp') {
        this.imageError.set('Mercado Libre no acepta WEBP: convertí a JPG o PNG.');
        continue;
      }
      if (file.size > 10 * 1024 * 1024) {
        this.imageError.set(`"${file.name}" supera los 10 MB.`);
        continue;
      }
      try {
        this.uploadingImage.set(true);
        const dataUrl = await this.readAsDataUrl(file);
        const up = await this.catalog.uploadImage({ filename: file.name, mime: file.type, data: dataUrl });
        list.push({ id: up.id, name: up.name, previewUrl: dataUrl });
        this.touch();
      } catch (e) {
        this.imageError.set(this.errMsg(e));
      } finally {
        this.uploadingImage.set(false);
      }
    }
  }

  private readAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('No se pudo leer el archivo'));
      reader.readAsDataURL(file);
    });
  }

  /** Quita una imagen de la galería, la desasigna de las variantes y la borra del backend. */
  removeImage(channel: Channel, index: number): void {
    const d = this.draft();
    const list = channel === 'ml' ? d.ml.images : d.tn.images;
    const [removed] = list.splice(index, 1);
    if (removed) {
      for (const v of d.variants) {
        if (channel === 'ml') v.ml.pictureIds = v.ml.pictureIds.filter((id) => id !== removed.id);
        else v.tn.imageIds = v.tn.imageIds.filter((id) => id !== removed.id);
      }
      void this.catalog.deleteImage(removed.id).catch(() => undefined);
    }
    this.touch();
  }

  /** Mueve una imagen a la primera posición (= portada). */
  makeCover(channel: Channel, index: number): void {
    this.reorderImage(channel, index, 0);
  }

  /** Reordena la galería (base de la portada = primera). */
  reorderImage(channel: Channel, from: number, to: number): void {
    const list = this.images(channel);
    if (from === to || from < 0 || from >= list.length || to < 0 || to >= list.length) return;
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    this.touch();
  }

  /* drag & drop para reordenar (la primera queda de portada) */
  onImageDragStart(channel: Channel, index: number): void {
    this.dragIndex = { channel, index };
  }
  onImageDrop(channel: Channel, index: number): void {
    if (this.dragIndex && this.dragIndex.channel === channel) {
      this.reorderImage(channel, this.dragIndex.index, index);
    }
    this.dragIndex = null;
  }

  /* asignación de fotos por variante */
  isVariantMlImage(v: ProductVariant, imageId: string): boolean {
    return v.ml.pictureIds.includes(imageId);
  }
  toggleVariantMlImage(v: ProductVariant, imageId: string): void {
    if (v.ml.pictureIds.includes(imageId)) {
      v.ml.pictureIds = v.ml.pictureIds.filter((id) => id !== imageId);
    } else {
      if (v.ml.pictureIds.length >= this.mlMaxPicturesPerVar()) {
        this.imageError.set(`Máximo ${this.mlMaxPicturesPerVar()} fotos por variación en Mercado Libre.`);
        return;
      }
      v.ml.pictureIds = [...v.ml.pictureIds, imageId];
    }
    this.touch();
  }
  /** En one_per_variant cada variante es su propio producto TN → admite varias fotos. */
  readonly tnMultiPerVariant = computed(() => this.draft().tn.mappingMode === 'one_per_variant');

  isVariantTnImage(v: ProductVariant, imageId: string): boolean {
    return v.tn.imageIds.includes(imageId);
  }
  /**
   * Asigna/desasigna una foto a la variante en TN. En single_with_variants es de a UNA (TN solo
   * admite `image_id` por variante); en one_per_variant es multi (cada variante = un producto).
   */
  toggleVariantTnImage(v: ProductVariant, imageId: string): void {
    if (v.tn.imageIds.includes(imageId)) {
      v.tn.imageIds = v.tn.imageIds.filter((id) => id !== imageId);
    } else if (this.tnMultiPerVariant()) {
      v.tn.imageIds = [...v.tn.imageIds, imageId];
    } else {
      v.tn.imageIds = [imageId];
    }
    this.touch();
  }

  /* ---------- borradores locales (varios a la vez, localStorage) ---------- */

  private genId(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  /** Nombre para mostrar en la lista: nombre base, o SKU, o un genérico. */
  private draftLabel(d: ProductDraft): string {
    const name = d.common.baseName?.trim();
    if (name) return name;
    const sku = d.common.sku?.trim();
    if (sku) return `SKU ${sku}`;
    return 'Borrador sin nombre';
  }

  /** Lee todos los borradores guardados. Tolerante a datos corruptos: devuelve []. */
  private readAllDrafts(): StoredDraftEntry[] {
    try {
      const raw = localStorage.getItem(CrearProductoComponent.DRAFTS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private writeAllDrafts(list: StoredDraftEntry[]): void {
    try {
      localStorage.setItem(CrearProductoComponent.DRAFTS_KEY, JSON.stringify(list));
    } catch {
      // localStorage no disponible (modo privado, cuota llena, etc.): no bloqueamos al usuario.
      this.imageError.set('No se pudo guardar el borrador en este navegador.');
    }
  }

  /** Migra el borrador único de la versión anterior (si existe) a la lista nueva, una sola vez. */
  private migrateLegacyDraft(): void {
    let raw: string | null;
    try {
      raw = localStorage.getItem(CrearProductoComponent.LEGACY_DRAFT_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    try {
      const legacy = JSON.parse(raw);
      if (legacy?.draft) {
        const entry: StoredDraftEntry = {
          id: this.genId(),
          savedAt: legacy.savedAt ?? Date.now(),
          mlMaxPictures: legacy.mlMaxPictures ?? 12,
          mlMaxPicturesPerVar: legacy.mlMaxPicturesPerVar ?? 10,
          draft: legacy.draft
        };
        const list = this.readAllDrafts();
        list.unshift(entry);
        this.writeAllDrafts(list);
      }
    } catch {
      // Borrador viejo corrupto: se descarta sin romper la página.
    } finally {
      try {
        localStorage.removeItem(CrearProductoComponent.LEGACY_DRAFT_KEY);
      } catch {
        /* noop */
      }
    }
  }

  /** Refresca la metadata para el panel "Mis borradores" (más reciente primero). */
  private refreshSavedDraftsList(): void {
    const list = this.readAllDrafts()
      .slice()
      .sort((a, b) => b.savedAt - a.savedAt)
      .map((e) => ({ id: e.id, label: this.draftLabel(e.draft as ProductDraft), savedAt: new Date(e.savedAt) }));
    this.savedDrafts.set(list);
  }

  /**
   * Guarda el borrador actual (nada se publica). Si ya se venía editando un borrador guardado
   * (currentDraftId), actualiza esa misma entrada; si no, crea una nueva. Las imágenes ya viven
   * en el store temporal del backend (POST /api/products/images): acá solo persistimos su
   * `id`/`name` — el `previewUrl` (puede ser un data: URL pesado) se reconstruye al restaurar.
   */
  saveDraft(): void {
    const d = this.draft();
    const stripPreview = (images: DraftImage[]) => images.map(({ id, name }) => ({ id, name }));
    const id = this.currentDraftId() ?? this.genId();
    const entry: StoredDraftEntry = {
      id,
      savedAt: Date.now(),
      mlMaxPictures: this.mlMaxPictures(),
      mlMaxPicturesPerVar: this.mlMaxPicturesPerVar(),
      draft: {
        ...d,
        ml: { ...d.ml, images: stripPreview(d.ml.images) },
        tn: { ...d.tn, images: stripPreview(d.tn.images) }
      }
    };
    const list = this.readAllDrafts();
    const idx = list.findIndex((e) => e.id === id);
    if (idx >= 0) list[idx] = entry;
    else list.unshift(entry);
    // Tope de borradores guardados: si se supera, se descartan los más viejos.
    this.writeAllDrafts(list.slice(0, CrearProductoComponent.MAX_DRAFTS));
    this.currentDraftId.set(id);
    this.draftSavedAt.set(new Date(entry.savedAt));
    this.refreshSavedDraftsList();
  }

  /** Carga un borrador guardado en el formulario (reconstruye los previews de imágenes). */
  private applyDraftEntry(entry: StoredDraftEntry): void {
    const restorePreview = (images: { id: string; name: string }[] = []): DraftImage[] =>
      images.map((img) => ({ ...img, previewUrl: `${this.api.baseUrl}/products/images/${img.id}` }));
    const d = entry.draft as ProductDraft;
    d.ml.images = restorePreview(entry.draft.ml.images as { id: string; name: string }[]);
    d.tn.images = restorePreview(entry.draft.tn.images as { id: string; name: string }[]);
    // Compat: borradores viejos guardaban `tn.imageId` (una sola); migramos a `imageIds` (array).
    for (const v of d.variants) {
      const tn = v.tn as { imageIds?: string[]; imageId?: string | null };
      if (!Array.isArray(tn.imageIds)) {
        tn.imageIds = tn.imageId ? [tn.imageId] : [];
        delete tn.imageId;
      }
    }
    this.draft.set(d);
    this.mlMaxPictures.set(entry.mlMaxPictures ?? 12);
    this.mlMaxPicturesPerVar.set(entry.mlMaxPicturesPerVar ?? 10);
    this.currentDraftId.set(entry.id);
    this.draftSavedAt.set(new Date(entry.savedAt));
  }

  /** Al entrar a la página, restaura automáticamente el borrador guardado más reciente (si hay). */
  private restoreMostRecentDraft(): void {
    const list = this.readAllDrafts();
    if (!list.length) return;
    const latest = list.reduce((a, b) => (b.savedAt > a.savedAt ? b : a));
    this.applyDraftEntry(latest);
    this.draftRestored.set(true);
  }

  /** Abre un borrador elegido desde el panel "Mis borradores". */
  openDraft(id: string): void {
    const entry = this.readAllDrafts().find((e) => e.id === id);
    if (!entry) return;
    this.applyDraftEntry(entry);
    this.draftRestored.set(false);
    this.draftsPanelOpen.set(false);
  }

  toggleDraftsPanel(): void {
    this.draftsPanelOpen.set(!this.draftsPanelOpen());
  }

  /** Elimina un borrador guardado para siempre. Si es el que se está editando, limpia el formulario. */
  deleteDraft(id: string): void {
    this.writeAllDrafts(this.readAllDrafts().filter((e) => e.id !== id));
    this.refreshSavedDraftsList();
    if (this.currentDraftId() === id) this.startNewDraft();
  }

  /** Limpia el formulario para empezar un producto nuevo (no borra nada de lo ya guardado). */
  startNewDraft(): void {
    this.draft.set(emptyDraft());
    this.mlMaxPictures.set(12);
    this.mlMaxPicturesPerVar.set(10);
    this.currentDraftId.set(null);
    this.draftSavedAt.set(null);
    this.draftRestored.set(false);
  }

  /** Borra el borrador actual de la lista guardada (se llama tras publicar con éxito). */
  private clearSavedDraft(): void {
    const id = this.currentDraftId();
    if (id) {
      this.writeAllDrafts(this.readAllDrafts().filter((e) => e.id !== id));
      this.refreshSavedDraftsList();
    }
    this.currentDraftId.set(null);
    this.draftSavedAt.set(null);
    this.draftRestored.set(false);
  }

  /* ---------- publicar ---------- */

  /**
   * Publica vía POST /api/products (fan-out real en el backend). Sin `channels` publica en ambos;
   * con `channels` (ej. ['ml']) reintenta solo ese canal y fusiona el resultado con los anteriores
   * (así no se re-publica el canal que ya salió OK).
   */
  async publish(channels?: Channel[]): Promise<void> {
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
    if (merged.length === 2 && merged.every((r) => r.status === 'ok')) this.clearSavedDraft();
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
        // El stock es el mismo en ambos canales: se manda igual a ML y a TN.
        ml: { price: v.ml.price, stock: v.stock, picture_ids: v.ml.pictureIds },
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
    // Peso, código de barras y dimensiones son iguales para todas las variantes (vienen del común).
    return d.variants.map((v) => ({
      sku: v.sku,
      values: v.values.map((value, i) => ({ es: `${d.axes[i]?.name ?? ''}: ${value}` })),
      price: v.tn.price,
      stock: v.stock,
      barcode: d.common.barcode,
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

  /** Fuerza una nueva referencia de la señal tras mutar el draft en sitio. */
  private touch(): void {
    this.draft.set({ ...this.draft() });
  }
}
