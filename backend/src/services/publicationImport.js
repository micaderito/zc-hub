/**
 * Importar un producto del hub al formulario de edición (Publicaciones → Editar).
 *
 * Lee EN VIVO las publicaciones del grupo (ML: ítem + descripción; TN: producto) y las convierte en
 * un `ProductDraft` — el mismo shape que arma Crear producto en el front
 * (frontend/.../crear-producto/product-draft.model.ts) — para editarlas con ese mismo formulario.
 * Ver docs/plans/2026-10-12-publicaciones-mapeo-edicion-design.md (Fase 2).
 *
 * Devuelve además:
 * - `baseline`: copia del draft tal como se importó. Guardar compara contra esto y manda solo lo
 *   que cambió (publicationDiff.js), así un campo que no se tocó nunca pisa lo que haya en el canal.
 * - `refs`: los ids externos (ítems/variaciones de ML, productos/variantes de TN) y cuándo se
 *   modificó cada publicación por última vez (para avisar si alguien la cambió mientras se editaba).
 * - `locks`: lo que ML no deja cambiar, con el motivo (se muestra con candado en el form).
 * - `notes`: avisos de la importación (stock distinto entre canales, variantes sin par…).
 *
 * `buildEditDraft` es puro (testeable sin red); `importHubProduct` hace el I/O.
 */
import crypto from 'node:crypto';
import { tokens, getMlToken } from '../store.js';
import * as ml from '../lib/mercadolibre.js';
import * as tn from '../lib/tiendanube.js';
import { getCatalogRows } from './conflictsService.js';
import { buildHubProducts } from './hubProductsService.js';

/** Atributos de ML que el form maneja aparte (SKU, código de barras, paquete, condición): no van a "Características". */
const ML_ATTRS_HANDLED_ELSEWHERE = new Set([
  'SELLER_SKU', 'GTIN', 'ITEM_CONDITION',
  'SELLER_PACKAGE_LENGTH', 'SELLER_PACKAGE_WIDTH', 'SELLER_PACKAGE_HEIGHT', 'SELLER_PACKAGE_WEIGHT',
]);

const up = (s) => String(s || '').toUpperCase();
const attrOf = (attrs, id) => (attrs || []).find((a) => up(a.id || a.name) === id) || null;
const attrText = (attrs, id) => {
  const a = attrOf(attrs, id);
  return a ? String(a.value_name ?? a.value ?? '').trim() : '';
};
const tnText = (v) => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return String(v.es ?? v.pt ?? Object.values(v).find((x) => typeof x === 'string') ?? '');
};
const own = (value) => ({ inherited: false, value: value ?? '' });
const inheritedField = (value = '') => ({ inherited: true, value });
const httpsUrl = (u) => (u && u.startsWith('http:') ? u.replace(/^http:/, 'https:') : u || '');

/** SKU de un ítem o variación de ML (SELLER_SKU; `seller_custom_field` es otra cosa, ver CLAUDE.md). */
function mlSku(obj) {
  return (obj?.seller_sku || attrText(obj?.attributes, 'SELLER_SKU') || '').trim();
}

/** Número de un atributo con unidad de ML ("20 cm", value_struct { number, unit }) en la unidad pedida. */
function mlNumber(attrs, id, unit) {
  const a = attrOf(attrs, id);
  if (!a) return null;
  let n = a.value_struct?.number;
  let u = a.value_struct?.unit;
  if (n == null) {
    const m = String(a.value_name || '').replace(',', '.').match(/([\d.]+)\s*([a-zA-Z"]*)/);
    if (!m) return null;
    n = Number(m[1]);
    u = m[2] || unit;
  }
  if (!Number.isFinite(Number(n))) return null;
  n = Number(n);
  if (unit === 'g' && u === 'kg') n *= 1000;
  if (unit === 'cm' && u === 'mm') n /= 10;
  return Math.round(n * 100) / 100;
}

/** Prefijo común por palabras ("A4 Semi Rigido Iconic", "A4 Semi Rigido Lunitas" → "A4 Semi Rigido"). */
function commonWordPrefix(names) {
  const lists = names.filter(Boolean).map((n) => n.trim().split(/\s+/));
  if (!lists.length) return '';
  const out = [];
  for (let i = 0; i < lists[0].length; i++) {
    const w = lists[0][i];
    if (lists.every((l) => l[i] && l[i].toLowerCase() === w.toLowerCase())) out.push(w);
    else break;
  }
  return out.join(' ').replace(/[\s\-–·|,]+$/, '');
}

function mlImage(pic) {
  const url = httpsUrl(pic.secure_url || pic.url);
  return { id: `ml-${pic.id}`, uid: `ml-${pic.id}`, name: `Foto ML ${pic.id}`, previewUrl: url, remote: { channel: 'ml', id: String(pic.id), url } };
}
function tnImage(img) {
  const url = httpsUrl(img.src || img.url);
  return { id: `tn-${img.id}`, uid: `tn-${img.id}`, name: `Foto TN ${img.id}`, previewUrl: url, remote: { channel: 'tn', id: String(img.id), url } };
}

/** Galería sin repetidos, en el orden en que aparecen (una foto puede estar en varios ítems de una ficha). */
function uniqueImages(list) {
  const seen = new Set();
  return list.filter((img) => (seen.has(img.id) ? false : (seen.add(img.id), true)));
}

/**
 * Ejes de variante de ML: los `attribute_combinations` (legacy) o los atributos que cambian entre
 * ítems de una ficha (User Products). En el segundo caso no alcanza con "cambia entre ítems": una
 * característica cargada en unos y vacía en otros ("Es lavable: No") también cambia y no es un eje.
 * Por eso un valor vacío no cuenta, el atributo tiene que estar cargado en todos los ítems y, si se
 * conocen los atributos de variación de la categoría (`allow_variations`), solo cuentan esos.
 */
function mlAxes(items, variationAttrIds = null) {
  const legacy = items.find((it) => it.variations?.length);
  if (legacy) {
    return (legacy.variations[0].attribute_combinations || []).map((c) => ({ name: c.name || c.id, mlAttributeId: c.id || undefined }));
  }
  if (items.length < 2) return [];
  const ids = new Map();
  for (const it of items) {
    for (const a of it.attributes || []) {
      const id = up(a.id);
      const value = String(a.value_name ?? '').trim();
      if (!id || ML_ATTRS_HANDLED_ELSEWHERE.has(id) || !value || a.value_id === '-1') continue;
      if (!ids.has(id)) ids.set(id, { name: a.name || id, values: new Set(), items: new Set() });
      ids.get(id).values.add(value.toLowerCase());
      ids.get(id).items.add(it.id);
    }
  }
  const candidates = [...ids.entries()].filter(([, v]) => v.values.size > 1 && v.items.size === items.length);
  const allowed = variationAttrIds ? new Set([...variationAttrIds].map(up)) : null;
  const ofCategory = allowed ? candidates.filter(([id]) => allowed.has(id)) : candidates;
  // Si la categoría no marca ninguno de los que cambian, se usa lo que cambia (mejor que ningún eje).
  return (ofCategory.length ? ofCategory : candidates).map(([id, v]) => ({ name: v.name, mlAttributeId: id }));
}

/**
 * Convierte publicaciones reales en un ProductDraft para el form.
 * @param {{ mlItems: object[], mlDescriptions?: Record<string,string>, tnProducts: object[], categoryName?: string }} input
 */
export function buildEditDraft({ mlItems = [], mlDescriptions = {}, tnProducts = [], categoryName = '', variationAttrIds = null }) {
  const notes = [];
  const hasMl = mlItems.length > 0;
  const hasTn = tnProducts.length > 0;
  const mlMode = mlItems.length > 1 ? 'one_per_variant' : 'single_with_variants';
  const tnMode = tnProducts.length > 1 ? 'one_per_variant' : 'single_with_variants';

  // ── Unidades de cada canal (una por variante) ──
  const mlUnits = [];
  for (const it of mlItems) {
    if (it.variations?.length) {
      for (const v of it.variations) {
        mlUnits.push({
          itemId: it.id, variationId: String(v.id), sku: mlSku(v) || mlSku(it), price: v.price ?? it.price, stock: v.available_quantity ?? 0,
          soldQuantity: Number(v.sold_quantity) || 0, values: (v.attribute_combinations || []).map((c) => String(c.value_name ?? '')),
          pictureIds: (v.picture_ids || []).map((id) => `ml-${id}`), gtin: attrText(v.attributes, 'GTIN'), title: it.title,
        });
      }
    } else {
      mlUnits.push({
        itemId: it.id, variationId: null, sku: mlSku(it), price: it.price, stock: it.available_quantity ?? 0,
        soldQuantity: Number(it.sold_quantity) || 0, values: null,
        pictureIds: (it.pictures || []).map((p) => `ml-${p.id}`), gtin: attrText(it.attributes, 'GTIN'), title: it.title,
      });
    }
  }
  const tnUnits = [];
  for (const p of tnProducts) {
    const productImages = (p.images || []).map((img) => `tn-${img.id}`);
    for (const v of p.variants || []) {
      tnUnits.push({
        productId: p.id, variantId: v.id, sku: String(v.sku || '').trim(), price: v.price != null ? Number(v.price) : null,
        stock: v.stock ?? null, values: (v.values || []).map(tnText),
        imageIds: tnProducts.length > 1 ? productImages : v.image_id != null ? [`tn-${v.image_id}`] : [],
        barcode: v.barcode || '', name: tnText(p.name), variant: v,
      });
    }
  }

  // ── Ejes ──
  let axes = mlAxes(mlItems, variationAttrIds);
  if (!axes.length && tnProducts.length === 1) {
    axes = (tnProducts[0].attributes || []).map((a) => ({ name: tnText(a) })).filter((a) => a.name);
  }
  const upAxisValues = (unit) => {
    const it = mlItems.find((x) => x.id === unit.itemId);
    return axes.map((ax) => attrText(it?.attributes, up(ax.mlAttributeId)));
  };

  // ── Producto simple (una sola cosa, sin variantes) ──
  const simple = mlUnits.length <= 1 && tnUnits.length <= 1 && !axes.length;

  // ── Unir las variantes por SKU ──
  const pairs = [];
  const usedTn = new Set();
  for (const m of mlUnits) {
    const t = m.sku ? tnUnits.find((x) => !usedTn.has(x) && x.sku === m.sku) : simple ? tnUnits.find((x) => !usedTn.has(x)) : null;
    if (t) usedTn.add(t);
    pairs.push({ m, t: t || null });
  }
  for (const t of tnUnits) if (!usedTn.has(t)) pairs.push({ m: null, t });

  const mlNames = mlItems.map((it) => it.title);
  const tnNames = tnProducts.map((p) => tnText(p.name));
  let baseName;
  if (tnProducts.length === 1) baseName = tnNames[0];
  else if (mlItems.length === 1) baseName = mlNames[0];
  else baseName = mlItems[0]?.family_name || commonWordPrefix([...mlNames, ...tnNames]) || mlNames[0] || tnNames[0] || '';

  // Valor de cada eje para una variante: de ML si está (legacy o ficha), si no de TN; un producto
  // de TN "uno por variante" sin valores usa lo que su nombre agrega al nombre común.
  const valuesFor = ({ m, t }) => {
    if (m?.values) return m.values;
    if (m && axes.some((ax) => ax.mlAttributeId) && mlItems.length > 1) {
      const fromMl = upAxisValues(m);
      if (fromMl.some(Boolean)) return fromMl;
    }
    if (t?.values?.length) return t.values;
    if (t && axes.length === 1) return [t.name.replace(baseName, '').replace(/^[\s\-–·|]+/, '').trim() || t.sku];
    return axes.map(() => '');
  };
  if (!axes.length && pairs.length > 1) {
    // Varias variantes sin un eje que las nombre (ej. TN uno por variante, ML sin variaciones):
    // eje genérico, con lo que cada nombre agrega al nombre común.
    axes = [{ name: 'Modelo' }];
  }

  const variants = [];
  const refsVariants = {};
  let stockMismatch = 0;
  if (!simple) {
    pairs.forEach((pair, i) => {
      const { m, t } = pair;
      const id = `v${i + 1}`;
      const values = valuesFor(pair);
      if (m && t && Number(m.stock) !== Number(t.stock)) stockMismatch++;
      const label = values.filter(Boolean).join(' ') || m?.sku || t?.sku || id;
      if (!m && hasMl) notes.push(`"${label}" está en Tienda Nube pero no en Mercado Libre.`);
      if (!t && hasTn) notes.push(`"${label}" está en Mercado Libre pero no en Tienda Nube.`);
      variants.push({
        id,
        sku: m?.sku || t?.sku || '',
        values,
        stock: m ? Number(m.stock) : t ? Number(t.stock) : null,
        barcode: t?.barcode || m?.gtin || '',
        ml: { price: m ? Number(m.price) : null, pictureIds: m?.pictureIds || [] },
        tn: { price: t?.price ?? null, imageIds: t?.imageIds || [] },
        titles: {
          ml: mlMode === 'one_per_variant' && m ? own(m.title) : inheritedField(''),
          tn: tnMode === 'one_per_variant' && t ? own(t.name) : inheritedField(''),
        },
      });
      refsVariants[id] = {
        ml: m ? { itemId: m.itemId, variationId: m.variationId, soldQuantity: m.soldQuantity } : null,
        tn: t ? { productId: t.productId, variantId: t.variantId } : null,
      };
    });
  }
  if (stockMismatch) {
    notes.push(`${stockMismatch === 1 ? 'Una variante tenía' : `${stockMismatch} variantes tenían`} stock distinto en ML y en TN: quedó el de Mercado Libre. Si lo guardás, se iguala en los dos.`);
  }

  // ── Datos comunes ──
  const firstMl = mlItems[0] || null;
  const firstTnVariant = tnProducts[0]?.variants?.[0] || null;
  const tnDim = (k) => (firstTnVariant?.[k] != null && firstTnVariant[k] !== '' ? Number(firstTnVariant[k]) : null);
  const single = simple ? pairs[0] || { m: null, t: null } : null;
  const common = {
    baseName,
    sku: simple ? single.m?.sku || single.t?.sku || '' : '',
    brand: attrText(firstMl?.attributes, 'BRAND') || tnProducts[0]?.brand || '',
    barcode: simple ? single.t?.barcode || single.m?.gtin || '' : '',
    condition: firstMl?.condition === 'used' ? 'used' : 'new',
    weightG: mlNumber(firstMl?.attributes, 'SELLER_PACKAGE_WEIGHT', 'g') ?? (tnDim('weight') != null ? Math.round(tnDim('weight') * 1000) : null),
    // TN guarda el producto PARADO (Alto = lado largo, Profundidad = grosor): se deshace la rotación de tnDims.
    lengthCm: mlNumber(firstMl?.attributes, 'SELLER_PACKAGE_LENGTH', 'cm') ?? tnDim('height'),
    widthCm: mlNumber(firstMl?.attributes, 'SELLER_PACKAGE_WIDTH', 'cm') ?? tnDim('width'),
    heightCm: mlNumber(firstMl?.attributes, 'SELLER_PACKAGE_HEIGHT', 'cm') ?? tnDim('depth'),
    baseStock: simple ? Number(single.m?.stock ?? single.t?.stock ?? 0) : null,
    mpn: firstTnVariant?.mpn || '',
    ageGroup: firstTnVariant?.age_group || 'adult',
    gender: firstTnVariant?.gender || 'unisex',
  };
  if (simple && single.m && single.t && Number(single.m.stock) !== Number(single.t.stock)) {
    notes.push('El stock era distinto en ML y en TN: quedó el de Mercado Libre. Si lo guardás, se iguala en los dos.');
  }

  // ── Mercado Libre ──
  const axisAttrIds = new Set(axes.map((a) => up(a.mlAttributeId)).filter(Boolean));
  const saleTerm = (id) => (firstMl?.sale_terms || []).find((s) => s.id === id)?.value_name || '';
  const mlDesc = firstMl ? mlDescriptions[firstMl.id] ?? '' : '';
  const mlListing = {
    mappingMode: mlMode,
    title: firstMl && mlMode === 'single_with_variants' && firstMl.title !== baseName ? own(firstMl.title) : inheritedField(''),
    categoryId: firstMl?.category_id || '',
    categoryName: categoryName || '',
    listingType: ['gold_special', 'gold_pro', 'free'].includes(firstMl?.listing_type_id) ? firstMl.listing_type_id : 'gold_special',
    currency: firstMl?.currency_id || 'ARS',
    warrantyType: saleTerm('WARRANTY_TYPE') || 'Sin garantía',
    warrantyTime: saleTerm('WARRANTY_TIME'),
    shippingMode: firstMl?.shipping?.mode === 'custom' ? 'custom' : 'me2',
    freeShipping: !!firstMl?.shipping?.free_shipping,
    localPickup: !!firstMl?.shipping?.local_pick_up,
    description: own(mlDesc),
    attributes: (firstMl?.attributes || [])
      .filter((a) => a.id && !ML_ATTRS_HANDLED_ELSEWHERE.has(up(a.id)) && !axisAttrIds.has(up(a.id)))
      .map((a) => {
        // Multivalor (ej. "Grosor del trazo"): todos sus valores separados por coma, como los carga
        // ML; `value_name` solo trae el primero y el `value_id` es de ese ítem.
        const multi = (a.values || []).length > 1;
        return {
          id: a.id,
          name: a.name || a.id,
          value: a.value_id === '-1' ? '' : multi ? a.values.map((x) => x.name).filter(Boolean).join(',') : String(a.value_name ?? ''),
          valueId: !multi && a.value_id && a.value_id !== '-1' ? String(a.value_id) : undefined,
          required: false,
          inherited: up(a.id) === 'BRAND',
          notApplicable: a.value_id === '-1' || undefined,
        };
      }),
    images: uniqueImages(mlItems.flatMap((it) => (it.pictures || []).map(mlImage))),
    basePrice: simple && single.m ? Number(single.m.price) : null,
  };

  // ── Tienda Nube ──
  const tn0 = tnProducts[0] || null;
  const tnName = tn0 ? tnText(tn0.name) : '';
  const tnListing = {
    mappingMode: tnMode,
    nameEs: tn0 && tnMode === 'single_with_variants' && tnName !== baseName ? own(tnName) : inheritedField(''),
    namePt: tn0 ? String(tn0.name?.pt || '') : '',
    handle: tn0 ? tnText(tn0.handle) : '',
    categories: (tn0?.categories || []).map((c) => Number(c.id ?? c)).filter(Number.isFinite),
    seoTitle: tn0 ? tnText(tn0.seo_title) : '',
    seoDescription: tn0 ? tnText(tn0.seo_description) : '',
    tags: tn0?.tags || '',
    videoUrl: tn0?.video_url || '',
    freeShipping: !!tn0?.free_shipping,
    description: own(tn0 ? tnText(tn0.description) : ''),
    images: uniqueImages(tnProducts.flatMap((p) => (p.images || []).map(tnImage))),
    basePrice: simple && single.t ? single.t.price : null,
  };

  const draft = {
    common,
    axes,
    variants,
    ml: mlListing,
    tn: tnListing,
    cost: { mode: 'bulk', bulkPrice: null, bulkQty: null, discount1: 25, discount2: 5, unitCost: null, marginPct: 100 },
    alert: { enabled: false, threshold: 3, packMode: 'none', packId: null, newPack: { name: '', unitCount: 8, mode: 'assorted', sku: '' } },
  };

  // ── Lo que ML no deja cambiar ──
  const sold = mlItems.reduce((a, it) => a + (Number(it.sold_quantity) || 0), 0);
  const isUp = mlItems.some((it) => !it.variations?.length && it.user_product_id);
  const isFamily = isUp && mlItems.length > 1;
  const locks = {
    mappingMode: 'Cómo está armado cada canal (una publicación con variantes o una por variante) no se cambia desde acá: implicaría volver a publicar.',
    mlCategory: 'La categoría de una publicación existente no se cambia desde acá: implicaría volver a publicar.',
  };
  if (hasMl && sold > 0) {
    locks.mlTitle = isFamily
      ? `En las publicaciones agrupadas en una ficha el título lo arma ML, y con ventas (${sold}) no se puede cambiar el nombre de la ficha.`
      : `ML no deja cambiar el título de una publicación con ventas (${sold}). El nombre en Tienda Nube sí se puede cambiar.`;
    locks.condition = `ML no deja cambiar la condición (nuevo/usado) de una publicación con ventas (${sold}).`;
  } else if (isFamily) {
    locks.mlTitle = 'En las publicaciones agrupadas en una ficha el título lo arma ML a partir del nombre y las características.';
  } else if (isUp) {
    locks.mlTitle = 'En las publicaciones del modelo nuevo de ML (User Products) el título lo arma ML a partir del nombre y las características.';
  }
  if (!hasMl) notes.push('Este producto no está publicado en Mercado Libre: lo que cargues en esa sección no se guarda.');
  if (!hasTn) notes.push('Este producto no está publicado en Tienda Nube: lo que cargues en esa sección no se guarda.');

  const refs = {
    channels: { ml: hasMl, tn: hasTn },
    simple,
    base: simple
      ? {
          ml: single.m ? { itemId: single.m.itemId, variationId: single.m.variationId, soldQuantity: single.m.soldQuantity } : null,
          tn: single.t ? { productId: single.t.productId, variantId: single.t.variantId } : null,
        }
      : null,
    ml: {
      items: mlItems.map((it) => ({
        itemId: it.id,
        format: it.variations?.length ? 'legacy' : it.user_product_id ? 'up' : 'simple',
        userProductId: it.user_product_id || null,
        familyName: it.family_name || null,
        soldQuantity: Number(it.sold_quantity) || 0,
        status: it.status || null,
        lastUpdated: it.last_updated || null,
        fingerprint: mlFingerprint(it),
        title: it.title,
        // Cómo estaba ESTA publicación: el form muestra lo de la primera, y un cambio común solo va
        // a las que tenían ese mismo valor (publicationDiff.js, `spread`).
        current: {
          description: mlDescriptions[it.id] ?? '',
          freeShipping: !!it.shipping?.free_shipping,
          localPickup: !!it.shipping?.local_pick_up,
          warrantyType: (it.sale_terms || []).find((t) => t.id === 'WARRANTY_TYPE')?.value_name || 'Sin garantía',
          warrantyTime: (it.sale_terms || []).find((t) => t.id === 'WARRANTY_TIME')?.value_name || '',
          listingType: ['gold_special', 'gold_pro', 'free'].includes(it.listing_type_id) ? it.listing_type_id : 'gold_special',
        },
      })),
    },
    tn: {
      products: tnProducts.map((p) => ({
        productId: p.id,
        updatedAt: p.updated_at || null,
        fingerprint: tnFingerprint(p),
        name: tnText(p.name),
        current: {
          name: tnText(p.name),
          description: tnText(p.description),
          categories: (p.categories || []).map((c) => Number(c.id ?? c)).filter(Number.isFinite),
          brand: p.brand || '',
          seoTitle: tnText(p.seo_title),
          seoDescription: tnText(p.seo_description),
          tags: p.tags || '',
          videoUrl: p.video_url || '',
          freeShipping: !!p.free_shipping,
          handle: tnText(p.handle),
        },
      })),
    },
    variants: refsVariants,
  };

  return { draft, baseline: JSON.parse(JSON.stringify(draft)), refs, locks, notes };
}

/**
 * Lee en vivo las publicaciones de un producto del hub y arma la edición. Tira con `status` 404 si
 * el grupo no existe y 409/502 si un canal no contesta (no se arma una edición con datos a medias).
 */
export async function importHubProduct(groupKey) {
  const catalog = await getCatalogRows();
  const group = buildHubProducts(catalog).find((g) => g.key === groupKey);
  if (!group) throw Object.assign(new Error('No encontramos ese producto. Volvé a la lista y abrilo de nuevo.'), { status: 404 });

  const mlItems = [];
  const mlDescriptions = {};
  let categoryName = '';
  let variationAttrIds = null;
  if (group.ml.length) {
    const token = await getMlToken();
    if (!token) throw Object.assign(new Error('Mercado Libre no está conectado.'), { status: 409 });
    for (const pub of group.ml) {
      const { item, status } = await ml.getItemOrStatus(token, pub.itemId);
      if (!item) {
        if (status === 404) continue; // la publicación ya no existe: se edita lo que queda
        throw Object.assign(new Error(`Mercado Libre no devolvió la publicación ${pub.itemId} (HTTP ${status}). Probá de nuevo en un rato.`), { status: 502 });
      }
      mlItems.push(item);
      const desc = await ml.getItemDescription(token, pub.itemId);
      if (desc === null) throw Object.assign(new Error(`No pudimos leer la descripción de ${pub.itemId} en Mercado Libre. Probá de nuevo en un rato.`), { status: 502 });
      mlDescriptions[pub.itemId] = desc;
    }
    if (mlItems[0]?.category_id) categoryName = (await ml.getCategory(token, mlItems[0].category_id))?.name || '';
    // Varios ítems sin variations[] (ficha o sueltos): el eje sale de los atributos de variación de
    // la categoría. Si no se pueden leer, se cae a "lo que cambia entre ítems".
    if (mlItems.length > 1 && !mlItems.some((it) => it.variations?.length) && mlItems[0]?.category_id) {
      try {
        const attrs = await ml.getCategoryAttributes(token, mlItems[0].category_id);
        if (attrs?.length) variationAttrIds = attrs.filter((a) => a.tags?.allow_variations).map((a) => a.id);
      } catch (e) {
        console.warn('[Edit] no se pudieron leer los atributos de la categoría:', e.message);
      }
    }
  }

  const tnProducts = [];
  if (group.tn.length) {
    const t = tokens.tiendanube;
    if (!t?.access_token) throw Object.assign(new Error('Tienda Nube no está conectada.'), { status: 409 });
    for (const pub of group.tn) {
      let product;
      try {
        product = await tn.getProduct(t.access_token, t.store_id, pub.productId);
      } catch (e) {
        throw Object.assign(new Error(`Tienda Nube no devolvió el producto ${pub.productId}. Probá de nuevo en un rato.`), { status: 502, cause: e });
      }
      if (product) tnProducts.push(product);
    }
  }
  if (!mlItems.length && !tnProducts.length) {
    throw Object.assign(new Error('Las publicaciones de este producto ya no existen en ML ni en TN.'), { status: 404 });
  }
  return { group, ...buildEditDraft({ mlItems, mlDescriptions, tnProducts, categoryName, variationAttrIds }) };
}

/**
 * Huella de lo que una edición puede pisar, por campo (hash corto para que `refs` no pese). Sirve para
 * avisar "cambió desde que empezaste a editar" mirando el contenido y no `last_updated`/`updated_at`:
 * ML mueve `last_updated` por procesos propios (calidad, envío, moderación, la ficha) aunque nadie
 * toque la publicación, y el aviso salía de más. No cubre la descripción de ML (es otro endpoint).
 */
const hash = (v) => crypto.createHash('sha1').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 12);
const attrPairs = (attrs) =>
  (attrs || []).filter((a) => a.id && a.id !== 'SELLER_SKU').map((a) => `${a.id}=${a.value_id ?? ''}|${a.value_name ?? ''}`).sort();

export function mlFingerprint(it) {
  const vars = (it.variations || []).map((v) => ({
    id: v.id, sku: mlSku(v), combos: (v.attribute_combinations || []).map((c) => `${c.id || c.name}=${c.value_name ?? ''}`), pics: v.picture_ids || [],
  }));
  return {
    title: hash(it.title),
    price: hash([it.price, ...(it.variations || []).map((v) => v.price)]),
    stock: hash([it.available_quantity, ...(it.variations || []).map((v) => v.available_quantity)]),
    pictures: hash((it.pictures || []).map((p) => p.id)),
    attributes: hash(attrPairs(it.attributes)),
    variants: hash([mlSku(it), vars]),
    shipping: hash([!!it.shipping?.free_shipping, !!it.shipping?.local_pick_up]),
    warranty: hash((it.sale_terms || []).map((t) => `${t.id}=${t.value_name ?? ''}`).sort()),
    listing: hash(it.listing_type_id),
    status: hash(it.status),
  };
}

export function tnFingerprint(p) {
  const variants = p.variants || [];
  return {
    title: hash(p.name),
    description: hash(p.description),
    price: hash(variants.map((v) => [v.id, v.price, v.promotional_price])),
    stock: hash(variants.map((v) => [v.id, v.stock])),
    pictures: hash([(p.images || []).map((i) => [i.id, i.position]), variants.map((v) => v.image_id ?? null)]),
    variants: hash(variants.map((v) => [v.id, v.sku, (v.values || []).map(tnText)])),
    categories: hash((p.categories || []).map((c) => c.id ?? c)),
    status: hash(p.published),
  };
}

const FIELD_LABELS = {
  title: 'el nombre', description: 'la descripción', price: 'el precio', stock: 'el stock', pictures: 'las fotos',
  attributes: 'las características', variants: 'las variantes', shipping: 'el envío', warranty: 'la garantía',
  listing: 'el tipo de publicación', status: 'el estado', categories: 'las categorías',
};
const changedFields = (before, after) => Object.keys(before).filter((k) => before[k] !== after[k]).map((k) => FIELD_LABELS[k] || k);

/**
 * ¿Alguien cambió las publicaciones desde que se abrió la edición? Compara la huella del contenido
 * (`fingerprint`, ver mlFingerprint/tnFingerprint) y devuelve qué cambió (`fields`); vacía = nada.
 *
 * Una edición abierta antes de que existiera la huella no se compara por `last_updated` (daba el
 * aviso de más): se le toma la huella de ahora, se guarda con `saveRefs` y desde ahí se compara.
 */
export async function checkRemoteChanges(refs, { saveRefs } = {}) {
  const changed = [];
  let backfilled = false;
  const mlRefs = refs?.ml?.items || [];
  if (mlRefs.length) {
    const token = await getMlToken();
    if (token) {
      for (const r of mlRefs) {
        // Mismo endpoint que al importar: el multiget no trae los mismos atributos.
        const { item } = await ml.getItemOrStatus(token, r.itemId);
        if (!item) continue;
        const now = mlFingerprint(item);
        if (!r.fingerprint) {
          r.fingerprint = now;
          backfilled = true;
          continue;
        }
        const fields = changedFields(r.fingerprint, now);
        if (fields.length) changed.push({ channel: 'ml', id: r.itemId, name: r.title, fields });
      }
    }
  }
  const t = tokens.tiendanube;
  for (const r of refs?.tn?.products || []) {
    if (!t?.access_token) break;
    const cur = await tn.getProduct(t.access_token, t.store_id, r.productId).catch(() => null);
    if (!cur) continue;
    const now = tnFingerprint(cur);
    if (!r.fingerprint) {
      r.fingerprint = now;
      backfilled = true;
      continue;
    }
    const fields = changedFields(r.fingerprint, now);
    if (fields.length) changed.push({ channel: 'tn', id: r.productId, name: r.name, fields });
  }
  if (backfilled && saveRefs) await saveRefs(refs);
  return changed;
}
