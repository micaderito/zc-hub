/**
 * Modelo del borrador de producto del hub (Opción B).
 *
 * El hub es dueño de un "producto" lógico = un grupo de variantes unidas por SKU.
 * Cada canal decide CÓMO se proyecta ese grupo con un `mappingMode`:
 *   - 'single_with_variants' → 1 publicación/producto con todas las variantes
 *   - 'one_per_variant'      → 1 publicación/producto por cada variante
 *
 * El SKU sigue siendo la unidad 1:1 real entre plataformas (lo que ya usa el sync),
 * así ML puede ir agrupado y TN separado (o al revés) sin problema.
 */

export type Channel = 'ml' | 'tn';

export type MappingMode = 'single_with_variants' | 'one_per_variant';

export type Condition = 'new' | 'used';

/** Rango etario de TN (Instagram/Google Shopping). Ver CLAUDE.md — default "adult". */
export type AgeGroup = 'newborn' | 'infant' | 'toddler' | 'kids' | 'adult';
/** Sexo del producto de TN (Instagram/Google Shopping). Ver CLAUDE.md — default "unisex". */
export type Gender = 'female' | 'male' | 'unisex';

/** Campo que por defecto hereda del dato común y puede volverse propio del canal. */
export interface OverrideField<T> {
  /** true = usa el valor común; false = el canal tiene su propio valor. */
  inherited: boolean;
  /** Valor propio del canal (se usa solo cuando inherited = false). */
  value: T;
}

export function inherited<T>(value: T): OverrideField<T> {
  return { inherited: true, value };
}

/** Datos compartidos: se cargan una vez y valen para ambos canales. */
export interface CommonData {
  baseName: string;
  /** SKU base (producto sin variantes). Con variantes, el SKU vive en cada variante. */
  sku: string;
  brand: string;
  /** Código de barras por default: se aplica a toda variante que no ponga el suyo propio. */
  barcode: string;
  condition: Condition;
  weightG: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  seoKeywords: string;
  /** Stock del producto SIMPLE (sin variantes). Es el mismo en ambos canales, no hay uno por canal. */
  baseStock: number | null;
  /**
   * Instagram Shopping / Google Shopping (campos de TN, a nivel VARIANTE en su API — acá se
   * cargan una sola vez y aplican a todas). `mpn` es opcional; `ageGroup`/`gender` traen default
   * ("adult"/"unisex") porque son obligatorios para que el catálogo se sincronice bien y la
   * mayoría de los productos del rubro son justamente eso.
   */
  mpn: string;
  ageGroup: AgeGroup;
  gender: Gender;
}

export interface VariantAxis {
  /** Nombre del eje, ej. "Color" o "Tamaño". */
  name: string;
  /**
   * Atributo REAL de la categoría de ML que este eje representa (ej. "COLOR"), elegido en el
   * selector de Variantes. Sin esto, ML no puede agrupar bien las publicaciones en una familia
   * (ver CLAUDE.md → User Products): el eje viaja como atributo personalizado en vez de un CHILD_PK
   * reconocido. Vacío = atributo personalizado (ML también lo acepta, solo que no lo destaca).
   */
  mlAttributeId?: string;
  /** Valores permitidos de `mlAttributeId` (copiados del atributo elegido, para resolver value_id). */
  allowedValues?: { id: string; name: string }[];
}

/** Imagen del borrador: ya subida al backend (id temporal) + preview local para mostrarla. */
export interface DraftImage {
  /** Id temporal devuelto por POST /api/products/images. Viaja en el payload al publicar. */
  id: string;
  /**
   * Identidad ESTABLE de la fila, para el `track` de los `@for`. El `id` cambia (de `local-…` al
   * del backend) cuando termina la subida; si se trackea por él, Angular destruye y recrea el
   * `<img>` de esa foto en la galería y en cada fila de variante, forzando una decodificación
   * nueva por cada nodo. El `uid` se asigna una vez y no cambia nunca.
   */
  uid?: string;
  /** Nombre del archivo (para mostrar / accesibilidad). */
  name: string;
  /** URL para el <img> (object URL de la miniatura local, o /api/products/images/:id). */
  previewUrl: string;
  /**
   * true mientras el archivo original todavía se está subiendo al backend (la miniatura y el
   * `id` temporal ya están listos, así que la fila se puede mostrar de entrada). No viaja en el
   * payload de publicación: `hasPendingUploads()` bloquea publicar/guardar mientras exista una.
   */
  uploading?: boolean;
}

/** Costo del producto (compartido por todas sus variantes) para calcular ganancia/margen. */
export interface DraftCost {
  /** 'bulk': se carga precio por bulto + unidades. 'unit': costo unitario directo. */
  mode: 'bulk' | 'unit';
  bulkPrice: number | null;
  bulkQty: number | null;
  /** Descuentos de ESTA compra, en cadena (%). */
  discount1: number;
  discount2: number;
  /** Costo unitario directo (modo 'unit'). */
  unitCost: number | null;
  /** Ganancia deseada (%) sobre el costo unitario. */
  marginPct: number;
}

export interface ProductVariant {
  /** Id interno del borrador (no es el SKU). */
  id: string;
  /** SKU de la variante: la clave que une ML ↔ TN. */
  sku: string;
  /** Valor por eje, alineado con `axes` (ej. ["Negro", "A4"]). */
  values: string[];
  /** Stock: el mismo en ambos canales (no tiene sentido tenerlo por separado). */
  stock: number | null;
  /**
   * Código de barras propio de esta variante. Vacío = usa `common.barcode` (no todas las
   * variantes vienen con el mismo código del proveedor).
   */
  barcode: string;
  /** ML admite VARIAS fotos por variación (`picture_ids`); referencian ids de `ml.images`. */
  ml: { price: number | null; pictureIds: string[] };
  /**
   * Fotos de la variante en TN (referencian ids de `tn.images`).
   * - `single_with_variants`: TN solo admite UNA por variante (`image_id`) → la UI limita a 1.
   * - `one_per_variant`: cada variante es su propio producto → admite VARIAS (galería del producto).
   */
  tn: { price: number | null; imageIds: string[] };
  /**
   * Título propio de la publicación de esta variante cuando el canal está en `one_per_variant`.
   * `inherited: true` = se arma solo (ver `defaultVariantTitle`); no aplica en `single_with_variants`.
   */
  titles: { ml: OverrideField<string>; tn: OverrideField<string> };
}

/** Atributo de categoría de ML (se descubren con GET /categories/{id}/attributes). */
export interface MlAttribute {
  id: string;
  name: string;
  value: string;
  required: boolean;
  /** true cuando el valor sale de un dato común (ej. BRAND ← marca). */
  inherited: boolean;
  /** Tipo de valor de ML: 'list' | 'string' | 'number' | 'number_unit' | 'boolean'. */
  valueType?: string;
  /** Para atributos 'list': id del valor elegido (ML prefiere value_id sobre value_name). */
  valueId?: string;
  /** Valores permitidos (atributos 'list') para poblar un desplegable. */
  allowedValues?: { id: string; name: string }[];
  /** Unidades permitidas (atributos 'number_unit', ej. ["cm","mm"]). */
  allowedUnits?: string[];
  /** true = candidato a EJE de variante (COLOR, SIZE…), ver VariantAxis.mlAttributeId. */
  allowVariations?: boolean;
}

export interface MlListing {
  mappingMode: MappingMode;
  title: OverrideField<string>;
  categoryId: string;
  categoryName: string;
  listingType: 'gold_special' | 'gold_pro' | 'free';
  currency: string;
  warrantyType: string;
  warrantyTime: string;
  shippingMode: 'me2' | 'custom';
  freeShipping: boolean;
  localPickup: boolean;
  description: OverrideField<string>;
  attributes: MlAttribute[];
  /** Galería de ML (orden = orden de fotos; la primera es la portada). */
  images: DraftImage[];
  /** Precio del producto SIMPLE (sin variantes). Con variantes se usa el de cada variante. */
  basePrice: number | null;
}

export interface TnListing {
  mappingMode: MappingMode;
  nameEs: OverrideField<string>;
  namePt: string;
  handle: string;
  /** IDs de categorías EXISTENTES de la tienda (TN espera un array de ids, no nombres). */
  categories: number[];
  seoTitle: string;
  seoDescription: string;
  tags: string;
  videoUrl: string;
  freeShipping: boolean;
  description: OverrideField<string>;
  /** Galería de TN (orden = orden de fotos; la primera es la portada). */
  images: DraftImage[];
  /** Precio del producto SIMPLE (sin variantes). Con variantes se usa el de cada variante. */
  basePrice: number | null;
}

export interface ProductDraft {
  common: CommonData;
  axes: VariantAxis[];
  variants: ProductVariant[];
  ml: MlListing;
  tn: TnListing;
  cost: DraftCost;
}

/** Resultado por canal al publicar (cada uno informa por separado). */
export interface PublishResult {
  channel: Channel;
  status: 'ok' | 'error';
  /** Referencia creada (ej. MLA-1182) o detalle del error. */
  detail: string;
}

const LISTING_TYPE_LABELS: Record<MlListing['listingType'], string> = {
  gold_special: 'Clásica',
  gold_pro: 'Premium',
  free: 'Gratuita'
};

export function listingTypeLabel(t: MlListing['listingType']): string {
  return LISTING_TYPE_LABELS[t];
}

/** Texto de qué se va a crear en un canal según su modo y la cantidad de variantes. */
export function projectionLabel(channel: Channel, mode: MappingMode, variantCount: number): string {
  const unit = channel === 'ml' ? 'publicación' : 'producto';
  const unitPlural = channel === 'ml' ? 'publicaciones' : 'productos';
  const n = Math.max(1, variantCount);
  if (mode === 'single_with_variants') {
    return n > 1 ? `1 ${unit} con ${n} variantes` : `1 ${unit}`;
  }
  return n > 1 ? `${n} ${unitPlural} (uno por variante)` : `1 ${unit}`;
}

/** Nombre legible de una variante a partir de sus valores de eje, ej. ["Negro","A4"] → "Negro A4". */
export function variantLabel(values: string[]): string {
  return (values || []).map((v) => (v ?? '').trim()).filter(Boolean).join(' ');
}

/** Título por default de la publicación de una variante en modo one_per_variant. */
export function defaultVariantTitle(baseTitle: string, values: string[]): string {
  const label = variantLabel(values);
  const base = (baseTitle || '').trim();
  if (!base) return label;
  if (!label) return base;
  return `${base} - ${label}`;
}

/** Borrador vacío con valores por defecto razonables. */
export function emptyDraft(): ProductDraft {
  return {
    common: {
      baseName: '',
      sku: '',
      brand: '',
      barcode: '',
      condition: 'new',
      weightG: null,
      lengthCm: null,
      widthCm: null,
      heightCm: null,
      seoKeywords: '',
      baseStock: null,
      mpn: '',
      ageGroup: 'adult',
      gender: 'unisex'
    },
    axes: [],
    variants: [],
    ml: {
      mappingMode: 'single_with_variants',
      title: inherited(''),
      categoryId: '',
      categoryName: '',
      listingType: 'gold_pro',
      currency: 'ARS',
      warrantyType: 'Sin garantía',
      warrantyTime: '',
      shippingMode: 'me2',
      freeShipping: false,
      localPickup: false,
      description: inherited(''),
      attributes: [],
      images: [],
      basePrice: null
    },
    tn: {
      mappingMode: 'single_with_variants',
      nameEs: inherited(''),
      namePt: '',
      handle: '',
      categories: [],
      seoTitle: '',
      seoDescription: '',
      tags: '',
      videoUrl: '',
      freeShipping: false,
      description: inherited(''),
      images: [],
      basePrice: null
    },
    cost: {
      mode: 'bulk',
      bulkPrice: null,
      bulkQty: null,
      discount1: 25,
      discount2: 5,
      unitCost: null,
      marginPct: 100
    }
  };
}

/**
 * Límite de fotos saneado. `0`, `null`, `NaN` y los negativos NO son un límite válido: caen al
 * fallback. Existe porque `??` **no** coalesce el cero, y la API de ML devuelve
 * `max_pictures_per_item_var: 0` en categorías mal configuradas — con ese 0, la guarda
 * `length >= limite` daba `0 >= 0` y bloqueaba en silencio TODA selección de fotos en ML.
 */
export function positiveLimit(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Normaliza una variante que viene de `localStorage` (puede ser de una versión anterior del
 * borrador, sin los campos que se fueron agregando). Sin esto, un borrador viejo sin
 * `ml.pictureIds` hace explotar `new Set(v.ml.pictureIds)` y se cae el render de toda la página.
 */
export function normalizeVariant(raw: unknown, index = 0): ProductVariant {
  /** Forma laxa de una variante guardada: cualquier campo puede faltar o venir de una versión vieja. */
  type StoredTn = { price?: number | null; imageIds?: string[]; imageId?: string | null };
  const v = (raw ?? {}) as Partial<Omit<ProductVariant, 'tn'>> & { tn?: StoredTn };
  const tn: StoredTn = v.tn ?? {};
  return {
    id: v.id || `v${index + 1}`,
    sku: v.sku ?? '',
    values: Array.isArray(v.values) ? v.values : [],
    stock: v.stock ?? null,
    barcode: v.barcode ?? '',
    ml: {
      price: v.ml?.price ?? null,
      pictureIds: Array.isArray(v.ml?.pictureIds) ? v.ml!.pictureIds : []
    },
    tn: {
      price: tn.price ?? null,
      // Compat: los borradores viejos guardaban una sola foto en `tn.imageId`.
      imageIds: Array.isArray(tn.imageIds) ? tn.imageIds : tn.imageId ? [tn.imageId] : []
    },
    titles: {
      ml: v.titles?.ml ?? inherited(''),
      tn: v.titles?.tn ?? inherited('')
    }
  };
}

/** Normaliza un borrador guardado: mergea sobre `emptyDraft()` y sanea cada variante. */
export function normalizeDraft(raw: unknown): ProductDraft {
  const base = emptyDraft();
  const d = (raw ?? {}) as Partial<ProductDraft>;
  return {
    common: { ...base.common, ...(d.common ?? {}) },
    axes: Array.isArray(d.axes) ? d.axes : [],
    variants: Array.isArray(d.variants) ? d.variants.map((v, i) => normalizeVariant(v, i)) : [],
    ml: { ...base.ml, ...(d.ml ?? {}) },
    tn: { ...base.tn, ...(d.tn ?? {}) },
    cost: { ...base.cost, ...(d.cost ?? {}) }
  };
}
