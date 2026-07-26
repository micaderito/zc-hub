/**
 * Fan-out de creación de producto a ambos canales (POST /api/products).
 *
 * Recibe el payload que arma el front (crear-producto → buildPayloads) y construye los bodies
 * reales de cada API según el modo de mapeo (Opción B):
 *   - single_with_variants → 1 publicación/producto con todas las variantes,
 *   - one_per_variant      → 1 publicación/producto por cada variante,
 *   - sin variantes        → 1 publicación/producto simple (usa el precio/stock base).
 *
 * IMÁGENES: viajan en el payload como IDs temporales (subidos antes a POST /api/products/images,
 * guardados en imageStore). Acá se suben a cada canal durante el publish:
 *   - ML: se suben todas a /pictures/items/upload (map tempId→picture_id) y se arman `pictures[]`
 *     (orden = portada) y `picture_ids` por variación, todo en el mismo POST /items.
 *   - TN: se crea el producto, luego se suben las imágenes (base64, `position` = orden, 1 = portada)
 *     y por último se asocia `image_id` a cada variante (PUT). Es multi-paso.
 * Las imágenes son independientes por canal (`ml.image_ids` vs `tn.image_ids`).
 *
 * Cada canal se publica de forma independiente: si uno falla, el otro puede haber salido OK
 * (se reporta status por canal). No hay rollback: crear en ML y en TN son operaciones separadas.
 */
import * as ml from '../lib/mercadolibre.js';
import * as tn from '../lib/tiendanube.js';
import { getImage } from './imageStore.js';

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

/** Atributos de categoría SIN SELLER_SKU (en variaciones el SKU va por variación). */
function categoryAttrs(attributes) {
  return (attributes || []).filter((a) => String(a.id).toUpperCase() !== 'SELLER_SKU');
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

/** Combinaciones de atributos de una variación a partir de los ejes (ej. [{name:'Color', value_name:'Negro'}]). */
function attributeCombinations(axes, values) {
  return (axes || []).map((axis, i) => ({
    name: axis.name,
    value_name: values?.[i] ?? ''
  }));
}

/** Mapea una lista de ids temporales a picture_ids de ML (descarta los que no se resolvieron). */
function toMlPictures(tempIds, picMap) {
  return (tempIds || [])
    .map((id) => picMap.get(id))
    .filter(Boolean)
    .map((id) => ({ id }));
}

/**
 * Construye la(s) publicación(es) de ML según el modo de mapeo.
 * `picMap` mapea id temporal → picture_id ya subido a ML (para `pictures[]` y `picture_ids`).
 */
export function buildMlItems(payload, picMap = new Map()) {
  const { ml: m, axes, variants, common } = payload;
  const galleryPics = toMlPictures(m.image_ids, picMap);
  // Peso/dimensiones del paquete (ME2) van como atributos del ítem.
  const pkgAttrs = packageAttributes(common);
  const base = {
    title: m.title,
    category_id: m.category_id,
    currency_id: m.currency_id,
    buying_mode: m.buying_mode,
    condition: m.condition,
    listing_type_id: m.listing_type_id,
    sale_terms: m.sale_terms,
    pictures: galleryPics,
    shipping: mlShipping(m.shipping)
  };

  const hasVariants = Array.isArray(variants) && variants.length > 0;

  // Producto simple: precio/stock base + SELLER_SKU + paquete al nivel del item.
  if (!hasVariants) {
    return [{ ...base, price: m.base_price, available_quantity: m.base_stock, attributes: [...(m.attributes || []), ...pkgAttrs] }];
  }

  if (m.mapping_mode === 'one_per_variant') {
    return variants.map((v) => {
      const own = toMlPictures(v.ml?.picture_ids, picMap);
      return {
        ...base,
        title: [m.title, ...(v.values || [])].filter(Boolean).join(' ').trim(),
        price: v.ml?.price,
        available_quantity: v.ml?.stock,
        attributes: [...categoryAttrs(m.attributes), ...pkgAttrs, { id: 'SELLER_SKU', value_name: v.sku }],
        pictures: own.length ? own : galleryPics
      };
    });
  }

  // single_with_variants: una publicación con variations[] (cada una referencia su subconjunto de fotos).
  return [
    {
      ...base,
      attributes: [...categoryAttrs(m.attributes), ...pkgAttrs],
      variations: variants.map((v) => {
        const picIds = (v.ml?.picture_ids || []).map((id) => picMap.get(id)).filter(Boolean);
        const variation = {
          attribute_combinations: attributeCombinations(axes, v.values),
          price: v.ml?.price,
          available_quantity: v.ml?.stock,
          attributes: [{ id: 'SELLER_SKU', value_name: v.sku }]
        };
        if (picIds.length) variation.picture_ids = picIds;
        return variation;
      })
    }
  ];
}

/** Sube todas las imágenes de ML del payload y devuelve el map id temporal → picture_id. */
async function uploadMlImages(payload, mlToken) {
  const map = new Map();
  const ids = new Set(payload.ml?.image_ids || []);
  // Incluir también las asignadas por variante (por si no están en la galería general).
  for (const v of payload.variants || []) for (const id of v.ml?.picture_ids || []) ids.add(id);
  for (const tempId of ids) {
    const img = getImage(tempId);
    if (!img) continue;
    const pictureId = await ml.uploadPicture(mlToken, img.buffer, img.filename, img.mime);
    map.set(tempId, pictureId);
  }
  return map;
}

async function publishMl(payload, mlToken) {
  if (!mlToken) return { channel: 'ml', status: 'error', detail: 'No conectado a Mercado Libre' };
  let picMap;
  try {
    picMap = await uploadMlImages(payload, mlToken);
  } catch (e) {
    return { channel: 'ml', status: 'error', detail: `Error subiendo imágenes a ML: ${e.message}` };
  }
  let items;
  try {
    items = buildMlItems(payload, picMap);
  } catch (e) {
    return { channel: 'ml', status: 'error', detail: e.message };
  }
  // La descripción va en un recurso aparte (POST /items/{id}/description), no en el body del item.
  const descriptionText = payload.ml?.description?.plain_text || '';
  const created = [];
  try {
    for (const body of items) {
      const item = await ml.createItem(mlToken, body);
      created.push(item?.id);
      if (item?.id && descriptionText.trim()) {
        await ml.setItemDescription(mlToken, item.id, descriptionText);
      }
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
  return out;
}

/**
 * Construye el/los producto(s) de TN según el modo de mapeo. NO incluye imágenes: en TN se suben
 * después de crear el producto (necesitan el product_id). Devuelve un array de bodies.
 */
export function buildTnProducts(payload) {
  const { tn: t, variants } = payload;
  const baseProduct = {
    name: t.name,
    description: t.description,
    handle: t.handle,
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

  // Producto simple: inyecta precio/stock base en la variante única.
  if (!hasVariants) {
    const single = normalizeTnVariant({
      ...tnVariants[0],
      price: t.base_price,
      promotional_price: t.base_promo_price,
      stock: t.base_stock
    });
    return [{ ...baseProduct, variants: [single] }];
  }

  if (t.mapping_mode === 'one_per_variant') {
    return tnVariants.map((v, i) => {
      const suffix = (variants[i]?.values || []).join(' ').trim();
      const name = suffix ? { ...t.name, es: `${t.name?.es ?? ''} ${suffix}`.trim() } : t.name;
      const { values, ...single } = normalizeTnVariant(v);
      return { ...baseProduct, name, handle: undefined, variants: [single] };
    });
  }

  // single_with_variants: un producto con todas las variantes.
  return [{ ...baseProduct, variants: tnVariants.map(normalizeTnVariant) }];
}

/**
 * Sube una lista concreta de imágenes (por id temporal) a un producto ya creado, SECUENCIALMENTE
 * y en el orden dado (`position` 1 = portada). TN no siempre honra el `position` del POST, así que
 * al final se hace una pasada de reconciliación con PUT para garantizar el orden/portada exactos.
 * Devuelve el map id temporal → id de imagen de TN.
 */
async function uploadTnImages(tnToken, storeId, productId, tempIds) {
  const map = new Map();
  const uploaded = []; // { tnImageId, wanted, got } en el orden deseado
  let position = 1;
  for (const tempId of tempIds || []) {
    const img = getImage(tempId);
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

async function publishTn(payload, tnToken, storeId) {
  if (!tnToken || !storeId) return { channel: 'tn', status: 'error', detail: 'No conectado a Tienda Nube' };
  let products;
  try {
    products = buildTnProducts(payload);
  } catch (e) {
    return { channel: 'tn', status: 'error', detail: e.message };
  }
  const variants = payload.variants || [];
  const mode = payload.tn?.mapping_mode;
  const galleryIds = payload.tn?.image_ids || [];
  const created = [];
  try {
    for (let pIdx = 0; pIdx < products.length; pIdx++) {
      const product = await tn.createProduct(tnToken, storeId, products[pIdx]);
      created.push(product?.id);
      const productId = product?.id;
      if (productId == null) continue;

      let uploadIds; // fotos a subir a ESTE producto, en orden (position 1 = portada)
      let forVariants; // variantes cuyo image_id asociar
      if (mode === 'one_per_variant') {
        // Cada producto es una variante: su galería propia = SOLO las fotos asignadas a esa variante,
        // en el ORDEN de la galería general (que el usuario controla con drag; la 1ª es la portada).
        const variant = variants[pIdx];
        const assigned = new Set(variant?.tn?.image_ids || []);
        uploadIds = galleryIds.filter((id) => assigned.has(id));
        // La variante (producto simple) referencia la portada = primera foto en orden de galería.
        forVariants = variant ? [{ ...variant, tn: { ...variant.tn, image_ids: uploadIds } }] : [];
      } else {
        // single_with_variants: una publicación con la galería compartida; una image_id por variante.
        uploadIds = galleryIds;
        forVariants = variants;
      }
      const tnImageMap = await uploadTnImages(tnToken, storeId, productId, uploadIds);
      await assignTnVariantImages(tnToken, storeId, productId, product?.variants, tnImageMap, forVariants);
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
