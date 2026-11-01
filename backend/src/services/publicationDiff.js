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

/**
 * A qué publicaciones va un cambio "común" (descripción, envío, categorías…). El form muestra el
 * valor de la PRIMERA publicación del canal y las demás pueden tener otro: se manda a las que tenían
 * el valor que se vio (`to`) y las que tenían otro se dejan como estaban (`kept`, se avisa). Sin
 * `current` (edición abierta antes de que se guardara por publicación) se asume el que se vio.
 */
function spread(pubs, curOf, before, after) {
  const to = [];
  const kept = [];
  if (same(before, after)) return { to, kept };
  for (const p of pubs) {
    const cur = p.current ? curOf(p.current) : before;
    if (same(cur, after)) continue;
    if (same(cur, before)) to.push(p);
    else kept.push(p);
  }
  return { to, kept };
}
const keptWarn = (labels, what) =>
  labels.length ? `${labels.join(', ')} ${labels.length > 1 ? 'tenían' : 'tenía'} otro valor en «${what}»: ahí no se cambia.` : undefined;
const joinWarn = (...w) => w.filter(Boolean).join(' ') || undefined;

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
    const naKept = []; // ML no deja vaciar un atributo que está en "No aplica": solo cambiarlo por un valor
    const bAttrs = new Map((b.ml.attributes || []).map((a) => [a.id, a]));
    for (const a of d.ml.attributes || []) {
      const prev = bAttrs.get(a.id);
      if (attrKey(prev) === attrKey(a)) continue;
      if (prev?.notApplicable && !attrKey(a)) naKept.push(a.name || a.id);
      else changedAttrs.push(a);
    }
    for (const a of b.ml.attributes || []) {
      if ((d.ml.attributes || []).some((x) => x.id === a.id) || !attrKey(a)) continue;
      if (a.notApplicable) naKept.push(a.name || a.id);
      else changedAttrs.push({ ...a, value: '', removed: true });
    }
    const brandChanged = norm(b.common.brand) !== norm(d.common.brand);
    const packageChanged = ['weightG', 'lengthCm', 'widthCm', 'heightCm'].some((k) => !same(b.common[k], d.common[k]));
    const gallery = !same(imageIds(b.ml.images), imageIds(d.ml.images));
    const labels = (list) => list.map((x) => mlLabel(x.itemId));

    // Lo común va a cada ítem que tenía el valor que se vio en el form (ver `spread`).
    const desc = spread(mlItems, (c) => c.description ?? '', descB, descD);
    const free = spread(mlItems, (c) => !!c.freeShipping, !!b.ml.freeShipping, !!d.ml.freeShipping);
    const pickup = spread(mlItems, (c) => !!c.localPickup, !!b.ml.localPickup, !!d.ml.localPickup);
    const warrantyOf = (x) => ({ type: x.warrantyType ?? '', time: x.warrantyTime ?? '' });
    const warranty = spread(mlItems, warrantyOf, warrantyOf(b.ml), warrantyOf(d.ml));
    const listing = spread(mlItems, (c) => c.listingType, b.ml.listingType, d.ml.listingType);
    const isFirst = (sp, it) => sp.to[0] === it;

    for (const it of mlItems) {
      // En User Products el título lo arma ML: un PUT con `title` da 400 (también con un solo ítem).
      if (d.ml.mappingMode === 'single_with_variants' && it.format !== 'up' && titleB !== titleD) mlOp(it.itemId, 'title', 'Cambiar el título', { title: titleD });
      if (desc.to.includes(it)) {
        mlOp(it.itemId, 'description', descD.trim() ? 'Cambiar la descripción' : 'Vaciar la descripción', { plain_text: descD },
          joinWarn(!descD.trim() && 'ML no deja una descripción vacía: va a fallar, dejá al menos una línea.', isFirst(desc, it) && keptWarn(labels(desc.kept), 'descripción')));
      }
      if (changedAttrs.length || brandChanged || packageChanged) {
        const names = [...changedAttrs.map((a) => a.name), ...(brandChanged ? ['Marca'] : []), ...(packageChanged ? ['medidas del paquete'] : [])];
        mlOp(it.itemId, 'attributes', `Cambiar características: ${[...new Set(names)].join(', ')}`, {
          attributes: changedAttrs.map((a) => ({ id: a.id, name: a.name, value: a.value, valueId: a.valueId, notApplicable: !!a.notApplicable, removed: !!a.removed })),
          brand: brandChanged ? d.common.brand : undefined,
          package: packageChanged ? { weightG: d.common.weightG, lengthCm: d.common.lengthCm, widthCm: d.common.widthCm, heightCm: d.common.heightCm } : undefined,
        }, naKept.length ? `ML no deja vaciar lo que está en "No aplica" (${naKept.join(', ')}): queda como estaba.` : undefined);
      }
      if (listing.to.includes(it)) {
        mlOp(it.itemId, 'listing_type', d.ml.listingType === 'gold_pro' ? 'Pasar a Premium (cuotas sin interés)' : 'Pasar a Clásica', { id: d.ml.listingType },
          joinWarn('ML deja cambiar el tipo de publicación una sola vez.', isFirst(listing, it) && keptWarn(labels(listing.kept), 'tipo de publicación')));
      }
      // Solo el dato del envío que cambió: el otro queda como lo tenga cada ítem.
      const shipping = {};
      if (free.to.includes(it)) shipping.free_shipping = !!d.ml.freeShipping;
      if (pickup.to.includes(it)) shipping.local_pick_up = !!d.ml.localPickup;
      if (Object.keys(shipping).length) {
        mlOp(it.itemId, 'shipping', 'Cambiar el envío', shipping,
          joinWarn(isFirst(free, it) && keptWarn(labels(free.kept), 'envío gratis'), isFirst(pickup, it) && keptWarn(labels(pickup.kept), 'retiro en persona')));
      }
      if (warranty.to.includes(it)) {
        mlOp(it.itemId, 'warranty', 'Cambiar la garantía', { type: d.ml.warrantyType, time: d.ml.warrantyTime },
          isFirst(warranty, it) ? keptWarn(labels(warranty.kept), 'garantía') : undefined);
      }
    }
    // En "una por variante" con varios ítems la galería es solo el banco de fotos (puede tener más
    // que el tope de un ítem): cada ítem lleva las de su variante, y eso lo cubre el bloque de variantes.
    const galleryIsPool = mlItems.length > 1 && d.ml.mappingMode === 'one_per_variant';
    if (gallery && !galleryIsPool) {
      // En una publicación con variaciones la galería es del ítem; en una ficha de User Products
      // cada ítem tiene la suya y se arma con las fotos de su variante (bloque de variantes).
      for (const it of mlItems.filter((x) => x.format !== 'up' || mlItems.length === 1)) {
        mlOp(it.itemId, 'pictures', 'Actualizar las fotos', { image_ids: imageIds(d.ml.images) });
      }
    }
  }

  // ═══ Tienda Nube: lo que es de cada producto ═══
  if (hasTn) {
    const descB = effective(b.tn.description, ''), descD = effective(d.tn.description, '');
    const nameB = effective(b.tn.nameEs, b.common.baseName), nameD = effective(d.tn.nameEs, d.common.baseName);
    // [campo del body, qué se lee de cada producto, antes, después, cómo se nombra]. La marca es del
    // producto del hub: va a todo producto que no la tenga ya, sin importar cuál tenía antes.
    const specs = [
      ['description', (c) => c.description ?? '', descB, descD, 'descripción'],
      ['categories', (c) => c.categories ?? [], b.tn.categories ?? [], d.tn.categories ?? [], 'categorías'],
      ['seo', (c) => [c.seoTitle ?? '', c.seoDescription ?? ''], [b.tn.seoTitle ?? '', b.tn.seoDescription ?? ''], [d.tn.seoTitle ?? '', d.tn.seoDescription ?? ''], 'SEO'],
      ['tags', (c) => c.tags ?? '', b.tn.tags ?? '', d.tn.tags ?? '', 'etiquetas'],
      ['video', (c) => c.videoUrl ?? '', b.tn.videoUrl ?? '', d.tn.videoUrl ?? '', 'video'],
      ['free_shipping', (c) => !!c.freeShipping, !!b.tn.freeShipping, !!d.tn.freeShipping, 'envío gratis'],
      // La URL es única por producto: con varios, solo la cambia el que la tenía.
      ['handle', (c) => c.handle ?? '', b.tn.handle ?? '', d.tn.handle ?? '', 'URL'],
    ];
    if (d.tn.mappingMode === 'single_with_variants') specs.unshift(['name', (c) => c.name ?? '', nameB, nameD, 'nombre']);
    const spreads = specs.map(([field, curOf, before, after, what]) => ({ field, what, ...spread(tnProducts, curOf, before, after) }));
    const brandD = norm(d.common.brand);
    const brandTo = norm(b.common.brand) === brandD ? [] : tnProducts.filter((p) => (p.current ? norm(p.current.brand) !== brandD : true));
    const payload = {
      name: { es: nameD },
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
      const mine = spreads.filter((sp) => sp.to.includes(p));
      const fields = mine.map((sp) => sp.field);
      const names = mine.map((sp) => sp.what);
      if (brandTo.includes(p)) { fields.push('brand'); names.push('marca'); }
      const warn = joinWarn(...mine.filter((sp) => sp.to[0] === p).map((sp) => keptWarn(sp.kept.map((x) => tnLabel(x.productId)), sp.what)));
      if (fields.length) tnOp(p.productId, 'product', `Cambiar ${names.join(', ')}`, { fields, ...payload }, warn);
    }
    // Medidas y datos de Shopping: solo los campos que cambiaron (sin nulls), así cambiar el género
    // no reescribe las medidas que tenga cada variante.
    const variantsCommon = {};
    const dims = [['weightG', 'weight', (n) => n / 1000], ['lengthCm', 'height'], ['widthCm', 'width'], ['heightCm', 'depth']];
    for (const [k, field, conv = (n) => n] of dims) if (!same(b.common[k], d.common[k]) && d.common[k] != null && d.common[k] !== '') variantsCommon[field] = conv(Number(d.common[k]));
    const packageChanged = Object.keys(variantsCommon).length > 0;
    for (const [k, field] of [['mpn', 'mpn'], ['ageGroup', 'age_group'], ['gender', 'gender']]) if (b.common[k] !== d.common[k] && d.common[k]) variantsCommon[field] = d.common[k];
    if (Object.keys(variantsCommon).length) {
      for (const p of tnProducts) {
        tnOp(p.productId, 'variants_common', packageChanged ? 'Cambiar medidas y peso' : 'Cambiar datos de Google/Instagram Shopping', variantsCommon);
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
  const mlFormat = (itemId) => mlItems.find((x) => x.itemId === itemId)?.format;
  // Qué se hace con una variante de TN depende de SU producto, no de cómo está armado el grupo: un
  // producto "A4" con 3 colores dentro de un grupo de varios productos sigue teniendo variantes, y
  // quitar una de ellas no puede borrar el producto entero.
  const tnPid = (id) => (vrefs[id]?.tn?.productId != null ? String(vrefs[id].tn.productId) : null);
  const tnVariantCount = new Map();
  for (const v of b.variants || []) if (tnPid(v.id)) tnVariantCount.set(tnPid(v.id), (tnVariantCount.get(tnPid(v.id)) || 0) + 1);
  const tnMulti = (pid) => (tnVariantCount.get(String(pid)) || 0) > 1;
  // Una variante nueva entra como variante si hay un solo producto; con varios, como producto aparte.
  const tnAddTarget = tnProducts.length === 1 ? tnProducts[0] : null;
  const legacyPriceOps = new Map(); // itemId → { op, prices }: un solo cambio de precio por ítem legacy
  const tnRenamed = new Set();

  // Una variante que se quitó y se volvió a agregar con el mismo SKU es la MISMA: no se borra y se
  // crea. Sin esto la alta (que corre antes) adoptaba la existente por SKU y después la baja la borraba.
  const reAddedFrom = new Map(); // id nuevo → id de la variante que ya existía
  const removedBySku = new Map();
  for (const prev of b.variants || []) if (!dById.has(prev.id) && norm(prev.sku)) removedBySku.set(norm(prev.sku), prev.id);
  for (const v of d.variants || []) {
    if (bById.has(v.id) || !norm(v.sku) || !removedBySku.has(norm(v.sku))) continue;
    reAddedFrom.set(v.id, removedBySku.get(norm(v.sku)));
    removedBySku.delete(norm(v.sku));
  }
  const reAddedOld = new Set(reAddedFrom.values());

  const createMl = (v, name, why = '') => {
    if (legacyItem) mlOp(legacyItem.itemId, `add_variation:${v.id}`, `Agregar la variación ${name}${why}`, { variant: v });
    else add({ key: `ml:new:${v.id}`, channel: 'ml', target: 'new', targetLabel: 'ML nuevo', kind: 'create_item', label: `Crear la publicación ${name}${mlItems.some((x) => x.format === 'up') ? ' en la misma ficha' : ''}${why}`, payload: { variant: v, title: variantTitle(d, 'ml', v) } });
  };
  const createTn = (v, name, why = '') => {
    if (tnAddTarget) tnOp(tnAddTarget.productId, `add_variant:${v.id}`, `Agregar la variante ${name}${why}`, { variant: v });
    else {
      add({ key: `tn:new:${v.id}`, channel: 'tn', target: 'new', targetLabel: 'TN nuevo', kind: 'create_product', label: `Crear el producto "${variantTitle(d, 'tn', v)}"${why}`, payload: { variant: v, name: variantTitle(d, 'tn', v) },
        warn: [...tnVariantCount.values()].some((n) => n > 1) ? 'En Tienda Nube se crea como un producto aparte (el grupo tiene varios productos).' : undefined });
    }
  };

  for (const v of d.variants || []) {
    const prevId = bById.has(v.id) ? v.id : reAddedFrom.get(v.id);
    const prev = prevId ? bById.get(prevId) : undefined;
    const name = `"${label(v.values) || v.sku || 'variante'}"`;
    const ref = (prevId && vrefs[prevId]) || { ml: null, tn: null };

    if (!prev) {
      // Variante nueva: se crea en cada canal según cómo está armado.
      if (hasMl) createMl(v, name);
      if (hasTn) createTn(v, name);
      continue;
    }

    // Variante que ya existe en un solo canal: se publica en el que le falta.
    if (hasMl && !ref.ml && ref.tn) createMl(v, name, ' (hoy está solo en Tienda Nube)');
    if (hasTn && !ref.tn && ref.ml) createTn(v, name, ' (hoy está solo en Mercado Libre)');

    if (ref.ml) {
      const t = ref.ml.itemId;
      const varPayload = { variationId: ref.ml.variationId };
      if (!same(prev.values, v.values)) {
        mlOp(t, `values:${v.id}`, `Renombrar ${`"${label(prev.values)}"`} → ${name}`, { ...varPayload, values: v.values, axes: d.axes },
          ref.ml.soldQuantity > 0 ? 'Con ventas, ML puede no dejar cambiar el atributo de la variante.' : undefined);
      }
      if (norm(prev.sku) !== norm(v.sku)) mlOp(t, `sku:${v.id}`, `SKU de ${name} → ${v.sku}`, { ...varPayload, sku: v.sku });
      if (!same(prev.stock, v.stock)) mlOp(t, `stock:${v.id}`, `Stock de ${name}: ${prev.stock ?? '—'} → ${v.stock ?? '—'}`, { ...varPayload, stock: v.stock });
      if (!same(prev.ml.price, v.ml.price)) {
        if (mlFormat(t) === 'legacy') {
          // En una publicación clásica ML aplica UN precio a todas las variaciones: con varios
          // cambios, cada tarea pisaría a la anterior. Un solo cambio por ítem, con el primero.
          const cur = legacyPriceOps.get(t);
          if (!cur) {
            mlOp(t, `price:${v.id}`, `Precio de ${name}: ${money(prev.ml.price)} → ${money(v.ml.price)}`, { ...varPayload, price: v.ml.price },
              'Publicación clásica: ML aplica el mismo precio a todas las variaciones.');
            legacyPriceOps.set(t, { op: ops[ops.length - 1], names: [name], prices: [Number(v.ml.price)] });
          } else {
            cur.names.push(name);
            cur.prices.push(Number(v.ml.price));
            const distinct = [...new Set(cur.prices)];
            cur.op.label = `Precio de ${cur.names.join(', ')} → ${money(cur.prices[0])}`;
            cur.op.warn = distinct.length > 1
              ? `Pusiste precios distintos (${distinct.map(money).join(', ')}), pero en una publicación clásica ML usa uno solo para todas las variaciones: se aplica ${money(cur.prices[0])}.`
              : 'Publicación clásica: ML aplica el mismo precio a todas las variaciones.';
          }
        } else {
          mlOp(t, `price:${v.id}`, `Precio de ${name}: ${money(prev.ml.price)} → ${money(v.ml.price)}`, { ...varPayload, price: v.ml.price });
        }
      }
      if (!same(prev.ml.pictureIds, v.ml.pictureIds)) mlOp(t, `pictures:${v.id}`, `Fotos de ${name}`, { ...varPayload, image_ids: v.ml.pictureIds });
      // En una ficha de User Products el título lo arma ML: un PUT con `title` da 400.
      if (d.ml.mappingMode === 'one_per_variant' && mlFormat(t) !== 'up' && variantTitle(b, 'ml', prev) !== variantTitle(d, 'ml', v)) {
        mlOp(t, `title:${v.id}`, `Cambiar el título de ${name}`, { title: variantTitle(d, 'ml', v) });
      }
    }
    if (ref.tn) {
      const t = ref.tn.productId;
      const multi = tnMulti(t);
      const varPayload = { variantId: ref.tn.variantId };
      // Solo los campos que cambiaron: cambiar el SKU no reescribe el nombre ni el código de barras.
      const fields = [];
      const names = [];
      if (!same(prev.values, v.values) && multi) { fields.push('values'); names.push('nombre'); }
      if (norm(prev.sku) !== norm(v.sku)) { fields.push('sku'); names.push('SKU'); }
      if (norm(prev.barcode) !== norm(v.barcode)) { fields.push('barcode'); names.push('código de barras'); }
      if (fields.length) tnOp(t, `variant:${v.id}`, `Cambiar ${names.join(', ')} de ${name}`, { ...varPayload, fields, values: v.values, sku: v.sku, barcode: v.barcode });
      if (!same(prev.stock, v.stock)) tnOp(t, `stock:${v.id}`, `Stock de ${name}: ${prev.stock ?? '—'} → ${v.stock ?? '—'}`, { ...varPayload, stock: v.stock });
      if (!same(prev.tn.price, v.tn.price)) tnOp(t, `price:${v.id}`, `Precio de ${name}: ${money(prev.tn.price)} → ${money(v.tn.price)}`, { ...varPayload, price: v.tn.price });
      // En un producto con varias variantes las fotos son del producto: a la variante se le elige una.
      if (!same(prev.tn.imageIds, v.tn.imageIds)) tnOp(t, `images:${v.id}`, `Fotos de ${name}`, { ...varPayload, image_ids: v.tn.imageIds, multiVariant: multi });
      if (d.tn.mappingMode === 'one_per_variant' && variantTitle(b, 'tn', prev) !== variantTitle(d, 'tn', v)) {
        if (!multi) tnOp(t, `name:${v.id}`, `Cambiar el nombre de ${name}`, { name: { es: variantTitle(d, 'tn', v) } });
        else if (!tnRenamed.has(String(t))) {
          tnRenamed.add(String(t));
          tnOp(t, 'name', `Cambiar el nombre del producto de ${name}`, { name: { es: variantTitle(d, 'tn', v) } },
            `Este producto de Tienda Nube tiene ${tnVariantCount.get(String(t))} variantes: el nombre es del producto entero.`);
        }
      }
    }
  }

  // Variantes que estaban y se quitaron. En TN se borra el producto solo si no le queda ninguna.
  const tnStays = (pid) =>
    (d.variants || []).some((v) => (bById.has(v.id) ? tnPid(v.id) === pid : tnAddTarget && String(tnAddTarget.productId) === pid));
  const tnDeleted = new Set();
  for (const prev of b.variants || []) {
    if (dById.has(prev.id) || reAddedOld.has(prev.id)) continue;
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
      const pid = String(ref.tn.productId);
      if (tnStays(pid)) tnOp(pid, `delete_variant:${prev.id}`, `Eliminar la variante ${name}`, { variantId: ref.tn.variantId });
      else if (!tnDeleted.has(pid)) {
        tnDeleted.add(pid);
        tnOp(pid, 'delete_product', tnMulti(pid) ? `Eliminar el producto de ${name} (se quitaron todas sus variantes)` : `Eliminar el producto ${name}`, {});
      }
    }
  }

  return ops;
}

/** Resumen corto para la lista: { total, ml, tn }. */
export function summarizeOps(ops) {
  return { total: ops.length, ml: ops.filter((o) => o.channel === 'ml').length, tn: ops.filter((o) => o.channel === 'tn').length };
}
