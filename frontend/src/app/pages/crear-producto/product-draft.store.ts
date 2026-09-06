import { Injectable, NgZone, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import { CatalogService } from '../../core/services/catalog.service';
import { PricingService } from '../../core/services/pricing.service';
import {
  DEFAULT_SETTINGS,
  PricingSettings,
  computePrices,
  mlNetReceived,
  tiersFromConfig,
  tnNetReceived
} from '../../core/pricing/pricing-math';
import {
  Channel,
  DraftImage,
  MappingMode,
  MlAttribute,
  OverrideField,
  ProductDraft,
  ProductVariant,
  defaultVariantTitle,
  emptyDraft,
  inherited,
  normalizeDraft,
  positiveLimit,
  projectionLabel,
  variantLabel
} from './product-draft.model';

/** Dónde se muestra el error de imágenes, para que el aviso aparezca donde se hizo el click. */
export type ImageErrorScope = 'ml-gallery' | 'tn-gallery' | 'variant' | 'draft';

/** Tope de fotos por publicación / por variación de ML cuando la categoría no informa uno válido. */
export const ML_MAX_PICTURES_FALLBACK = 12;
export const ML_MAX_PICTURES_PER_VAR_FALLBACK = 10;

/** Cuánto se espera desde la última tecla antes de autoguardar. */
const AUTOSAVE_DELAY_MS = 1500;

/** Imagen tal como se guarda en localStorage: sin `previewUrl` (se reconstruye al restaurar). */
interface StoredImageRef {
  id: string;
  name: string;
}

/** Un borrador guardado en localStorage (dentro de la lista de "Mis borradores"). */
export interface StoredDraftEntry {
  id: string;
  savedAt: number;
  mlMaxPictures: number;
  mlMaxPicturesPerVar: number;
  draft: Omit<ProductDraft, 'ml' | 'tn'> & {
    ml: Omit<ProductDraft['ml'], 'images'> & { images: StoredImageRef[] };
    tn: Omit<ProductDraft['tn'], 'images'> & { images: StoredImageRef[] };
  };
}

/** Desglose de rentabilidad de un precio concreto. */
export interface Breakdown {
  net: number;
  marginPct: number | null;
}

/** Una fila de variante con todo lo derivado ya resuelto (ver `variantRows`). */
export interface VariantRow {
  v: ProductVariant;
  id: string;
  label: string;
  mlCount: number;
  tnCount: number;
  mlDefaultTitle: string;
  tnDefaultTitle: string;
}

/**
 * Estado del borrador de crear-producto, compartido por la página y sus sub-componentes.
 *
 * **Los datos del borrador NO viajan por `input()`.** `touch()` clona solo la raíz del draft, así
 * que los sub-objetos (`ml`, `tn`, cada variante) conservan su identidad: un `[ml]="draft().ml"`
 * hacia un hijo `OnPush` se compara con `Object.is`, da igual, y el hijo nunca se marca — los
 * cambios programáticos (cargar atributos, generar SEO, restaurar un borrador) no se pintarían
 * jamás. En cambio, leer `store.draft()` directo en el template del hijo registra esa vista como
 * consumidora de la señal, y Angular la marca para refresco aunque sea `OnPush`.
 *
 * De ahí la regla: **ningún componente puede cachear `draft()` en un field.** Siempre
 * `store.draft()` dentro del template o de un `computed()`.
 *
 * Se provee en los `providers` de la página (no `providedIn: 'root'`): una instancia por pantalla.
 */
@Injectable()
export class ProductDraftStore {
  private readonly catalog = inject(CatalogService);
  private readonly api = inject(ApiService);
  private readonly pricingSvc = inject(PricingService);
  private readonly zone = inject(NgZone);

  readonly draft = signal<ProductDraft>(emptyDraft());

  /**
   * Fuerza una nueva referencia de la señal tras mutar el draft en sitio. Es lo que hace que los
   * `computed()` derivados (y las vistas que leen `draft()`) se enteren: un `[(ngModel)]` muta una
   * propiedad anidada sin cambiar la referencia de la raíz.
   */
  touch(): void {
    this.draft.set({ ...this.draft() });
    this.scheduleAutosave();
  }

  /* ---------- borradores locales (localStorage, varios a la vez) ---------- */

  private static readonly DRAFTS_KEY = 'zc-crear-producto-drafts';
  /** Clave vieja (versión de un solo borrador): se migra una vez y se borra. */
  private static readonly LEGACY_DRAFT_KEY = 'zc-crear-producto-draft';
  private static readonly MAX_DRAFTS = 20;

  readonly currentDraftId = signal<string | null>(null);
  readonly draftSavedAt = signal<Date | null>(null);
  readonly draftRestored = signal(false);
  readonly savedDrafts = signal<{ id: string; label: string; savedAt: Date }[]>([]);
  readonly draftsPanelOpen = signal(false);

  /* ---------- proyección y variantes ---------- */

  readonly hasVariants = computed(() => this.draft().axes.length > 0);
  readonly mlProjection = computed(() =>
    projectionLabel('ml', this.draft().ml.mappingMode, this.draft().variants.length)
  );
  readonly tnProjection = computed(() =>
    projectionLabel('tn', this.draft().tn.mappingMode, this.draft().variants.length)
  );
  /** En one_per_variant cada variante es su propio producto TN → admite varias fotos. */
  readonly tnMultiPerVariant = computed(() => this.draft().tn.mappingMode === 'one_per_variant');

  /* ---------- imágenes ---------- */

  readonly mlMaxPictures = signal(ML_MAX_PICTURES_FALLBACK);
  readonly mlMaxPicturesPerVar = signal(ML_MAX_PICTURES_PER_VAR_FALLBACK);
  /** Tope de fotos por producto en TN (fijo por la API; error 422 al superar 250). */
  readonly TN_MAX_PICTURES = 250;
  readonly imageError = signal<string | null>(null);
  /**
   * Dónde mostrar `imageError`. Sin esto el aviso se pintaba solo dentro de las galerías de ML y
   * TN, o sea a cientos de píxeles del lugar donde se hizo el click.
   */
  readonly imageErrorScope = signal<ImageErrorScope | null>(null);
  readonly hasPendingUploads = computed(
    () => this.draft().ml.images.some((i) => i.uploading) || this.draft().tn.images.some((i) => i.uploading)
  );

  private dragIndex: { channel: Channel; index: number } | null = null;
  /** Pool de workers que generan la miniatura del preview sin tocar el hilo principal. */
  private readonly thumbPool: Worker[] = [];
  private thumbCursor = 0;
  private thumbSeq = 0;
  private readonly thumbWaiters = new Map<number, { resolve: (blob: Blob) => void; reject: (e: Error) => void }>();

  /* ---------- computeds "de índice" ---------- */

  /*
   * Evitan que la grilla de fotos por variante recorra arrays completos en cada ciclo de detección
   * de cambios: antes eran `Array.includes()` por celda, y con decenas de fotos × variantes eso se
   * sentía como el click que tarda en marcarse.
   */
  private readonly mlVariantImageSets = computed(() => {
    const map = new Map<string, Set<string>>();
    for (const v of this.draft().variants) map.set(v.id, new Set(v.ml?.pictureIds ?? []));
    return map;
  });
  private readonly tnVariantImageSets = computed(() => {
    const map = new Map<string, Set<string>>();
    for (const v of this.draft().variants) map.set(v.id, new Set(v.tn?.imageIds ?? []));
    return map;
  });
  readonly tnSelectedCategorySet = computed(() => new Set(this.draft().tn.categories));

  /**
   * Una fila por variante con todo lo derivado ya calculado. Antes el template llamaba a
   * `variantChipLabel()` y a `variantDefaultTitle()` por fila y por ciclo de CD.
   */
  readonly variantRows = computed<VariantRow[]>(() => {
    const d = this.draft();
    const mlBase = this.effective(d.ml.title, d.common.baseName);
    const tnBase = this.effective(d.tn.nameEs, d.common.baseName);
    return d.variants.map((v) => ({
      v,
      id: v.id,
      label: variantLabel(v.values) || v.sku || 'Variante',
      mlCount: v.ml.pictureIds.length,
      tnCount: v.tn.imageIds.length,
      mlDefaultTitle: defaultVariantTitle(mlBase, v.values),
      tnDefaultTitle: defaultVariantTitle(tnBase, v.values)
    }));
  });

  /** Rentabilidad por variante, memoizada (antes se recalculaba por fila en cada ciclo). */
  readonly variantBreakdowns = computed(() => {
    const map = new Map<string, { ml: Breakdown | null; tn: Breakdown | null }>();
    for (const v of this.draft().variants) {
      map.set(v.id, { ml: this.mlBreakdown(v.ml.price), tn: this.tnBreakdown(v.tn.price) });
    }
    return map;
  });

  /* ---------- rentabilidad ---------- */

  readonly pricingSettings = signal<PricingSettings>(DEFAULT_SETTINGS);
  readonly pricingLoading = signal(false);

  readonly hasCost = computed(() => {
    const c = this.draft().cost;
    return c.mode === 'unit' ? c.unitCost != null && c.unitCost > 0 : c.bulkPrice != null && c.bulkQty != null && c.bulkQty > 0;
  });

  readonly costPreview = computed(() => {
    if (!this.hasCost()) return null;
    const c = this.draft().cost;
    try {
      return computePrices(
        c.mode === 'unit'
          ? { unitCost: c.unitCost, marginPct: c.marginPct }
          : { bulkPrice: c.bulkPrice, bulkQty: c.bulkQty, discount1: c.discount1, discount2: c.discount2, marginPct: c.marginPct },
        this.pricingSettings()
      );
    } catch {
      return null;
    }
  });

  /** Desglose de "cuánto te queda" para el precio de ML realmente ingresado (no el sugerido). */
  mlBreakdown(price: number | null): Breakdown | null {
    const preview = this.costPreview();
    if (!price || price <= 0 || !preview) return null;
    const net = mlNetReceived(price, this.pricingSettings());
    const marginPct = preview.unitCost > 0 ? (net / preview.unitCost - 1) * 100 : null;
    return { net, marginPct };
  }

  /** Desglose de "cuánto te queda" para el precio de TN realmente ingresado. */
  tnBreakdown(price: number | null): Breakdown | null {
    const preview = this.costPreview();
    if (!price || price <= 0 || !preview) return null;
    const net = tnNetReceived(price, this.pricingSettings());
    const marginPct = preview.unitCost > 0 ? (net / preview.unitCost - 1) * 100 : null;
    return { net, marginPct };
  }

  /** true si el precio de ML ingresado cae en la "zona muerta" (arriba del umbral de envío gratis). */
  readonly mlFreeShippingZone = computed(() => {
    const price = this.draft().ml.basePrice;
    return !!price && price > this.pricingSettings().freeShippingThreshold;
  });

  /** Trae los valores fijos + tramos de comisión de ML que ya usa /precios (misma fuente de verdad). */
  async loadPricingSettings(): Promise<void> {
    this.pricingLoading.set(true);
    try {
      const config = await firstValueFrom(this.pricingSvc.getConfig());
      this.pricingSettings.set({ ...config.settings, tiers: tiersFromConfig(config.tiers) });
      const d = this.draft();
      // Solo si el borrador todavía tiene los defaults de fábrica (no pisamos lo que ya se cargó).
      if (d.cost.discount1 === 25 && d.cost.discount2 === 5 && d.cost.marginPct === 100) {
        d.cost.discount1 = config.settings.defaultDiscount1;
        d.cost.discount2 = config.settings.defaultDiscount2;
        d.cost.marginPct = config.settings.defaultMarginPct;
        this.draft.set({ ...d });
      }
    } catch {
      // Sin conexión a /precios: seguimos con los defaults de la planilla (DEFAULT_SETTINGS).
    } finally {
      this.pricingLoading.set(false);
    }
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

  /* ---------- títulos por variante (one_per_variant, uno por canal) ---------- */

  /** Título automático de la publicación de una variante: "<título del canal> - <valores>". */
  variantDefaultTitle(channel: Channel, v: ProductVariant): string {
    const d = this.draft();
    const base = channel === 'ml' ? this.effective(d.ml.title, d.common.baseName) : this.effective(d.tn.nameEs, d.common.baseName);
    return defaultVariantTitle(base, v.values);
  }

  /** Título efectivo de la publicación de esta variante (propio si se cargó uno, si no el automático). */
  variantTitle(channel: Channel, v: ProductVariant): string {
    const field = channel === 'ml' ? v.titles.ml : v.titles.tn;
    return this.effective(field, this.variantDefaultTitle(channel, v));
  }

  /** Etiqueta corta de la variante para listas/selectores ("Negro A4"). Única fuente en el front. */
  variantChipLabel(v: ProductVariant): string {
    return variantLabel(v.values) || v.sku || 'Variante';
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
    d.variants.push({
      // `genId()` (timestamp + random) y no un contador secuencial: el contador vivía en una
      // variable de módulo que se reinicia a 1 en cada carga de página. Restaurar un borrador con
      // variantes `v1`/`v2`/`v3` guardadas y agregar una variante nueva en esa sesión generaba OTRA
      // vez `v1`, duplicando el id de la primera — con dos filas compartiendo id, el modal de
      // "Elegir fotos" de la fila nueva terminaba resolviendo a la variante vieja.
      id: `v${this.genId()}`,
      sku: '',
      values: d.axes.map(() => ''),
      stock: null,
      // Vacío = usa el código de barras común: no todas las variantes vienen con el mismo código.
      barcode: '',
      ml: { price: null, pictureIds: [] },
      tn: { price: null, imageIds: [] },
      titles: { ml: inherited(''), tn: inherited('') }
    });
    this.touch();
  }

  removeVariant(id: string): void {
    const d = this.draft();
    d.variants = d.variants.filter((v) => v.id !== id);
    this.touch();
  }

  /* ---------- atributos de ML ---------- */

  readonly mlRequiredAttrs = computed(() => this.draft().ml.attributes.filter((a) => a.required));
  readonly mlOptionalAttrs = computed(() => this.draft().ml.attributes.filter((a) => !a.required));
  /**
   * Categorías con muchos atributos meten 50-150 filas opcionales al DOM. Solo se arman cuando la
   * usuaria abre el `<details>`.
   */
  readonly mlOptionalOpen = signal(false);

  /** Al elegir un valor de un atributo tipo 'list', guardamos id y nombre. */
  setMlAttributeValue(attr: MlAttribute, valueId: string): void {
    const opt = attr.allowedValues?.find((v) => v.id === valueId);
    attr.valueId = valueId || undefined;
    attr.value = opt?.name ?? '';
    this.touch();
  }

  /* ---------- categorías de TN (la lista vive en la página; acá solo la selección) ---------- */

  isTnCategorySelected(id: number): boolean {
    return this.tnSelectedCategorySet().has(id);
  }

  toggleTnCategory(id: number): void {
    const d = this.draft();
    d.tn.categories = d.tn.categories.includes(id)
      ? d.tn.categories.filter((x) => x !== id)
      : [...d.tn.categories, id];
    this.touch();
  }

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
   * Sube los archivos elegidos: valida formato/tamaño/tope y agrega de entrada una fila por foto
   * (con `uploading: true`), en el orden elegido. El original se sube tal cual — sin pasar por
   * base64/JSON — y la miniatura del preview se genera en paralelo en un Web Worker.
   */
  async onImageFiles(channel: Channel, fileList: FileList | null): Promise<void> {
    if (!fileList || !fileList.length) return;
    const galleryScope: ImageErrorScope = channel === 'ml' ? 'ml-gallery' : 'tn-gallery';
    this.setImageError(null, null);
    const list = this.images(channel);
    const limit = this.imageLimit(channel);
    const channelName = channel === 'ml' ? 'Mercado Libre' : 'Tienda Nube';

    // 1) Validar todo primero (formato / WEBP en ML / tamaño / tope de galería).
    const accepted: { file: File; localId: string }[] = [];
    for (const file of Array.from(fileList)) {
      if (list.length + accepted.length >= limit) {
        this.setImageError(galleryScope, `Máximo ${limit} fotos en ${channelName}.`);
        break;
      }
      if (!/^image\//.test(file.type)) {
        this.setImageError(galleryScope, `"${file.name}" no es una imagen.`);
        continue;
      }
      if (channel === 'ml' && file.type === 'image/webp') {
        this.setImageError(galleryScope, 'Mercado Libre no acepta WEBP: convertí a JPG o PNG.');
        continue;
      }
      if (file.size > 10 * 1024 * 1024) {
        this.setImageError(galleryScope, `"${file.name}" supera los 10 MB.`);
        continue;
      }
      accepted.push({ file, localId: `local-${this.genId()}` });
    }
    if (!accepted.length) return;

    // 2) Placeholders visibles de entrada, en el orden elegido. El `uid` es la identidad estable
    //    para el `track` de los `@for`: el `id` va a cambiar cuando responda el backend.
    for (const { file, localId } of accepted) {
      list.push({ id: localId, uid: localId, name: file.name, previewUrl: '', uploading: true });
    }
    this.touch();

    // 3) Subida + miniatura, con concurrencia acotada (3 a la vez).
    const CONCURRENCY = 3;
    let cursor = 0;
    const runNext = async (): Promise<void> => {
      while (cursor < accepted.length) {
        const { file, localId } = accepted[cursor++];
        try {
          // La subida arranca PRIMERO y la miniatura se genera en paralelo: el worker es una cola
          // serial, así que esperarlo antes de subir dejaba a los uploads formados detrás de él.
          const uploadPromise = this.catalog.uploadImageFile(file);
          const thumb = await this.makeThumb(file);
          const placeholder = list.find((i) => i.uid === localId);
          if (placeholder) {
            placeholder.previewUrl = thumb.url;
            this.touch();
          }
          const up = await uploadPromise;
          const idx = list.findIndex((i) => i.uid === localId);
          if (idx >= 0) {
            list[idx] = { ...list[idx], id: up.id, name: up.name, uploading: false };
            // El id cambió: las variantes que ya tenían asignada esta foto tienen que seguirlo.
            this.remapImageId(channel, localId, up.id);
            this.touch();
            // La miniatura se guarda en el backend para que al restaurar el borrador el preview NO
            // sea el original de varios MB. Fire-and-forget: si falla, el endpoint cae al original.
            if (thumb.blob) void this.catalog.uploadThumb(up.id, thumb.blob).catch(() => undefined);
          }
        } catch (e) {
          const idx = list.findIndex((i) => i.uid === localId);
          if (idx >= 0) {
            const [removed] = list.splice(idx, 1);
            if (removed?.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(removed.previewUrl);
            this.touch();
          }
          this.setImageError(galleryScope, this.errMsg(e));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, accepted.length) }, () => runNext()));
  }

  /**
   * Al terminar la subida, el id de la foto pasa de `local-…` al del backend. Si la usuaria ya la
   * había asignado a una variante mientras subía, esa asignación apunta al id viejo: sin este
   * remapeo la selección desaparece sola y la foto no viaja en el payload de publicación.
   */
  private remapImageId(channel: Channel, from: string, to: string): void {
    if (from === to) return;
    for (const v of this.draft().variants) {
      if (channel === 'ml') {
        if (v.ml.pictureIds.includes(from)) v.ml.pictureIds = v.ml.pictureIds.map((id) => (id === from ? to : id));
      } else if (v.tn.imageIds.includes(from)) {
        v.tn.imageIds = v.tn.imageIds.map((id) => (id === from ? to : id));
      }
    }
  }

  /** Setea el error de imágenes junto con dónde tiene que mostrarse. */
  setImageError(scope: ImageErrorScope | null, message: string | null): void {
    this.imageError.set(message);
    this.imageErrorScope.set(message ? scope : null);
  }

  /** Miniatura liviana para el `<img src>` del preview. Nunca el archivo original. */
  private async makeThumb(file: File): Promise<{ url: string; blob: Blob | null }> {
    const worker = this.nextThumbWorker();
    // Sin worker mostramos el original: no es ideal, pero es preferible a no mostrar nada.
    if (!worker) return { url: URL.createObjectURL(file), blob: null };
    const id = ++this.thumbSeq;
    try {
      const blob = await new Promise<Blob>((resolve, reject) => {
        this.thumbWaiters.set(id, { resolve, reject });
        worker.postMessage({ id, file });
      });
      return { url: URL.createObjectURL(blob), blob };
    } catch {
      // El worker falló (formato raro, etc.): mostramos el original antes que nada.
      return { url: URL.createObjectURL(file), blob: null };
    }
  }

  /**
   * Devuelve el siguiente worker del pool (round-robin). Con un worker único, las N miniaturas se
   * generaban de a una y las subidas concurrentes quedaban formadas detrás de esa cola.
   */
  private nextThumbWorker(): Worker | null {
    if (typeof Worker === 'undefined') return null;
    if (!this.thumbPool.length) {
      const size = Math.min(3, Math.max(1, navigator.hardwareConcurrency || 2));
      for (let i = 0; i < size; i++) {
        const worker = this.createThumbWorker();
        if (worker) this.thumbPool.push(worker);
      }
    }
    if (!this.thumbPool.length) return null;
    const worker = this.thumbPool[this.thumbCursor % this.thumbPool.length];
    this.thumbCursor++;
    return worker;
  }

  private createThumbWorker(): Worker | null {
    try {
      const worker = new Worker(new URL('./image-thumb.worker', import.meta.url), { type: 'module' });
      // El `id` del mensaje identifica al waiter, así que da igual qué worker del pool conteste.
      worker.onmessage = (ev: MessageEvent<{ id: number; blob?: Blob; error?: string }>) => {
        const waiter = this.thumbWaiters.get(ev.data.id);
        if (!waiter) return;
        this.thumbWaiters.delete(ev.data.id);
        if (ev.data.blob) waiter.resolve(ev.data.blob);
        else waiter.reject(new Error(ev.data.error || 'No se pudo generar la miniatura'));
      };
      worker.onerror = () => {
        // Worker roto por completo: los pendientes caen al fallback (createObjectURL directo).
        for (const [, w] of this.thumbWaiters) w.reject(new Error('Worker de miniaturas no disponible'));
        this.thumbWaiters.clear();
      };
      return worker;
    } catch {
      return null;
    }
  }

  /** Quita una imagen de la galería, la desasigna de las variantes y la borra del backend. */
  removeImage(channel: Channel, index: number): void {
    const d = this.draft();
    const list = channel === 'ml' ? d.ml.images : d.tn.images;
    const [removed] = list.splice(index, 1);
    if (removed) {
      if (removed.previewUrl.startsWith('blob:')) URL.revokeObjectURL(removed.previewUrl);
      for (const v of d.variants) {
        if (channel === 'ml') v.ml.pictureIds = v.ml.pictureIds.filter((id) => id !== removed.id);
        else v.tn.imageIds = v.tn.imageIds.filter((id) => id !== removed.id);
      }
      // Si todavía estaba subiendo, el id es local (no existe en el backend): nada que borrar.
      if (!removed.uploading) void this.catalog.deleteImage(removed.id).catch(() => undefined);
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

  /** O(1) por índice precalculado: se llama por cada celda de la grilla. */
  isVariantMlImage(v: ProductVariant, imageId: string): boolean {
    return this.mlVariantImageSets().get(v.id)?.has(imageId) ?? false;
  }

  toggleVariantMlImage(v: ProductVariant, imageId: string): void {
    if (v.ml.pictureIds.includes(imageId)) {
      v.ml.pictureIds = v.ml.pictureIds.filter((id) => id !== imageId);
    } else {
      // positiveLimit y no el valor crudo: ML devuelve 0 en categorías mal configuradas, y con un
      // 0 la comparación daba `0 >= 0` y bloqueaba en silencio TODA selección de fotos de ML.
      const max = positiveLimit(this.mlMaxPicturesPerVar(), ML_MAX_PICTURES_PER_VAR_FALLBACK);
      if (v.ml.pictureIds.length >= max) {
        this.setImageError('variant', `Máximo ${max} fotos por variación en Mercado Libre.`);
        return;
      }
      v.ml.pictureIds = [...v.ml.pictureIds, imageId];
    }
    this.touch();
  }

  /** O(1) por índice precalculado: se llama por cada celda de la grilla. */
  isVariantTnImage(v: ProductVariant, imageId: string): boolean {
    return this.tnVariantImageSets().get(v.id)?.has(imageId) ?? false;
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

  /** Reasigna id a cualquier variante repetida, dejando la primera ocurrencia tal cual. */
  private dedupeVariantIds(d: ProductDraft): void {
    const seen = new Set<string>();
    for (const v of d.variants) {
      if (seen.has(v.id)) v.id = `v${this.genId()}`;
      seen.add(v.id);
    }
  }

  /** Nombre para mostrar en la lista: nombre base, o SKU, o un genérico. */
  private draftLabel(d: ProductDraft): string {
    const name = d.common?.baseName?.trim();
    if (name) return name;
    const sku = d.common?.sku?.trim();
    if (sku) return `SKU ${sku}`;
    return 'Borrador sin nombre';
  }

  /** Lee todos los borradores guardados. Tolerante a datos corruptos: devuelve []. */
  private readAllDrafts(): StoredDraftEntry[] {
    try {
      const raw = localStorage.getItem(ProductDraftStore.DRAFTS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private writeAllDrafts(list: StoredDraftEntry[]): void {
    try {
      localStorage.setItem(ProductDraftStore.DRAFTS_KEY, JSON.stringify(list));
    } catch {
      // localStorage no disponible (modo privado, cuota llena, etc.): no bloqueamos al usuario.
      this.setImageError('draft', 'No se pudo guardar el borrador en este navegador.');
    }
  }

  /** Migra el borrador único de la versión anterior (si existe) a la lista nueva, una sola vez. */
  migrateLegacyDraft(): void {
    let raw: string | null;
    try {
      raw = localStorage.getItem(ProductDraftStore.LEGACY_DRAFT_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    try {
      const legacy = JSON.parse(raw);
      if (legacy?.draft) {
        const list = this.readAllDrafts();
        list.unshift({
          id: this.genId(),
          savedAt: legacy.savedAt ?? Date.now(),
          mlMaxPictures: positiveLimit(legacy.mlMaxPictures, ML_MAX_PICTURES_FALLBACK),
          mlMaxPicturesPerVar: positiveLimit(legacy.mlMaxPicturesPerVar, ML_MAX_PICTURES_PER_VAR_FALLBACK),
          draft: legacy.draft
        });
        this.writeAllDrafts(list);
      }
    } catch {
      // Borrador viejo corrupto: se descarta sin romper la página.
    } finally {
      try {
        localStorage.removeItem(ProductDraftStore.LEGACY_DRAFT_KEY);
      } catch {
        /* noop */
      }
    }
  }

  /** Refresca la metadata para el panel "Mis borradores" (más reciente primero). */
  refreshSavedDraftsList(): void {
    this.savedDrafts.set(
      this.readAllDrafts()
        .slice()
        .sort((a, b) => b.savedAt - a.savedAt)
        .map((e) => ({ id: e.id, label: this.draftLabel(e.draft as ProductDraft), savedAt: new Date(e.savedAt) }))
    );
  }

  /**
   * Guarda el borrador actual (nada se publica). Si ya se venía editando uno (`currentDraftId`),
   * actualiza esa misma entrada; si no, crea una nueva. Las imágenes ya viven en el store temporal
   * del backend: acá solo persistimos su `id`/`name`.
   *
   * `auto: true` es el autoguardado, y trae guardas extra para no ensuciar "Mis borradores".
   */
  saveDraft(opts: { auto?: boolean } = {}): void {
    if (this.hasPendingUploads()) {
      // Guardar ahora persistiría ids `local-…` que no existen en el backend.
      if (opts.auto) {
        this.scheduleAutosave();
        return;
      }
      this.setImageError('draft', 'Esperá a que terminen de subirse las fotos antes de guardar el borrador.');
      return;
    }
    const d = this.draft();
    // Entrar a la página y no tocar nada no tiene que crear un borrador vacío en la lista.
    if (opts.auto && this.isDraftEmpty(d)) return;

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
    // Si nada cambió desde el último guardado, el autoguardado no reescribe localStorage.
    const snapshot = JSON.stringify(entry.draft);
    if (opts.auto && snapshot === this.lastSavedSnapshot) return;
    this.lastSavedSnapshot = snapshot;

    const list = this.readAllDrafts();
    const idx = list.findIndex((e) => e.id === id);
    if (idx >= 0) list[idx] = entry;
    else list.unshift(entry);
    // Tope de borradores guardados: si se supera, se descartan los más viejos.
    this.writeAllDrafts(list.slice(0, ProductDraftStore.MAX_DRAFTS));
    this.currentDraftId.set(id);
    this.draftSavedAt.set(new Date(entry.savedAt));
    this.refreshSavedDraftsList();
  }

  /** Un borrador "vacío" es el que no tiene ni nombre, ni SKU, ni fotos, ni variantes. */
  private isDraftEmpty(d: ProductDraft): boolean {
    return (
      !d.common.baseName.trim() &&
      !d.common.sku.trim() &&
      !d.ml.images.length &&
      !d.tn.images.length &&
      !d.variants.length
    );
  }

  /* ---------- autoguardado ---------- */

  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSavedSnapshot: string | null = null;

  /**
   * Agenda el autoguardado. Se llama desde `touch()` y desde un handler delegado de `input`/
   * `change` en la raíz de la página (los eventos burbujean, así que un solo listener cubre todos
   * los campos del formulario, incluidos los que viven dentro de sub-componentes).
   *
   * Va fuera de la zona de Angular a propósito: si no, cada tecla dejaría agendado un ciclo de
   * detección de cambios completo para 1,5 s después.
   */
  scheduleAutosave(): void {
    this.cancelAutosave();
    // Entrar a la página, o tocar solo la categoría, no tiene por qué agendar nada: sin esto
    // quedaría un timer vivo desde el primer render para un borrador que no vale la pena guardar.
    if (this.isDraftEmpty(this.draft())) return;
    this.zone.runOutsideAngular(() => {
      this.autosaveTimer = setTimeout(() => this.zone.run(() => this.saveDraft({ auto: true })), AUTOSAVE_DELAY_MS);
    });
  }

  /** Cancela un autoguardado pendiente. Obligatorio antes de cambiar de borrador. */
  cancelAutosave(): void {
    if (this.autosaveTimer) {
      clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
    }
  }

  /** Carga un borrador guardado en el formulario (reconstruye los previews de imágenes). */
  private applyDraftEntry(entry: StoredDraftEntry): void {
    // El preview apunta a la MINIATURA, no al original: restaurar un borrador con 45 fotos servía
    // ~225 MB de archivos de resolución completa para pintarlos en cajas de 40-84 px.
    const restorePreview = (images: { id: string; name: string }[] = []): DraftImage[] =>
      images.map((img) => ({
        ...img,
        uid: img.id,
        previewUrl: `${this.api.baseUrl}/products/images/${img.id}/thumb`
      }));
    this.cancelAutosave();
    // Los blobs del borrador que estaba abierto ya no se usan más.
    this.revokeDraftBlobs(this.draft());
    // normalizeDraft rellena lo que falte: los borradores de versiones anteriores no traen `cost`,
    // ni `barcode`/`titles` por variante ni, en los más viejos, `ml.pictureIds` — y sin ese array
    // los computeds de selección tiraban TypeError y se caía el render de la página.
    const d = normalizeDraft(entry.draft);
    // Borradores guardados antes del fix de `addVariant()` (contador secuencial que se reiniciaba
    // en cada carga) pueden traer dos variantes con el mismo id — sin esto, el modal de "Elegir
    // fotos" de una seguía resolviendo a la otra para siempre. Se cura solo al restaurar, sin
    // tocar SKU/precio/fotos: sana la instancia en memoria del array, no el JSON guardado.
    this.dedupeVariantIds(d);
    d.ml.images = restorePreview(entry.draft.ml.images as { id: string; name: string }[]);
    d.tn.images = restorePreview(entry.draft.tn.images as { id: string; name: string }[]);
    this.draft.set(d);
    // positiveLimit (y no `??`) porque un 0 guardado por una versión anterior dejaba el límite de
    // fotos por variación en cero, y con eso NINGUNA foto de ML se podía seleccionar nunca más.
    this.mlMaxPictures.set(positiveLimit(entry.mlMaxPictures, ML_MAX_PICTURES_FALLBACK));
    this.mlMaxPicturesPerVar.set(positiveLimit(entry.mlMaxPicturesPerVar, ML_MAX_PICTURES_PER_VAR_FALLBACK));
    this.currentDraftId.set(entry.id);
    this.draftSavedAt.set(new Date(entry.savedAt));
    this.lastSavedSnapshot = JSON.stringify(entry.draft);
  }

  /** Al entrar a la página, restaura automáticamente el borrador guardado más reciente (si hay). */
  restoreMostRecentDraft(): void {
    const list = this.readAllDrafts();
    if (!list.length) return;
    this.applyDraftEntry(list.reduce((a, b) => (b.savedAt > a.savedAt ? b : a)));
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
    this.cancelAutosave();
    this.revokeDraftBlobs(this.draft());
    this.draft.set(emptyDraft());
    this.mlMaxPictures.set(ML_MAX_PICTURES_FALLBACK);
    this.mlMaxPicturesPerVar.set(ML_MAX_PICTURES_PER_VAR_FALLBACK);
    this.currentDraftId.set(null);
    this.draftSavedAt.set(null);
    this.draftRestored.set(false);
    this.lastSavedSnapshot = null;
  }

  /** Borra el borrador actual de la lista guardada (se llama tras publicar con éxito). */
  clearSavedDraft(): void {
    this.cancelAutosave();
    const id = this.currentDraftId();
    if (id) {
      this.writeAllDrafts(this.readAllDrafts().filter((e) => e.id !== id));
      this.refreshSavedDraftsList();
    }
    this.currentDraftId.set(null);
    this.draftSavedAt.set(null);
    this.draftRestored.set(false);
    this.lastSavedSnapshot = null;
  }

  /**
   * Libera los object URLs (`blob:`) de las miniaturas del borrador. Hay que llamarlo ANTES de
   * pisar el draft: si no, esos blobs quedan retenidos hasta que se cierre la pestaña.
   */
  revokeDraftBlobs(d: ProductDraft): void {
    for (const img of [...(d.ml?.images ?? []), ...(d.tn?.images ?? [])]) {
      if (img.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(img.previewUrl);
    }
  }

  /** Corta los workers y libera los blobs. Lo llama el `ngOnDestroy` de la página. */
  destroy(): void {
    this.cancelAutosave();
    for (const worker of this.thumbPool) worker.terminate();
    this.revokeDraftBlobs(this.draft());
  }

  errMsg(e: unknown): string {
    const err = e as { error?: { error?: string }; message?: string };
    return err?.error?.error || err?.message || 'Error inesperado';
  }
}
