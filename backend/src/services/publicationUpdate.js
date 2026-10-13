/**
 * Aplicar una edición de publicación en Mercado Libre y Tienda Nube (Fase 3, ver
 * docs/plans/2026-10-12-publicaciones-mapeo-edicion-design.md).
 *
 * Corre dentro del publish worker como un job `kind: 'update'`: el `payload_json` trae las
 * operaciones que calculó publicationDiff.js (una por cosa a cambiar en una publicación), el
 * borrador editado y los ids externos. Cada operación es una unidad del job (`unit_key` = `op.key`),
 * así reintentar saltea lo que ya salió bien.
 *
 * Reglas:
 * - **Stock, precio y SKU van por los caminos de siempre** (cola de ML `stock_ml_set`/`price_ml`/
 *   `sku_ml`, `tnManualWrites.js` en TN): así quedan en el historial con el valor previo leído antes
 *   de escribir y con el eco anotado, igual que un cambio desde Precio y stock.
 * - **Ítem legacy de ML**: todo PUT con `variations` lleva el id de TODAS (`mlVariationsBody`), si no
 *   ML borra y recrea la que falta y se pierde su historial de ventas.
 * - Las creaciones (variación/producto nuevos) primero buscan por SKU y adoptan lo que ya exista:
 *   un reintento después de un corte no duplica.
 * - Un error en una operación no frena las demás: cada una informa su resultado.
 */
import { tokens, getMlToken } from '../store.js';
import * as ml from '../lib/mercadolibre.js';
import * as tn from '../lib/tiendanube.js';
import { enqueueMlTask } from '../db.js';
import { getImage, getImageUrl } from './imageStore.js';
import { plainTextToHtml, toMlPlainText } from '../lib/richText.js';
import { packageAttributes } from './productPublish.js';
import { refreshMlItemInSnapshot, refreshTnProductInSnapshot } from './conflictsService.js';
import { setTnStockManual, setTnPriceManual } from './tnManualWrites.js';

const ML_NA = '-1';
const effective = (field, common) => (field?.inherited ? common : field?.value ?? '');
const base = (kind) => String(kind || '').split(':')[0];

/**
 * Orden de ejecución dentro de cada canal: primero las fotos (una variación nueva tiene que
 * referenciar fotos que ya estén en el ítem), después lo que crea, después el resto, después
 * stock/precio/SKU y al final lo que borra.
 */
const PRIORITY = {
  pictures: 0, images: 0,
  add_variation: 1, create_item: 1, add_variant: 1, create_product: 1,
  stock: 3, price: 3, sku: 3,
  delete_variation: 4, close_item: 4, delete_variant: 4, delete_product: 4,
};
export function orderOps(ops) {
  return [...ops].sort((a, b) => (PRIORITY[base(a.kind)] ?? 2) - (PRIORITY[base(b.kind)] ?? 2));
}

/* ───────────────────────────── Mercado Libre ───────────────────────────── */

function makeMlContext(token, payload) {
  const items = new Map();
  const pictureIds = new Map();
  let categoryAttrs = null;
  return {
    token,
    payload,
    touched: new Set(),
    picturesSynced: new Set(),
    async item(itemId, { fresh = false } = {}) {
      if (!fresh && items.has(itemId)) return items.get(itemId);
      const { item, status } = await ml.getItemOrStatus(token, itemId);
      if (!item) throw new Error(`Mercado Libre no devolvió la publicación ${itemId} (HTTP ${status}).`);
      items.set(itemId, item);
      return item;
    },
    forget(itemId) {
      items.delete(itemId);
      this.touched.add(itemId);
    },
    /** Id de foto de ML para una imagen del borrador: la que ya estaba, o una nueva subida (con id, para poder referenciarla desde las variaciones). */
    async pictureId(draftImageId) {
      if (String(draftImageId).startsWith('ml-')) return String(draftImageId).slice(3);
      if (pictureIds.has(draftImageId)) return pictureIds.get(draftImageId);
      // Se sube siempre por multipart para tener el id ya: las variaciones de un ítem legacy
      // referencian fotos por id (`picture_ids`), no por URL.
      const remote = findDraftImage(payload.draft, draftImageId)?.remote;
      let id;
      if (remote?.url) {
        id = await uploadMlPictureFromUrl(token, remote.url); // foto que está en TN, elegida para ML
      } else {
        const img = await getImage(draftImageId);
        if (img) id = await ml.uploadPicture(token, img.buffer, img.filename, img.mime);
        else {
          const url = await getImageUrl(draftImageId);
          if (!url) throw new Error(`No encontramos la foto ${draftImageId} para subirla a Mercado Libre.`);
          id = await uploadMlPictureFromUrl(token, url);
        }
      }
      pictureIds.set(draftImageId, id);
      return id;
    },
    async categoryAttrs(categoryId) {
      if (categoryAttrs) return categoryAttrs;
      categoryAttrs = new Map(((await ml.getCategoryAttributes(token, categoryId)) || []).map((a) => [a.id, a]));
      return categoryAttrs;
    },
  };
}

function findDraftImage(draft, id) {
  return [...(draft?.ml?.images || []), ...(draft?.tn?.images || [])].find((img) => img.id === id) || null;
}

/** Sube a ML una foto que está en una URL (ej. una de TN): la baja y la sube por multipart. */
async function uploadMlPictureFromUrl(token, url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo bajar la foto ${url} (HTTP ${res.status}).`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const mime = res.headers.get('content-type') || 'image/jpeg';
  return ml.uploadPicture(token, buffer, 'foto.jpg', mime);
}

/** Valor de un atributo del borrador como lo espera ML. */
function mlAttrValue(a, catAttr) {
  if (a.removed) return { id: a.id, value_id: null, value_name: null };
  if (a.notApplicable) return { id: a.id, value_id: ML_NA, value_name: null };
  const allowed = catAttr?.values || [];
  if (a.valueId && allowed.some((v) => String(v.id) === String(a.valueId))) return { id: a.id, value_id: String(a.valueId) };
  let text = String(a.value ?? '').trim();
  if (!text) return { id: a.id, value_id: null, value_name: null };
  if (catAttr?.value_type === 'number_unit') {
    const m = text.match(/^(\d+(?:[.,]\d+)?)\s*(\S*)$/);
    const unit = m?.[2] || catAttr.default_unit;
    if (m && unit) text = `${m[1].replace(',', '.')} ${unit}`;
  }
  return { id: a.id, value_name: text };
}

/** Atributos de un ítem: los que ya tenía, con los cambios del borrador encima. Sin los de solo lectura. */
async function mergedMlAttributes(ctx, item, op) {
  const cat = await ctx.categoryAttrs(item.category_id);
  const isReadOnly = (id) => {
    const tags = cat.get(id)?.tags || {};
    return !!(tags.read_only || tags.fixed || tags.inferred);
  };
  const out = new Map();
  for (const a of item.attributes || []) {
    if (!a.id || isReadOnly(a.id) || a.id === 'SELLER_SKU') continue;
    out.set(a.id, a.value_id ? { id: a.id, value_id: String(a.value_id) } : { id: a.id, value_name: a.value_name ?? null });
  }
  for (const a of op.payload.attributes || []) {
    if (isReadOnly(a.id)) continue;
    out.set(a.id, mlAttrValue(a, cat.get(a.id)));
  }
  if (op.payload.brand !== undefined) out.set('BRAND', { id: 'BRAND', value_name: op.payload.brand });
  if (op.payload.package) for (const a of packageAttributes(op.payload.package)) out.set(a.id, a);
  return [...out.values()];
}

/** Fotos de un ítem legacy (galería + `picture_ids` de cada variación) según el borrador, en un solo PUT. */
async function syncLegacyPictures(ctx, itemId) {
  if (ctx.picturesSynced.has(itemId)) return 'Ya actualizadas en esta misma tanda';
  const d = ctx.payload.draft;
  const refs = ctx.payload.refs;
  const item = await ctx.item(itemId, { fresh: true });
  const gallery = [];
  for (const img of d.ml.images || []) gallery.push(await ctx.pictureId(img.id));
  const overrides = {};
  for (const v of d.variants || []) {
    const ref = refs.variants?.[v.id]?.ml;
    if (!ref?.variationId || ref.itemId !== itemId) continue;
    const ids = [];
    for (const pid of v.ml.pictureIds || []) ids.push(await ctx.pictureId(pid));
    for (const id of ids) if (!gallery.includes(id)) gallery.push(id);
    overrides[ref.variationId] = { picture_ids: ids };
  }
  await ml.updateItem(ctx.token, itemId, { pictures: gallery.map((id) => ({ id })), variations: ml.mlVariationsBody(item, overrides) });
  ctx.picturesSynced.add(itemId);
  ctx.forget(itemId);
  return `${gallery.length} fotos`;
}

const axisCombination = (axes, values) =>
  (axes || []).map((ax, i) => (ax.mlAttributeId ? { id: ax.mlAttributeId, value_name: values[i] } : { name: ax.name, value_name: values[i] }));

async function runMlOp(ctx, op) {
  const k = base(op.kind);
  const itemId = op.target;
  const p = op.payload || {};
  const d = ctx.payload.draft;

  switch (k) {
    case 'title':
      await ml.updateItem(ctx.token, itemId, { title: p.title });
      ctx.forget(itemId);
      return {};
    case 'description': {
      const r = await ml.setItemDescription(ctx.token, itemId, toMlPlainText(p.plain_text));
      if (!r.ok) throw new Error(r.error || 'Mercado Libre no aceptó la descripción.');
      return {};
    }
    case 'attributes': {
      const item = await ctx.item(itemId, { fresh: true });
      await ml.updateItem(ctx.token, itemId, { attributes: await mergedMlAttributes(ctx, item, op) });
      ctx.forget(itemId);
      return {};
    }
    case 'listing_type':
      await ml.setItemListingType(ctx.token, itemId, p.id);
      ctx.forget(itemId);
      return {};
    case 'shipping': {
      const item = await ctx.item(itemId);
      await ml.updateItem(ctx.token, itemId, { shipping: { mode: item.shipping?.mode, free_shipping: !!p.free_shipping, local_pick_up: !!p.local_pick_up } });
      ctx.forget(itemId);
      return {};
    }
    case 'warranty': {
      const sale_terms = p.type === 'Sin garantía'
        ? [{ id: 'WARRANTY_TYPE', value_name: 'Sin garantía' }]
        : [{ id: 'WARRANTY_TYPE', value_name: p.type }, { id: 'WARRANTY_TIME', value_name: p.time }];
      await ml.updateItem(ctx.token, itemId, { sale_terms });
      ctx.forget(itemId);
      return {};
    }
    case 'pictures': {
      const item = await ctx.item(itemId);
      if (item.variations?.length) return { detail: await syncLegacyPictures(ctx, itemId) };
      // Ítem sin variaciones (simple o uno de una ficha): sus fotos son las de la galería, o las
      // de su variante si viene de "Fotos de X" en un canal "uno por variante".
      const ids = p.image_ids || [];
      const pics = [];
      for (const id of ids) pics.push({ id: await ctx.pictureId(id) });
      await ml.updateItem(ctx.token, itemId, { pictures: pics });
      ctx.forget(itemId);
      return { detail: `${pics.length} fotos` };
    }
    case 'values': {
      const item = await ctx.item(itemId, { fresh: true });
      await ml.updateItem(ctx.token, itemId, {
        variations: ml.mlVariationsBody(item, { [p.variationId]: { attribute_combinations: axisCombination(p.axes, p.values) } }),
      });
      ctx.forget(itemId);
      return {};
    }
    case 'stock':
    case 'price':
    case 'sku': {
      const vid = p.variationId || null;
      const kind = k === 'stock' ? 'stock_ml_set' : k === 'price' ? 'price_ml' : 'sku_ml';
      const taskId = await enqueueMlTask({
        kind,
        itemId,
        variationId: vid,
        targetQty: k === 'stock' ? Math.max(0, Math.floor(Number(p.stock) || 0)) : null,
        targetPrice: k === 'price' ? Number(p.price) : null,
        targetSku: k === 'sku' ? p.sku : null,
        contextJson: JSON.stringify({ source: 'manual', productLabel: 'Edición de publicación' }),
        idempotencyKey: `${kind}:${itemId}:${vid || 'item'}`,
      });
      if (!taskId) throw new Error('No se pudo encolar el cambio en la Cola de ML.');
      return { detail: `En la Cola ML (#${taskId})` };
    }
    case 'add_variation': {
      const v = p.variant;
      let item = await ctx.item(itemId, { fresh: true });
      const existing = (item.variations || []).find((x) => attrText(x.attributes, 'SELLER_SKU') === v.sku);
      if (existing) return { externalId: String(existing.id), detail: 'Ya existía: se usó la que estaba' };
      // Las fotos de la variación tienen que estar en el ítem antes de referenciarlas.
      const pictureIds = [];
      for (const id of v.ml.pictureIds || []) pictureIds.push(await ctx.pictureId(id));
      const missing = pictureIds.filter((id) => !(item.pictures || []).some((pic) => String(pic.id) === String(id)));
      if (missing.length) {
        await ml.updateItem(ctx.token, itemId, {
          pictures: [...(item.pictures || []).map((pic) => ({ id: pic.id })), ...missing.map((id) => ({ id }))],
          variations: ml.mlVariationsBody(item),
        });
        item = await ctx.item(itemId, { fresh: true });
      }
      // ML exige el mismo precio en todas las variaciones de un ítem legacy.
      const price = item.variations?.[0]?.price ?? item.price ?? v.ml.price;
      const created = await ml.addItemVariation(ctx.token, itemId, {
        attribute_combinations: axisCombination(d.axes, v.values),
        price,
        available_quantity: Math.max(0, Math.floor(Number(v.stock) || 0)),
        picture_ids: pictureIds,
        attributes: [{ id: 'SELLER_SKU', value_name: v.sku }, ...(v.barcode ? [{ id: 'GTIN', value_name: v.barcode }] : [])],
      });
      ctx.forget(itemId);
      return { externalId: created?.id != null ? String(created.id) : null, detail: price !== v.ml.price ? `Precio igualado a $ ${price} (ML no deja precios distintos por variación)` : undefined };
    }
    case 'create_item': {
      const v = p.variant;
      const sibling = await ctx.item(ctx.payload.refs.ml.items[0].itemId);
      const cat = await ctx.categoryAttrs(sibling.category_id);
      const axisIds = new Set((d.axes || []).map((ax) => ax.mlAttributeId).filter(Boolean));
      const skip = new Set(['SELLER_SKU', 'GTIN', ...axisIds]);
      const attributes = (sibling.attributes || [])
        .filter((a) => a.id && !skip.has(a.id) && !(cat.get(a.id)?.tags?.read_only))
        .map((a) => (a.value_id ? { id: a.id, value_id: String(a.value_id) } : { id: a.id, value_name: a.value_name }));
      for (const c of axisCombination(d.axes, v.values)) if (c.id) attributes.push(c);
      attributes.push({ id: 'SELLER_SKU', value_name: v.sku });
      if (v.barcode) attributes.push({ id: 'GTIN', value_name: v.barcode });
      const pictures = [];
      for (const id of v.ml.pictureIds || []) pictures.push({ id: await ctx.pictureId(id) });
      const body = {
        category_id: sibling.category_id,
        price: v.ml.price ?? sibling.price,
        currency_id: sibling.currency_id || 'ARS',
        available_quantity: Math.max(0, Math.floor(Number(v.stock) || 0)),
        buying_mode: sibling.buying_mode || 'buy_it_now',
        listing_type_id: sibling.listing_type_id,
        condition: sibling.condition,
        pictures,
        attributes,
        sale_terms: sibling.sale_terms,
        shipping: { mode: sibling.shipping?.mode, free_shipping: !!sibling.shipping?.free_shipping, local_pick_up: !!sibling.shipping?.local_pick_up },
      };
      // User Products: ML rechaza `title` y agrupa por `family_name` (ver CLAUDE.md).
      if (sibling.family_name) body.family_name = sibling.family_name;
      else body.title = p.title;
      const created = await ml.createItem(ctx.token, body);
      const desc = effective(d.ml.description, '');
      if (desc && created?.id) await ml.setItemDescription(ctx.token, created.id, toMlPlainText(desc));
      if (created?.id) ctx.touched.add(created.id);
      return { externalId: created?.id || null };
    }
    case 'delete_variation': {
      try {
        await ml.deleteItemVariation(ctx.token, itemId, p.variationId);
        ctx.forget(itemId);
        return {};
      } catch (e) {
        // Con ventas ML puede no dejar borrarla: queda sin stock, que en la ficha es lo mismo.
        const item = await ctx.item(itemId, { fresh: true });
        await ml.updateItem(ctx.token, itemId, { variations: ml.mlVariationsBody(item, { [p.variationId]: { available_quantity: 0 } }) });
        ctx.forget(itemId);
        return { detail: `ML no dejó borrarla (${e.message}): quedó sin stock` };
      }
    }
    case 'close_item':
      await ml.updateItem(ctx.token, itemId, { status: 'closed' });
      ctx.forget(itemId);
      return {};
    default:
      throw new Error(`Operación de ML desconocida: ${op.kind}`);
  }
}

function attrText(attrs, id) {
  const a = (attrs || []).find((x) => String(x.id || '').toUpperCase() === id);
  return a ? String(a.value_name ?? '').trim() : '';
}

/* ───────────────────────────── Tienda Nube ───────────────────────────── */

function makeTnContext(payload) {
  const t = tokens.tiendanube;
  const products = new Map();
  return {
    token: t?.access_token,
    storeId: t?.store_id,
    payload,
    touched: new Set(),
    async product(productId, { fresh = false } = {}) {
      const key = String(productId);
      if (!fresh && products.has(key)) return products.get(key);
      const p = await tn.getProduct(this.token, this.storeId, productId);
      if (!p) throw new Error(`Tienda Nube no devolvió el producto ${productId}.`);
      products.set(key, p);
      return p;
    },
    forget(productId) {
      products.delete(String(productId));
      this.touched.add(Number(productId));
    },
  };
}

/** Deja las fotos de un producto de TN como dice el borrador: crea las que faltan, borra las que sobran y ordena. */
async function syncTnImages(ctx, productId, desiredIds) {
  const d = ctx.payload.draft;
  const current = await tn.getProductImages(ctx.token, ctx.storeId, productId);
  const byId = new Map(current.map((img) => [String(img.id), img]));
  const finalIds = [];
  for (let i = 0; i < desiredIds.length; i++) {
    const id = desiredIds[i];
    const own = String(id).startsWith('tn-') ? byId.get(String(id).slice(3)) : null;
    if (own) {
      finalIds.push(String(own.id));
      continue;
    }
    // Foto de otro producto de TN, de ML, o nueva: TN la baja de la URL.
    const remote = findDraftImage(d, id)?.remote;
    const src = remote?.url || (await getImageUrl(id));
    let created;
    if (src) created = await tn.createProductImage(ctx.token, ctx.storeId, productId, { src, position: i + 1 });
    else {
      const img = await getImage(id);
      if (!img) throw new Error(`No encontramos la foto ${id} para subirla a Tienda Nube.`);
      created = await tn.createProductImage(ctx.token, ctx.storeId, productId, { filename: img.filename, base64: img.buffer.toString('base64'), position: i + 1 });
    }
    finalIds.push(String(created.id));
  }
  for (const img of current) {
    if (!finalIds.includes(String(img.id))) await tn.deleteProductImage(ctx.token, ctx.storeId, productId, img.id);
  }
  for (let i = 0; i < finalIds.length; i++) {
    const before = byId.get(finalIds[i]);
    if (before && Number(before.position) !== i + 1) await tn.updateProductImagePosition(ctx.token, ctx.storeId, productId, finalIds[i], i + 1);
  }
  ctx.forget(productId);
  return finalIds;
}

function tnVariantBody(d, v) {
  const c = d.common;
  const body = {
    sku: v.sku,
    price: v.tn.price != null ? String(v.tn.price) : undefined,
    stock: v.stock != null ? Math.max(0, Math.floor(Number(v.stock))) : undefined,
    barcode: v.barcode || c.barcode || undefined,
    weight: c.weightG != null ? c.weightG / 1000 : undefined,
    height: c.lengthCm ?? undefined,
    width: c.widthCm ?? undefined,
    depth: c.heightCm ?? undefined,
    age_group: c.ageGroup,
    gender: c.gender,
  };
  if (c.mpn) body.mpn = c.mpn;
  return body;
}

async function runTnOp(ctx, op) {
  const k = base(op.kind);
  const productId = op.target;
  const p = op.payload || {};
  const d = ctx.payload.draft;

  switch (k) {
    case 'product': {
      const body = {};
      const f = new Set(p.fields || []);
      if (f.has('name')) body.name = p.name;
      if (f.has('description')) body.description = { es: plainTextToHtml(p.description?.es ?? '') };
      if (f.has('categories')) body.categories = p.categories;
      if (f.has('brand')) body.brand = p.brand;
      if (f.has('seo')) { body.seo_title = { es: p.seo_title || '' }; body.seo_description = { es: p.seo_description || '' }; }
      if (f.has('tags')) body.tags = p.tags;
      if (f.has('video')) body.video_url = p.video_url || null;
      if (f.has('free_shipping')) body.free_shipping = !!p.free_shipping;
      if (f.has('handle')) body.handle = { es: p.handle };
      await tn.updateProduct(ctx.token, ctx.storeId, productId, body);
      ctx.forget(productId);
      return {};
    }
    case 'name':
      await tn.updateProduct(ctx.token, ctx.storeId, productId, { name: p.name });
      ctx.forget(productId);
      return {};
    case 'variants_common': {
      const product = await ctx.product(productId, { fresh: true });
      const body = { weight: p.weight, height: p.height, width: p.width, depth: p.depth, age_group: p.age_group, gender: p.gender };
      if (p.mpn) body.mpn = p.mpn;
      for (const v of product.variants || []) await tn.updateVariant(ctx.token, ctx.storeId, productId, v.id, body);
      ctx.forget(productId);
      return { detail: `${(product.variants || []).length} variantes` };
    }
    case 'images': {
      const ids = p.image_ids || [];
      if (p.variantId != null && d.tn.mappingMode === 'single_with_variants') {
        // Producto con variantes: TN admite UNA foto por variante (la primera elegida).
        if (!ids.length) return { detail: 'Sin foto elegida: no se cambia' };
        const product = await ctx.product(productId, { fresh: true });
        const gallery = [...(product.images || []).map((img) => `tn-${img.id}`)];
        if (!gallery.includes(ids[0])) gallery.push(ids[0]);
        const finalIds = await syncTnImages(ctx, productId, gallery);
        const imageId = finalIds[gallery.indexOf(ids[0])];
        await tn.updateVariantImage(ctx.token, ctx.storeId, productId, p.variantId, Number(imageId));
        return {};
      }
      const finalIds = await syncTnImages(ctx, productId, ids);
      return { detail: `${finalIds.length} fotos` };
    }
    case 'variant': {
      const product = await ctx.product(productId);
      const body = { sku: p.sku, barcode: p.barcode || '' };
      if ((product.attributes || []).length) body.values = (p.values || []).map((value) => ({ es: value }));
      await tn.updateVariant(ctx.token, ctx.storeId, productId, p.variantId, body);
      ctx.forget(productId);
      return {};
    }
    case 'stock': {
      const ok = await setTnStockManual(productId, p.variantId, p.stock, { logPrefix: '[Edit]' });
      if (!ok) throw new Error('Tienda Nube no aceptó el stock.');
      ctx.touched.add(Number(productId));
      return {};
    }
    case 'price': {
      const ok = await setTnPriceManual(productId, p.variantId, Number(p.price), { productLabel: 'Edición de publicación' });
      if (!ok) throw new Error('Tienda Nube no aceptó el precio.');
      ctx.touched.add(Number(productId));
      return {};
    }
    case 'sku':
      await tn.updateVariantSku(ctx.token, ctx.storeId, productId, p.variantId, p.sku);
      ctx.forget(productId);
      return {};
    case 'barcode':
      await tn.updateVariant(ctx.token, ctx.storeId, productId, p.variantId, { barcode: p.barcode || '' });
      ctx.forget(productId);
      return {};
    case 'add_variant': {
      const v = p.variant;
      const product = await ctx.product(productId, { fresh: true });
      const existing = (product.variants || []).find((x) => String(x.sku || '').trim() === v.sku);
      if (existing) return { externalId: String(existing.id), detail: 'Ya existía: se usó la que estaba' };
      const created = await tn.createVariant(ctx.token, ctx.storeId, productId, {
        ...tnVariantBody(d, v),
        values: (v.values || []).map((value) => ({ es: value })),
      });
      ctx.forget(productId);
      return { externalId: created?.id != null ? String(created.id) : null };
    }
    case 'create_product': {
      const v = p.variant;
      const existing = await tn.findProductBySku(ctx.token, ctx.storeId, v.sku);
      let productIdNew;
      if (existing) {
        productIdNew = existing.id;
      } else {
        const sibling = await ctx.product(ctx.payload.refs.tn.products[0].productId);
        const created = await tn.createProduct(ctx.token, ctx.storeId, {
          name: p.name,
          description: { es: plainTextToHtml(effective(d.tn.description, '')) },
          categories: (sibling.categories || []).map((c) => c.id ?? c),
          brand: d.common.brand || sibling.brand || undefined,
          published: sibling.published !== false,
          free_shipping: !!d.tn.freeShipping,
          variants: [tnVariantBody(d, v)],
        });
        productIdNew = created.id;
      }
      if ((v.tn.imageIds || []).length) await syncTnImages(ctx, productIdNew, v.tn.imageIds);
      ctx.touched.add(Number(productIdNew));
      return { externalId: String(productIdNew), detail: existing ? 'Ya existía: se usó el que estaba' : undefined };
    }
    case 'delete_variant':
      await tn.deleteVariant(ctx.token, ctx.storeId, productId, p.variantId);
      ctx.forget(productId);
      return {};
    case 'delete_product':
      await tn.deleteProduct(ctx.token, ctx.storeId, productId);
      ctx.forget(productId);
      return {};
    default:
      throw new Error(`Operación de TN desconocida: ${op.kind}`);
  }
}

/* ───────────────────────────── Orquestación ───────────────────────────── */

/**
 * Ejecuta las operaciones de un canal en orden, salteando las ya hechas. `report(op, result)` se
 * llama con cada resultado ({ status, externalId?, detail? }); `isCancelled()` se consulta antes de
 * cada operación. Devuelve { ok, err, touched }.
 */
export async function runChannelOps(channel, payload, doneKeys, { report, isCancelled }) {
  const ops = orderOps((payload.ops || []).filter((o) => o.channel === channel));
  let ctx;
  if (channel === 'ml') {
    const token = await getMlToken();
    if (!token) {
      for (const op of ops) if (!doneKeys.has(op.key)) await report(op, { status: 'error', detail: 'Mercado Libre no está conectado.' });
      return { ok: 0, err: ops.length, touched: [] };
    }
    ctx = makeMlContext(token, payload);
  } else {
    if (!tokens.tiendanube?.access_token) {
      for (const op of ops) if (!doneKeys.has(op.key)) await report(op, { status: 'error', detail: 'Tienda Nube no está conectada.' });
      return { ok: 0, err: ops.length, touched: [] };
    }
    ctx = makeTnContext(payload);
  }
  let ok = 0;
  let err = 0;
  for (const op of ops) {
    if (doneKeys.has(op.key)) { ok++; continue; }
    if (await isCancelled()) break;
    try {
      const r = channel === 'ml' ? await runMlOp(ctx, op) : await runTnOp(ctx, op);
      await report(op, { status: 'ok', externalId: r.externalId ?? null, detail: r.detail ?? 'Listo' });
      ok++;
    } catch (e) {
      console.error(`[Edit] ${op.key} falló:`, e.message);
      await report(op, { status: 'error', detail: e.message });
      err++;
    }
  }
  return { ok, err, touched: [...ctx.touched], ctx };
}

/** Refresca en la foto del catálogo lo que se tocó, así Publicaciones lo muestra sin esperar el webhook. */
export async function refreshTouched(mlTouched, tnTouched) {
  const token = await getMlToken();
  for (const itemId of mlTouched) {
    if (token) await refreshMlItemInSnapshot(token, itemId).catch((e) => console.error('[Edit] refresh ML', itemId, e.message));
  }
  const t = tokens.tiendanube;
  for (const productId of tnTouched) {
    if (t?.access_token) await refreshTnProductInSnapshot(t.access_token, t.store_id, productId).catch((e) => console.error('[Edit] refresh TN', productId, e.message));
  }
}
