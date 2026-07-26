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
  barcode: string;
  condition: Condition;
  weightG: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  seoKeywords: string;
  /** Stock del producto SIMPLE (sin variantes). Es el mismo en ambos canales, no hay uno por canal. */
  baseStock: number | null;
}

export interface VariantAxis {
  /** Nombre del eje, ej. "Color" o "Tamaño". */
  name: string;
}

/** Imagen del borrador: ya subida al backend (id temporal) + preview local para mostrarla. */
export interface DraftImage {
  /** Id temporal devuelto por POST /api/products/images. Viaja en el payload al publicar. */
  id: string;
  /** Nombre del archivo (para mostrar / accesibilidad). */
  name: string;
  /** URL para el <img> (object URL local o /api/products/images/:id). */
  previewUrl: string;
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
  /** ML admite VARIAS fotos por variación (`picture_ids`); referencian ids de `ml.images`. */
  ml: { price: number | null; pictureIds: string[] };
  /**
   * Fotos de la variante en TN (referencian ids de `tn.images`).
   * - `single_with_variants`: TN solo admite UNA por variante (`image_id`) → la UI limita a 1.
   * - `one_per_variant`: cada variante es su propio producto → admite VARIAS (galería del producto).
   */
  tn: { price: number | null; imageIds: string[] };
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
      baseStock: null
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
    }
  };
}
