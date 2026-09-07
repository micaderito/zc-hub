/**
 * Fan-out de creación de producto a ambos canales (POST /api/products).
 *
 * Recibe el payload que arma el front (crear-producto → buildPayloads) y construye los bodies
 * reales de cada API según el modo de mapeo (Opción B):
 *   - single_with_variants → 1 publicación/producto con todas las variantes,
 *   - one_per_variant      → 1 publicación/producto por cada variante,
 *   - sin variantes        → 1 publicación/producto simple (usa el precio/stock base).
 *
 * ML — MODELO DE PUBLICACIÓN (ver CLAUDE.md y docs/mercadolibre "user products"): la cuenta puede
 * estar en el modelo LEGACY (un ítem con `variations[]`) o en USER PRODUCTS (`user_product_seller`
 * en `GET /users/me`, ver lib/mlUserProducts.js). En User Products, `POST /items` RECHAZA el array
 * `variations[]` y RECHAZA que el vendedor mande `title` — hay que mandar `family_name` y crear un
 * ítem POR VARIACIÓN; ML agrupa los que comparten family_name + domain + condition + atributos
 * PARENT_PK en una sola familia (una ficha con selectores para el comprador). Por eso
 * `single_with_variants` bajo User Products también termina en N POST /items, no en uno solo.
 *
 * IMÁGENES: viajan en el payload como IDs temporales (subidos antes a POST /api/products/images,
 * guardados en imageStore). Si imageStore tiene URL pública (Supabase Storage configurado), se le
 * pasa esa URL directo a la API del canal (`pictures:[{source}]` en ML, `images:[{src,position}]`
 * en TN) y el canal la descarga solo — sin eso, se sube el binario (multipart en ML, base64 en TN,
 * como antes). Las imágenes son independientes por canal (`ml.image_ids` vs `tn.image_ids`).
 *
 * Cada canal se publica de forma independiente: si uno falla, el otro puede haber salido OK
 * (se reporta status por canal). No hay rollback: crear en ML y en TN son operaciones separadas.
 */
import * as ml from '../lib/mercadolibre.js';
import * as tn from '../lib/tiendanube.js';
import { getImage, getImageUrl } from './imageStore.js';
import { isUserProductSeller } from '../lib/mlUserProducts.js';
import { plainTextToHtml } from '../lib/richText.js';

/* ============================ Mercado Libre ============================ */

/** shipping del item: descarta dimensions null (ML rechaza null). */
function mlShipping(shipping) {
  if (!shipping) return undefined;
  const out = {
    mode: shipping.mode,
    free_shipping: !!shipping.free_shipping,
    local_pick_up: !!shipping.local_pick_up
  };
  if (shipping.dimensions) out.dimensions = shipping.dimensions;
  return out;
}

/**
 * Atributos de categoría SIN SELLER_SKU (en variaciones el SKU va por variación) y sin los que ya
 * se mandan como atributo de EJE (`axisAttributes`) — evita mandar el mismo atributo dos veces
 * cuando un eje de variante se mapeó a un atributo real de la categoría (ej. COLOR).
 */
function categoryAttrs(attributes, axes) {
  const axisIds = new Set((axes || []).map((a) => a.mlAttributeId).filter(Boolean));
  return (attributes || []).filter((a) => {
    const id = String(a.id || '');
    if (id.toUpperCase() === 'SELLER_SKU') return false;
    if (axisIds.has(a.id)) return false;
    return true;
  });
}

/**
 * Atributos de peso y dimensiones del paquete para ME2 (`SELLER_PACKAGE_*`). ML los quiere como
 * enteros con unidad (cm/g) y con mínimos (dimensiones ≥ 3 cm, peso ≥ 50 g). Los omite si falta
 * algún dato o no cumple el mínimo. `common` trae lengthCm/widthCm/heightCm (cm) y weightG (g).
 */
function packageAttributes(common) {
  if (!common) return [];
  const dim = (v) => (v != null && Number(v) >= 3 ? Math.round(Number(v)) : null);
  const length = dim(common.lengthCm);
  const width = dim(common.widthCm);
  const height = dim(common.heightCm);
  const weight = common.weightG != null && Number(common.weightG) >= 50 ? Math.round(Number(common.weightG)) : null;
  if (length == null || width == null || height == null || weight == null) return [];
  return [
    { id: 'SELLER_PACKAGE_LENGTH', value_name: `${length} cm` },
    { id: 'SELLER_PACKAGE_WIDTH', value_name: `${width} cm` },
    { id: 'SELLER_PACKAGE_HEIGHT', value_name: `${height} cm` },
    { id: 'SELLER_PACKAGE_WEIGHT', value_name: `${weight} g` }
  ];
}

/** Combinaciones de atributos de una variación LEGACY (ej. [{name:'Color', value_name:'Negro'}]). */
function attributeCombinations(axes, values) {
  return (axes || []).map((axis, i) => ({
    name: axis.name,
    value_name: values?.[i] ?? ''
  }));
}

/** Quita acentos y normaliza mayúsculas, para comparar el valor de un eje contra `allowedValues`. */
function normalizeForMatch(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Atributos de EJE de variante para el modelo User Products: cada eje se manda como atributo del
 * ítem — el CHILD_PK real de la categoría si el eje está mapeado a uno (`axis.mlAttributeId`, ver
 * variants-section: selector de atributo por eje), o un atributo personalizado (solo `name`, sin
 * `id`, que ML también acepta) si no se mapeó. Con mapeo, se prefiere `value_id` sobre
 * `value_name` cuando el valor coincide con una opción cerrada de `axis.allowedValues` (lo que ML
 * prefiere para atributos de lista, ver CLAUDE.md).
 */
function axisAttributes(axes, values) {
  return (axes || [])
    .map((axis, i) => {
      const value = values?.[i];
      if (!value) return null;
      if (axis.mlAttributeId) {
        const match = (axis.allowedValues || []).find((v) => normalizeForMatch(v.name) === normalizeForMatch(value));
        return match ? { id: axis.mlAttributeId, value_id: match.id } : { id: axis.mlAttributeId, value_name: value };
      }
      return axis.name ? { name: axis.name, value_name: value } : null;
    })
    .filter(Boolean);
}

/** Ref de imagen ya resuelta para el body de ML: `{id}` (subida) o `{source}` (URL, ML la descarga). */
function toMlPictures(tempIds, picMap) {
  return (tempIds || []).map((id) => picMap.get(id)).filter(Boolean);
}

/** Atributo GTIN (código de barras). ML lo rechaza vacío, así que solo se manda si hay dato. */
function gtinAttr(barcode) {
  return barcode ? [{ id: 'GTIN', value_name: String(barcode) }] : [];
}

/**
 * Red de seguridad para el par `SALE_FORMAT` ("Formato de venta": Unidad / Pack) ↔ `UNITS_PER_PACK`
 * ("Unidades por pack"): ML marca `UNITS_PER_PACK` como `conditional_required` y rechaza el
 * `POST /items` apenas se manda `SALE_FORMAT` sin la cantidad ("Completá este campo porque
 * completaste 'Unidad'…"). El predictor de categoría suele pre-inferir `SALE_FORMAT`, así que el
 * caso es frecuente. Si viene el formato y no la cantidad, la completamos en 1 — es lo correcto
 * para "Unidad" y para esta app, que publica productos por unidad (cada variante es un SKU). El
 * front además ahora pide `UNITS_PER_PACK` en cuanto `SALE_FORMAT` tiene valor (ver
 * product-draft.model: CONDITIONAL_REQUIRED_TRIGGERS), así que en un "Pack" real el usuario ya
 * mandó la cantidad y esto no la pisa.
 */
function withUnitsPerPack(attributes) {
  const attrs = attributes || [];
  const hasSaleFormat = attrs.some((a) => a.id === 'SALE_FORMAT' && (a.value_id || a.value_name));
  if (!hasSaleFormat) return attrs;
  // ML quiere un entero positivo por `value_name` (nunca `value_id`). Un borrador migrado de antes
  // del fix puede traer `UNITS_PER_PACK` vacío, con basura o con un `value_id` espurio (que ML
  // rechaza con "El valor que ingresaste … es incorrecto"): lo normalizamos, no solo lo agregamos.
  const cleanCount = (raw) => {
    const n = parseInt(String(raw ?? '').trim(), 10);
    return Number.isFinite(n) && n >= 1 && n <= 1000 ? String(n) : '1';
  };
  const idx = attrs.findIndex((a) => a.id === 'UNITS_PER_PACK');
  if (idx === -1) return [...attrs, { id: 'UNITS_PER_PACK', value_name: '1' }];
  return attrs.map((a, i) => (i === idx ? { id: 'UNITS_PER_PACK', value_name: cleanCount(a.value_name) } : a));
}

/**
 * Construye la(s) publicación(es) de ML según el modo de mapeo y el modelo de la cuenta.
 * `picMap` mapea id temporal → ref de imagen ya resuelta (`{id}` o `{source}`, ver toMlPictures).
 * `opts.userProducts`: true si la cuenta ya está en el modelo User Products (ver lib/mlUserProducts.js).
 */
export function buildMlItems(payload, picMap = new Map(), opts = {}) {
  const userProducts = !!opts.userProducts;
  const { ml: m, axes, variants, common } = payload;
  // Atributos de la categoría con la red de seguridad de UNITS_PER_PACK aplicada una sola vez.
  const mAttrs = withUnitsPerPack(m.attributes);
  const galleryPics = toMlPictures(m.image_ids, picMap);
  // Peso/dimensiones del paquete (ME2) van como atributos del ítem.
  const pkgAttrs = packageAttributes(common);
  const base = {
    category_id: m.category_id,
    currency_id: m.currency_id,
    buying_mode: m.buying_mode,
    condition: m.condition,
    listing_type_id: m.listing_type_id,
    sale_terms: m.sale_terms,
    pictures: galleryPics,
    shipping: mlShipping(m.shipping)
  };
  // En modelo legacy el vendedor elige el título; en User Products ML lo arma automáticamente y
  // en su lugar hay que mandar `family_name` (agrupa las publicaciones de una misma familia).
  // Mandar `title` con `userProducts` activo hace que ML rechace el POST.
  const nameField = (name) => (userProducts ? { family_name: name } : { title: name });

  const hasVariants = Array.isArray(variants) && variants.length > 0;

  // Producto simple: precio/stock base + SELLER_SKU + paquete al nivel del item + GTIN si hay código.
  if (!hasVariants) {
    return [
      {
        ...base,
        ...nameField(m.title),
        price: m.base_price,
        available_quantity: m.base_stock,
        attributes: [...mAttrs, ...pkgAttrs, ...gtinAttr(common?.barcode)]
      }
    ];
  }

  if (m.mapping_mode === 'one_per_variant') {
    return variants.map((v) => {
      const own = toMlPictures(v.ml?.picture_ids, picMap);
      // Título propio de la variante si se cargó uno; si no, el automático de siempre (base + valores).
      const autoTitle = [m.title, ...(v.values || [])].filter(Boolean).join(' ').trim();
      const title = v.ml?.title && String(v.ml.title).trim() ? String(v.ml.title).trim() : autoTitle;
      return {
        ...base,
        ...nameField(title),
        price: v.ml?.price,
        available_quantity: v.ml?.stock,
        attributes: [
          ...categoryAttrs(mAttrs, axes),
          ...pkgAttrs,
          { id: 'SELLER_SKU', value_name: v.sku },
          ...axisAttributes(axes, v.values),
          ...gtinAttr(v.barcode)
        ],
        pictures: own.length ? own : galleryPics
      };
    });
  }

  // single_with_variants, modelo LEGACY: una publicación con variations[] (ML permite el mismo
  // precio en todas — ver CLAUDE.md "Precio por variación").
  if (!userProducts) {
    return [
      {
        ...base,
        title: m.title,
        attributes: [...categoryAttrs(mAttrs, axes), ...pkgAttrs],
        variations: variants.map((v) => {
          // `picture_ids` de una variación LEGACY solo acepta ids ya subidos al pool del ítem
          // (no `{source}`: la variación no puede referenciar una URL suelta) — si la imagen se
          // resolvió por URL (Supabase) en vez de subida, no hay id que usar acá y se omite.
          const picIds = (v.ml?.picture_ids || []).map((id) => picMap.get(id)?.id).filter(Boolean);
          const variation = {
            attribute_combinations: attributeCombinations(axes, v.values),
            price: v.ml?.price,
            available_quantity: v.ml?.stock,
            attributes: [{ id: 'SELLER_SKU', value_name: v.sku }, ...gtinAttr(v.barcode)]
          };
          if (picIds.length) variation.picture_ids = picIds;
          return variation;
        })
      }
    ];
  }

  // single_with_variants, modelo USER PRODUCTS: N ítems con el MISMO family_name — ML los agrupa
  // en una sola ficha con selectores (no existe forma de mandar "una publicación con variantes").
  return variants.map((v) => {
    const own = toMlPictures(v.ml?.picture_ids, picMap);
    return {
      ...base,
      family_name: m.title,
      price: v.ml?.price,
      available_quantity: v.ml?.stock,
      attributes: [
        ...categoryAttrs(mAttrs, axes),
        ...pkgAttrs,
        { id: 'SELLER_SKU', value_name: v.sku },
        ...axisAttributes(axes, v.values),
        ...gtinAttr(v.barcode)
      ],
      pictures: own.length ? own : galleryPics
    };
  });
}

/**
 * Resuelve las imágenes de ML del payload a `{id}` (subida) o `{source}` (URL pública, si
 * imageStore la tiene — ver getImageUrl). Con URL pública NO se sube el binario: ML lo descarga
 * solo, lo que evita un POST multipart por foto (con 10 fotos por variación, esto es la diferencia
 * entre 1 request y 10 por variación).
 */
export async function resolveMlImages(payload, mlToken) {
  const map = new Map();
  const ids = new Set(payload.ml?.image_ids || []);
  // Incluir también las asignadas por variante (por si no están en la galería general).
  for (const v of payload.variants || []) for (const id of v.ml?.picture_ids || []) ids.add(id);
  for (const tempId of ids) {
    const url = await getImageUrl(tempId);
    if (url) {
      map.set(tempId, { source: url });
      continue;
    }
    const img = await getImage(tempId);
    if (!img) continue;
    const pictureId = await ml.uploadPicture(mlToken, img.buffer, img.filename, img.mime);
    map.set(tempId, { id: pictureId });
  }
  return map;
}

/** `unit_key` (SKU) de un ítem de ML ya armado por `buildMlItems`, para el progreso/idempotencia
 *  del publish en background (ver services/publishWorker.js). El legacy `single_with_variants`
 *  no lleva SELLER_SKU a nivel ítem (va por variación) — cae a '' a propósito: ese caso siempre
 *  produce UN solo ítem, así que una sola unidad con key '' identifica bien esa publicación. */
export function mlUnitKey(itemBody) {
  return itemBody.attributes?.find((a) => a.id === 'SELLER_SKU')?.value_name ?? '';
}

/**
 * Resuelve las imágenes y arma los ítems de ML a publicar, listos como unidades `{unitKey, body}`
 * — usa `resolveMlImages`/`buildMlItems` (las mismas que `publishMl`) para que el worker no tenga
 * una segunda copia de esta lógica. Requiere `mlToken` porque `userProducts` y la resolución de
 * imágenes le pegan a la API.
 */
export async function planMlUnits(payload, mlToken) {
  const picMap = await resolveMlImages(payload, mlToken);
  const userProducts = await isUserProductSeller(mlToken).catch(() => false);
  const items = buildMlItems(payload, picMap, { userProducts });
  return items.map((body) => ({ unitKey: mlUnitKey(body), body }));
}

/**
 * Crea UN ítem de ML (y su descripción) — la unidad mínima de publicación. La usa tanto
 * `publishMl` (todo de una) como el worker en background (una unidad por vez, con progreso).
 */
export async function publishMlUnit(itemBody, mlToken, descriptionText) {
  const item = await ml.createItem(mlToken, itemBody);
  if (item?.id && descriptionText?.trim()) {
    await ml.setItemDescription(mlToken, item.id, descriptionText);
  }
  return { externalId: item?.id, detail: `Publicación ${item?.id} creada` };
}

async function publishMl(payload, mlToken) {
  if (!mlToken) return { channel: 'ml', status: 'error', detail: 'No conectado a Mercado Libre' };
  let picMap;
  try {
    picMap = await resolveMlImages(payload, mlToken);
  } catch (e) {
    return { channel: 'ml', status: 'error', detail: `Error subiendo imágenes a ML: ${e.message}` };
  }
  const userProducts = await isUserProductSeller(mlToken).catch(() => false);
  let items;
  try {
    items = buildMlItems(payload, picMap, { userProducts });
  } catch (e) {
    return { channel: 'ml', status: 'error', detail: e.message };
  }
  // La descripción va en un recurso aparte (POST /items/{id}/description), no en el body del item.
  const descriptionText = payload.ml?.description?.plain_text || '';
  const created = [];
  try {
    for (const body of items) {
      const { externalId } = await publishMlUnit(body, mlToken, descriptionText);
      created.push(externalId);
    }
  } catch (e) {
    const partial = created.length ? ` (se crearon ${created.length} antes del error: ${created.join(', ')})` : '';
    return { channel: 'ml', status: 'error', detail: `${e.message}${partial}` };
  }
  const label = created.length > 1 ? `${created.length} publicaciones creadas: ${created.join(', ')}` : `Publicación ${created[0]} creada`;
  return { channel: 'ml', status: 'ok', detail: label };
}

/* ============================ Tienda Nube ============================ */

/**
 * Coacciona un decimal a string con 2 decimales (TN modela price/weight/dimensiones como STRING),
 * o undefined si no hay. Mandar número plano donde TN espera string se ignora o falla la validación.
 */
function tnDecimal(v) {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : undefined;
}

/** Normaliza una variante TN al formato de la API (price/weight/dimensiones como string, sin nulls). */
function normalizeTnVariant(v) {
  const out = { sku: v.sku };
  const price = tnDecimal(v.price);
  if (price != null) out.price = price;
  const promo = tnDecimal(v.promotional_price);
  if (promo != null) out.promotional_price = promo;
  if (v.stock != null) {
    out.stock_management = true;
    out.stock = v.stock;
  }
  // Peso (kg) y dimensiones (cm) van como STRING con 2 decimales.
  const weight = tnDecimal(v.weight);
  if (weight != null) out.weight = weight;
  const width = tnDecimal(v.width);
  if (width != null) out.width = width;
  const height = tnDecimal(v.height);
  if (height != null) out.height = height;
  const depth = tnDecimal(v.depth);
  if (depth != null) out.depth = depth;
  if (v.barcode) out.barcode = String(v.barcode);
  if (Array.isArray(v.values) && v.values.length) out.values = v.values;
  // Instagram Shopping / Google Shopping: campos de VARIANTE en la API de TN. Se cargan una vez en
  // "Datos generales" y aplican a todas las variantes (ver CLAUDE.md → sección de este cambio).
  if (v.mpn) out.mpn = String(v.mpn);
  if (v.age_group) out.age_group = v.age_group;
  if (v.gender) out.gender = v.gender;
  return out;
}

/**
 * Construye el/los producto(s) de TN según el modo de mapeo. NO incluye imágenes: en TN se suben
 * después de crear el producto (necesitan el product_id), salvo que se embeban por URL en el
 * propio POST de creación (ver publishTn / embedTnImages).
 */
/**
 * TN modela `description` (igual que `name`) como un objeto por idioma (`{es, pt?}`), no un
 * string plano — el front solo edita el `es` y manda ese objeto tal cual. Se le aplica
 * `plainTextToHtml` a CADA idioma presente.
 */
function tnDescription(description) {
  if (!description || typeof description !== 'object') return description;
  const out = {};
  for (const [lang, text] of Object.entries(description)) {
    if (text != null) out[lang] = plainTextToHtml(text);
  }
  return out;
}

export function buildTnProducts(payload) {
  const { tn: t, variants } = payload;
  const baseProduct = {
    name: t.name,
    description: tnDescription(t.description),
    handle: t.handle,
    // Nombres de los ejes que definen las variantes (ej. "Color", "Talle"), apareados por índice
    // con `values` de cada variante. Sin esto TN no sabe qué representa cada valor y el front
    // terminaba metiendo el nombre del eje dentro del valor ("Color: Rojo") para compensar.
    attributes: t.attributes,
    categories: t.categories,
    brand: t.brand,
    seo_title: t.seo_title,
    seo_description: t.seo_description,
    tags: t.tags,
    free_shipping: t.free_shipping,
    video_url: t.video_url,
    published: t.published
  };

  const hasVariants = Array.isArray(variants) && variants.length > 0;
  const tnVariants = Array.isArray(t.variants) ? t.variants : [];

  // Producto simple: inyecta precio/stock base en la variante única. Sin variantes no hay ejes,
  // así que tampoco `attributes` a nivel producto.
  if (!hasVariants) {
    const single = normalizeTnVariant({
      ...tnVariants[0],
      price: t.base_price,
      promotional_price: t.base_promo_price,
      stock: t.base_stock
    });
    const { attributes, ...productBase } = baseProduct;
    return [{ ...productBase, variants: [single] }];
  }

  if (t.mapping_mode === 'one_per_variant') {
    return tnVariants.map((v, i) => {
      const raw = variants[i] || {};
      const suffix = (raw.values || []).join(' ').trim();
      // Nombre propio de la variante si se cargó uno; si no, el automático (base + sufijo de valores).
      const ownName = raw.name && String(raw.name).trim();
      const es = ownName || (suffix ? `${t.name?.es ?? ''} ${suffix}`.trim() : t.name?.es);
      // El pt no tiene override propio: siempre lleva el sufijo automático, para que los N
      // productos no terminen compartiendo el mismo nombre en portugués.
      const pt = t.name?.pt ? (suffix ? `${t.name.pt} ${suffix}`.trim() : t.name.pt) : t.name?.pt;
      const name = { ...t.name, es, pt };
      // Un producto de una sola variante no necesita `values` (no hay otras variantes de las que
      // distinguirse) ni `attributes` a nivel producto (son cosas del mismo producto).
      const { values, ...single } = normalizeTnVariant(v);
      const { attributes, ...productBase } = baseProduct;
      return { ...productBase, name, handle: undefined, variants: [single] };
    });
  }

  // single_with_variants: un producto con todas las variantes.
  return [{ ...baseProduct, variants: tnVariants.map(normalizeTnVariant) }];
}

/**
 * Imágenes listas para embeber en el `POST /products` (`images:[{src,position}]`), o `null` si
 * falta la URL pública de alguna (imageStore sin Supabase configurado) — en ese caso se cae al
 * camino de subida por imagen (`uploadTnImages`).
 */
async function embedTnImages(tempIds) {
  if (!tempIds?.length) return [];
  const out = [];
  for (let i = 0; i < tempIds.length; i++) {
    const url = await getImageUrl(tempIds[i]);
    if (!url) return null;
    out.push({ src: url, position: i + 1 });
  }
  return out;
}

/** Arma tempId → id de imagen de TN a partir de las `images[]` que devuelve el POST de creación. */
function tnImageMapFromCreated(product, tempIds) {
  const map = new Map();
  const images = Array.isArray(product?.images)
    ? [...product.images].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    : [];
  tempIds.forEach((tempId, i) => {
    if (images[i]?.id != null) map.set(tempId, images[i].id);
  });
  return map;
}

/**
 * Verifica el orden final de las imágenes embebidas contra `GET .../images` y corrige con PUT las
 * que no hayan quedado en la posición pedida (TN no siempre honra el orden del POST). No frena la
 * publicación si la verificación falla: queda logueado, la portada más probable es igual la 1ª.
 */
async function reconcileTnImageOrder(tnToken, storeId, productId, tempIds, tnImageMap) {
  if (!tempIds.length) return tnImageMap; // nada que embeber ni que verificar
  try {
    const real = await tn.getProductImages(tnToken, storeId, productId);
    const positionOf = new Map((real || []).map((img) => [img.id, img.position]));
    for (let i = 0; i < tempIds.length; i++) {
      const wanted = i + 1;
      const tnImageId = tnImageMap.get(tempIds[i]);
      if (tnImageId == null) continue;
      if (positionOf.get(tnImageId) !== wanted) {
        try {
          await tn.updateProductImagePosition(tnToken, storeId, productId, tnImageId, wanted);
        } catch (e) {
          console.warn('[TN] no se pudo reordenar imagen embebida', tnImageId, e.message);
        }
      }
    }
  } catch (e) {
    console.warn('[TN] no se pudo verificar el orden final de imágenes', e.message);
  }
  return tnImageMap;
}

/**
 * Sube una lista concreta de imágenes (por id temporal) a un producto ya creado, SECUENCIALMENTE
 * y en el orden dado (`position` 1 = portada). TN no siempre honra el `position` del POST, así que
 * al final se hace una pasada de reconciliación con PUT para garantizar el orden/portada exactos.
 * Camino de respaldo cuando no hay URL pública para embeber en la creación (ver embedTnImages).
 * Devuelve el map id temporal → id de imagen de TN.
 */
async function uploadTnImages(tnToken, storeId, productId, tempIds) {
  const map = new Map();
  const uploaded = []; // { tnImageId, wanted, got } en el orden deseado
  let position = 1;
  for (const tempId of tempIds || []) {
    const img = await getImage(tempId);
    if (!img) continue;
    const wanted = position++;
    const created = await tn.createProductImage(tnToken, storeId, productId, {
      filename: img.filename,
      base64: img.buffer.toString('base64'),
      position: wanted
    });
    if (created?.id != null) {
      map.set(tempId, created.id);
      uploaded.push({ tnImageId: created.id, wanted, got: created.position });
    }
  }
  // Reconciliación: corrige las que TN no dejó en la posición pedida (garantiza la portada).
  for (const u of uploaded) {
    if (u.got !== u.wanted) {
      try {
        await tn.updateProductImagePosition(tnToken, storeId, productId, u.tnImageId, u.wanted);
      } catch (e) {
        console.warn('[TN] no se pudo reordenar imagen', u.tnImageId, e.message);
      }
    }
  }
  return map;
}

/** Asocia la imagen (la primera elegida) a cada variante creada (match por SKU). No frena si falla. */
async function assignTnVariantImages(tnToken, storeId, productId, createdVariants, tnImageMap, forVariants) {
  const skuToVarId = new Map((createdVariants || []).map((v) => [v.sku, v.id]));
  for (const variant of forVariants) {
    // En TN la variante referencia UNA imagen (image_id): usamos la primera de su selección.
    const tempId = variant?.tn?.image_ids?.[0];
    if (!tempId) continue;
    const tnImageId = tnImageMap.get(tempId);
    const varId = skuToVarId.get(variant?.sku);
    if (tnImageId && varId != null) {
      try {
        await tn.updateVariantImage(tnToken, storeId, productId, varId, tnImageId);
      } catch (e) {
        console.warn('[TN] no se pudo asociar imagen a variante', variant?.sku, e.message);
      }
    }
  }
}

/**
 * Arma la lista de unidades TN a publicar — `{ unitKey, body, uploadIds, forVariants }`, una por
 * producto, en el mismo orden que `buildTnProducts`. La usa tanto `publishTn` (todo de una) como
 * el worker en background (una unidad por vez, con progreso/idempotencia).
 *
 * `unitKey` (para el progreso y para que el reintento no duplique lo ya creado) es el SKU cuando
 * hay VARIOS productos (`one_per_variant`); con un solo producto (simple o `single_with_variants`,
 * que sea legacy o User Products) es `''` — esos casos son siempre UNA sola unidad atómica, igual
 * criterio que `mlUnitKey`.
 */
export function planTnUnits(payload) {
  const products = buildTnProducts(payload);
  const variants = payload.variants || [];
  const mode = payload.tn?.mapping_mode;
  const galleryIds = payload.tn?.image_ids || [];
  const gallerySet = new Set(galleryIds);
  return products.map((body, pIdx) => {
    let uploadIds; // fotos a subir a ESTE producto, en orden (position 1 = portada)
    let forVariants; // variantes cuyo image_id asociar
    if (mode === 'one_per_variant') {
      // Cada producto es una variante: su galería propia = SOLO las fotos asignadas a esa
      // variante, en el ORDEN QUE LA USUARIA ELIGIÓ PARA ESA VARIANTE (v.tn.image_ids, el que
      // arma variant-photos-dialog) — NO el orden de la galería general, que es de dónde salía
      // el bug de portada equivocada: filtrar la galería general preservaba el orden de la
      // galería, no el de la variante.
      const variant = variants[pIdx];
      uploadIds = (variant?.tn?.image_ids || []).filter((id) => gallerySet.has(id));
      forVariants = variant ? [{ ...variant, tn: { ...variant.tn, image_ids: uploadIds } }] : [];
    } else {
      // single_with_variants: una publicación con la galería compartida; una image_id por variante.
      uploadIds = galleryIds;
      forVariants = variants;
    }
    return { unitKey: products.length > 1 ? (body.variants?.[0]?.sku ?? '') : '', body, uploadIds, forVariants };
  });
}

/** Crea UN producto de TN (imágenes + asociación por variante incluidas) — la unidad mínima. */
export async function publishTnUnit(tnToken, storeId, unit) {
  const { body, uploadIds, forVariants } = unit;
  const embedded = await embedTnImages(uploadIds);
  const productBody = embedded ? { ...body, images: embedded } : body;
  const product = await tn.createProduct(tnToken, storeId, productBody);
  const productId = product?.id;
  if (productId == null) return { externalId: null, detail: 'TN no devolvió id de producto' };
  const tnImageMap = embedded
    ? await reconcileTnImageOrder(tnToken, storeId, productId, uploadIds, tnImageMapFromCreated(product, uploadIds))
    : await uploadTnImages(tnToken, storeId, productId, uploadIds);
  await assignTnVariantImages(tnToken, storeId, productId, product?.variants, tnImageMap, forVariants);
  return { externalId: productId, detail: `Producto #${productId} creado` };
}

async function publishTn(payload, tnToken, storeId) {
  if (!tnToken || !storeId) return { channel: 'tn', status: 'error', detail: 'No conectado a Tienda Nube' };
  let units;
  try {
    units = planTnUnits(payload);
  } catch (e) {
    return { channel: 'tn', status: 'error', detail: e.message };
  }
  const created = [];
  try {
    for (const unit of units) {
      const { externalId } = await publishTnUnit(tnToken, storeId, unit);
      created.push(externalId);
    }
  } catch (e) {
    const partial = created.length ? ` (se crearon ${created.length} antes del error: ${created.join(', ')})` : '';
    return { channel: 'tn', status: 'error', detail: `${e.message}${partial}` };
  }
  const label = created.length > 1 ? `${created.length} productos creados: ${created.join(', ')}` : `Producto #${created[0]} creado`;
  return { channel: 'tn', status: 'ok', detail: label };
}

/* ============================ Orquestación ============================ */

export async function publishProduct(payload, { mlToken, tnToken, storeId, channels }) {
  // `channels` (opcional) limita a qué canales publicar (para reintentar solo el que falló).
  const doMl = !channels || channels.includes('ml');
  const doTn = !channels || channels.includes('tn');
  const [mlRes, tnRes] = await Promise.all([
    doMl ? publishMl(payload, mlToken) : null,
    doTn ? publishTn(payload, tnToken, storeId) : null
  ]);
  return { results: [mlRes, tnRes].filter(Boolean) };
}
