/**
 * Qué cambió en una edición de publicación y qué hay que mandarle a cada canal.
 *
 * Compara el borrador editado contra el `baseline` (cómo estaba al importarlo, ver
 * publicationImport.js) y devuelve una lista de operaciones, una por cosa a cambiar en una
 * publicación concreta. Esa misma lista es la que ve la usuaria en "Cambios a aplicar" y la que
 * ejecuta el worker al guardar. Un campo que no se tocó no genera operación: así guardar nunca
 * pisa un cambio hecho desde el panel de ML/TN en otro campo.
 *
 * Cada operación: { key, channel, target, targetLabel, kind, label, warn?, payload }.
 * `key` es estable (sirve de `unit_key` del job: reintentar no repite lo que ya salió bien).
 * Puro: sin I/O. Reproduce las reglas de "valor efectivo" del front (product-draft.store.ts:
 * `effective`, `variantTitle`) para comparar lo que de verdad se publicaría.
 */

const effective = (field, common) => (field?.inherited ? common : field?.value ?? '');
const label = (values) => (values || []).map((v) => String(v ?? '').trim()).filter(Boolean).join(' ');
const defaultVariantTitle = (base, values) => {
  const l = label(values);
  const b = String(base || '').trim();
  if (!b) return l;
  if (!l) return b;
  return `${b} - ${l}`;
};
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const norm = (s) => String(s ?? '').trim();
const money = (n) => (n == null ? '—' : `$ ${Number(n).toLocaleString('es-AR')}`);

function variantTitle(d, channel, v) {
  const base = channel === 'ml' ? effective(d.ml.title, d.common.baseName) : effective(d.tn.nameEs, d.common.baseName);
  return effective(v.titles?.[channel], defaultVariantTitle(base, v.values));
}

/** Valor de un atributo de ML para comparar: "No aplica", o el texto (el `value_id` puede caerse al refrescar la categoría). */
const attrKey = (a) => (a?.notApplicable ? '-1' : norm(a?.value).toLowerCase());

/** Ids de imagen en orden → ids de ML/TN existentes o `null` para una foto nueva. */
const imageIds = (images) => (images || []).map((img) => img.id);

export function planPublicationUpdate(baseline, draft, refs) {
  const ops = [];
  const add = (op) => ops.push(op);
  const b = baseline;
  const d = draft;
  const hasMl = !!refs?.channels?.ml;
  const hasTn = !!refs?.channels?.tn;
  const mlItems = refs?.ml?.items || [];
  const tnProducts = refs?.tn?.products || [];
  const mlLabel = (itemId) => {
    const i = mlItems.findIndex((x) => x.itemId === itemId);
    return i >= 0 ? `ML-${i + 1}` : 'ML';
  };
  const tnLabel = (productId) => {
    const i = tnProducts.findIndex((x) => String(x.productId) === String(productId));
    return i >= 0 ? `TN-${i + 1}` : 'TN';
  };
  const mlOp = (itemId, kind, text, payload = {}, warn) =>
    add({ key: `ml:${itemId}:${kind}`, channel: 'ml', target: itemId, targetLabel: mlLabel(itemId), kind, label: text, warn, payload });
  const tnOp = (productId, kind, text, payload = {}, warn) =>
    add({ key: `tn:${productId}:${kind}`, channel: 'tn', target: String(productId), targetLabel: tnLabel(productId), kind, label: text, warn, payload });

  // ═══ Mercado Libre: lo que es de cada publicación ═══
  if (hasMl) {
    const descB = effective(b.ml.description, ''), descD = effective(d.ml.description, '');
    const titleB = effective(b.ml.title, b.common.baseName), titleD = effective(d.ml.title, d.common.baseName);
    const changedAttrs = [];
    const bAttrs = new Map((b.ml.attributes || []).map((a) => [a.id, a]));
    for (const a of d.ml.attributes || []) {
      const prev = bAttrs.get(a.id);
      if (attrKey(prev) !== attrKey(a)) changedAttrs.push(a);
    }
    for (const a of b.ml.attributes || []) {
      if (!(d.ml.attributes || []).some((x) => x.id === a.id) && attrKey(a)) changedAttrs.push({ ...a, value: '', removed: true });
    }
    const brandChanged = norm(b.common.brand) !== norm(d.common.brand);
    const packageChanged = ['weightG', 'lengthCm', 'widthCm', 'heightCm'].some((k) => !same(b.common[k], d.common[k]));
    const gallery = !same(imageIds(b.ml.images), imageIds(d.ml.images));

    for (const it of mlItems) {
      if (d.ml.mappingMode === 'single_with_variants' && titleB !== titleD) mlOp(it.itemId, 'title', 'Cambiar el título', { title: titleD });
      if (descB !== descD) mlOp(it.itemId, 'description', 'Cambiar la descripción', { plain_text: descD });
      if (changedAttrs.length || brandChanged || packageChanged) {
        const names = [...changedAttrs.map((a) => a.name), ...(brandChanged ? ['Marca'] : []), ...(packageChanged ? ['medidas del paquete'] : [])];
        mlOp(it.itemId, 'attributes', `Cambiar características: ${[...new Set(names)].join(', ')}`, {
          attributes: changedAttrs.map((a) => ({ id: a.id, name: a.name, value: a.value, valueId: a.valueId, notApplicable: !!a.notApplicable, removed: !!a.removed })),
          brand: brandChanged ? d.common.brand : undefined,
          package: packageChanged ? { weightG: d.common.weightG, lengthCm: d.common.lengthCm, widthCm: d.common.widthCm, heightCm: d.common.heightCm } : undefined,
        });
      }
      if (b.ml.listingType !== d.ml.listingType) {
        mlOp(it.itemId, 'listing_type', d.ml.listingType === 'gold_pro' ? 'Pasar a Premium (cuotas sin interés)' : 'Pasar a Clásica', { id: d.ml.listingType });
      }
      if (b.ml.freeShipping !== d.ml.freeShipping || b.ml.localPickup !== d.ml.localPickup) {
        mlOp(it.itemId, 'shipping', 'Cambiar el envío', { free_shipping: d.ml.freeShipping, local_pick_up: d.ml.localPickup });
      }
      if (b.ml.warrantyType !== d.ml.warrantyType || b.ml.warrantyTime !== d.ml.warrantyTime) {
        mlOp(it.itemId, 'warranty', 'Cambiar la garantía', { type: d.ml.warrantyType, time: d.ml.warrantyTime });
      }
    }
    if (gallery) {
      // En una publicación con variaciones la galería es del ítem; en "una por variante" cada ítem
      // tiene la suya y se arma con las fotos de su variante (eso lo cubre el bloque de variantes).
      for (const it of mlItems.filter((x) => x.format !== 'up' || mlItems.length === 1)) {
        mlOp(it.itemId, 'pictures', 'Actualizar las fotos', { image_ids: imageIds(d.ml.images) });
      }
    }
  }

  // ═══ Tienda Nube: lo que es de cada producto ═══
  if (hasTn) {
    const fields = [];
    const descB = effective(b.tn.description, ''), descD = effective(d.tn.description, '');
    if (descB !== descD) fields.push(['description', 'descripción']);
    if (!same(b.tn.categories, d.tn.categories)) fields.push(['categories', 'categorías']);
    if (norm(b.common.brand) !== norm(d.common.brand)) fields.push(['brand', 'marca']);
    if (b.tn.seoTitle !== d.tn.seoTitle || b.tn.seoDescription !== d.tn.seoDescription) fields.push(['seo', 'SEO']);
    if (b.tn.tags !== d.tn.tags) fields.push(['tags', 'etiquetas']);
    if (b.tn.videoUrl !== d.tn.videoUrl) fields.push(['video', 'video']);
    if (b.tn.freeShipping !== d.tn.freeShipping) fields.push(['free_shipping', 'envío gratis']);
    if (b.tn.handle !== d.tn.handle) fields.push(['handle', 'URL']);
    const nameB = effective(b.tn.nameEs, b.common.baseName), nameD = effective(d.tn.nameEs, d.common.baseName);
    const singleNameChanged = d.tn.mappingMode === 'single_with_variants' && nameB !== nameD;
    const payload = {
      description: { es: descD },
      categories: d.tn.categories,
      brand: d.common.brand,
      seo_title: d.tn.seoTitle,
      seo_description: d.tn.seoDescription,
      tags: d.tn.tags,
      video_url: d.tn.videoUrl,
      free_shipping: d.tn.freeShipping,
      handle: d.tn.handle,
    };
    for (const p of tnProducts) {
      const own = [...fields.map((f) => f[1])];
      const body = { fields: fields.map((f) => f[0]), ...payload };
      if (singleNameChanged) { own.unshift('nombre'); body.fields.push('name'); body.name = { es: nameD }; }
      if (own.length) tnOp(p.productId, 'product', `Cambiar ${own.join(', ')}`, body);
    }
    const packageChanged = ['weightG', 'lengthCm', 'widthCm', 'heightCm'].some((k) => !same(b.common[k], d.common[k]));
    const shoppingChanged = b.common.mpn !== d.common.mpn || b.common.ageGroup !== d.common.ageGroup || b.common.gender !== d.common.gender;
    if (packageChanged || shoppingChanged) {
      for (const p of tnProducts) {
        tnOp(p.productId, 'variants_common', packageChanged ? 'Cambiar medidas y peso' : 'Cambiar datos de Google/Instagram Shopping', {
          weight: d.common.weightG != null ? d.common.weightG / 1000 : null,
          height: d.common.lengthCm, width: d.common.widthCm, depth: d.common.heightCm,
          mpn: d.common.mpn, age_group: d.common.ageGroup, gender: d.common.gender,
        });
      }
    }
    if (d.tn.mappingMode === 'single_with_variants' && !same(imageIds(b.tn.images), imageIds(d.tn.images))) {
      for (const p of tnProducts) tnOp(p.productId, 'images', 'Actualizar las fotos', { image_ids: imageIds(d.tn.images) });
    }
  }

  // ═══ Producto simple (sin variantes) ═══
  if (refs?.simple) {
    const base = refs.base || {};
    if (!same(b.common.baseStock, d.common.baseStock)) {
      const text = `Stock: ${b.common.baseStock ?? '—'} → ${d.common.baseStock ?? '—'}`;
      if (base.ml) mlOp(base.ml.itemId, 'stock', text, { variationId: base.ml.variationId, stock: d.common.baseStock });
      if (base.tn) tnOp(base.tn.productId, 'stock', text, { variantId: base.tn.variantId, stock: d.common.baseStock });
    }
    if (base.ml && !same(b.ml.basePrice, d.ml.basePrice)) mlOp(base.ml.itemId, 'price', `Precio: ${money(b.ml.basePrice)} → ${money(d.ml.basePrice)}`, { variationId: base.ml.variationId, price: d.ml.basePrice });
    if (base.tn && !same(b.tn.basePrice, d.tn.basePrice)) tnOp(base.tn.productId, 'price', `Precio: ${money(b.tn.basePrice)} → ${money(d.tn.basePrice)}`, { variantId: base.tn.variantId, price: d.tn.basePrice });
    if (norm(b.common.sku) !== norm(d.common.sku)) {
      const text = `SKU: ${b.common.sku || '—'} → ${d.common.sku}`;
      if (base.ml) mlOp(base.ml.itemId, 'sku', text, { variationId: base.ml.variationId, sku: d.common.sku });
      if (base.tn) tnOp(base.tn.productId, 'sku', text, { variantId: base.tn.variantId, sku: d.common.sku });
    }
    if (base.tn && norm(b.common.barcode) !== norm(d.common.barcode)) tnOp(base.tn.productId, 'barcode', 'Cambiar el código de barras', { variantId: base.tn.variantId, barcode: d.common.barcode });
    if (base.tn && d.tn.mappingMode !== 'single_with_variants' && !same(imageIds(b.tn.images), imageIds(d.tn.images))) {
      tnOp(base.tn.productId, 'images', 'Actualizar las fotos', { image_ids: imageIds(d.tn.images) });
    }
    return ops;
  }

  // ═══ Variantes ═══
  const bById = new Map((b.variants || []).map((v) => [v.id, v]));
  const dById = new Map((d.variants || []).map((v) => [v.id, v]));
  const vrefs = refs?.variants || {};
  const legacyItem = mlItems.length === 1 && mlItems[0].format === 'legacy' ? mlItems[0] : null;
  const tnSingle = tnProducts.length === 1 && d.tn.mappingMode === 'single_with_variants' ? tnProducts[0] : null;

  for (const v of d.variants || []) {
    const prev = bById.get(v.id);
    const name = `"${label(v.values) || v.sku || 'variante'}"`;
    const ref = vrefs[v.id] || { ml: null, tn: null };

    if (!prev) {
      // Variante nueva: se crea en cada canal según cómo está armado.
      if (hasMl) {
        if (legacyItem) mlOp(legacyItem.itemId, `add_variation:${v.id}`, `Agregar la variación ${name}`, { variant: v });
        else add({ key: `ml:new:${v.id}`, channel: 'ml', target: 'new', targetLabel: 'ML nuevo', kind: 'create_item', label: `Crear la publicación ${name}${mlItems.some((x) => x.format === 'up') ? ' en la misma ficha' : ''}`, payload: { variant: v, title: variantTitle(d, 'ml', v) } });
      }
      if (hasTn) {
        if (tnSingle) tnOp(tnSingle.productId, `add_variant:${v.id}`, `Agregar la variante ${name}`, { variant: v });
        else add({ key: `tn:new:${v.id}`, channel: 'tn', target: 'new', targetLabel: 'TN nuevo', kind: 'create_product', label: `Crear el producto "${variantTitle(d, 'tn', v)}"`, payload: { variant: v, name: variantTitle(d, 'tn', v) } });
      }
      continue;
    }

    if (ref.ml) {
      const t = ref.ml.itemId;
      const varPayload = { variationId: ref.ml.variationId };
      if (!same(prev.values, v.values)) {
        mlOp(t, `values:${v.id}`, `Renombrar ${`"${label(prev.values)}"`} → ${name}`, { ...varPayload, values: v.values, axes: d.axes },
          ref.ml.soldQuantity > 0 && ref.ml.variationId ? 'Con ventas, ML solo deja sumar atributos de variación, no cambiarlos: puede rechazarlo.' : undefined);
      }
      if (norm(prev.sku) !== norm(v.sku)) mlOp(t, `sku:${v.id}`, `SKU de ${name} → ${v.sku}`, { ...varPayload, sku: v.sku });
      if (!same(prev.stock, v.stock)) mlOp(t, `stock:${v.id}`, `Stock de ${name}: ${prev.stock ?? '—'} → ${v.stock ?? '—'}`, { ...varPayload, stock: v.stock });
      if (!same(prev.ml.price, v.ml.price)) {
        mlOp(t, `price:${v.id}`, `Precio de ${name}: ${money(prev.ml.price)} → ${money(v.ml.price)}`, { ...varPayload, price: v.ml.price },
          legacyItem ? 'Publicación clásica: ML aplica el mismo precio a todas las variaciones.' : undefined);
      }
      if (!same(prev.ml.pictureIds, v.ml.pictureIds)) mlOp(t, `pictures:${v.id}`, `Fotos de ${name}`, { ...varPayload, image_ids: v.ml.pictureIds });
      // En una ficha de User Products el título lo arma ML: un PUT con `title` da 400.
      const isFamilyItem = mlItems.find((x) => x.itemId === t)?.format === 'up';
      if (d.ml.mappingMode === 'one_per_variant' && !isFamilyItem && variantTitle(b, 'ml', prev) !== variantTitle(d, 'ml', v)) {
        mlOp(t, `title:${v.id}`, `Cambiar el título de ${name}`, { title: variantTitle(d, 'ml', v) });
      }
    }
    if (ref.tn) {
      const t = ref.tn.productId;
      const varPayload = { variantId: ref.tn.variantId };
      const variantChanged = [];
      if (!same(prev.values, v.values) && tnSingle) variantChanged.push('nombre');
      if (norm(prev.sku) !== norm(v.sku)) variantChanged.push('SKU');
      if (norm(prev.barcode) !== norm(v.barcode)) variantChanged.push('código de barras');
      if (variantChanged.length) tnOp(t, `variant:${v.id}`, `Cambiar ${variantChanged.join(', ')} de ${name}`, { ...varPayload, values: v.values, sku: v.sku, barcode: v.barcode });
      if (!same(prev.stock, v.stock)) tnOp(t, `stock:${v.id}`, `Stock de ${name}: ${prev.stock ?? '—'} → ${v.stock ?? '—'}`, { ...varPayload, stock: v.stock });
      if (!same(prev.tn.price, v.tn.price)) tnOp(t, `price:${v.id}`, `Precio de ${name}: ${money(prev.tn.price)} → ${money(v.tn.price)}`, { ...varPayload, price: v.tn.price });
      if (!same(prev.tn.imageIds, v.tn.imageIds)) tnOp(t, `images:${v.id}`, `Fotos de ${name}`, { ...varPayload, image_ids: v.tn.imageIds });
      if (d.tn.mappingMode === 'one_per_variant' && variantTitle(b, 'tn', prev) !== variantTitle(d, 'tn', v)) {
        tnOp(t, `name:${v.id}`, `Cambiar el nombre de ${name}`, { name: { es: variantTitle(d, 'tn', v) } });
      }
    }
  }

  // Variantes que estaban y se quitaron.
  for (const prev of b.variants || []) {
    if (dById.has(prev.id)) continue;
    const name = `"${label(prev.values) || prev.sku || 'variante'}"`;
    const ref = vrefs[prev.id] || {};
    if (ref.ml) {
      const sold = ref.ml.soldQuantity || 0;
      if (ref.ml.variationId) {
        mlOp(ref.ml.itemId, `delete_variation:${prev.id}`, `Eliminar la variación ${name}`, { variationId: ref.ml.variationId },
          sold ? `Tiene ${sold} ventas: si ML no deja borrarla, se deja sin stock.` : undefined);
      } else {
        mlOp(ref.ml.itemId, 'close_item', `Finalizar la publicación ${name}`, {}, sold ? `Tiene ${sold} ventas: queda en el historial de ML.` : undefined);
      }
    }
    if (ref.tn) {
      if (tnSingle) tnOp(ref.tn.productId, `delete_variant:${prev.id}`, `Eliminar la variante ${name}`, { variantId: ref.tn.variantId });
      else tnOp(ref.tn.productId, 'delete_product', `Eliminar el producto ${name}`, {});
    }
  }

  return ops;
}

/** Resumen corto para la lista: { total, ml, tn }. */
export function summarizeOps(ops) {
  return { total: ops.length, ml: ops.filter((o) => o.channel === 'ml').length, tn: ops.filter((o) => o.channel === 'tn').length };
}
