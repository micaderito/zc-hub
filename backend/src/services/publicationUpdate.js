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
import { enqueueMlTask, getMlTaskStatus } from '../db.js';
import { isUserProductSeller } from '../lib/mlUserProducts.js';
import { getImage, getImageUrl } from './imageStore.js';
import { plainTextToHtml, toMlPlainText } from '../lib/richText.js';
import { packageAttributes, withUnitsPerPack } from './productPublish.js';
import { refreshMlItemInSnapshot, refreshTnProductInSnapshot } from './conflictsService.js';
import { setTnStockManual, setTnPriceManual } from './tnManualWrites.js';

const ML_NA = '-1';
/** Cuánto espera cada cambio de stock/precio/SKU a que la Cola ML lo aplique antes de dar el resultado. */
const ML_TASK_WAIT_MS = 45 * 1000;
const ML_TASK_POLL_MS = 1000;
const ML_TASK_MAX_ATTEMPTS = 5; // mismo tope que claimNextMlTask
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  const text = String(a.value ?? '').trim();
  if (!text) return { id: a.id, value_id: null, value_name: null };
  return { id: a.id, value_name: numberText(text, catAttr) };
}

/**
 * Un número como lo acepta ML en un `POST`/`PUT`: punto decimal y, en un `number_unit`, con unidad
 * ("0,5" → "0.5 mm"). El panel y el `GET` pueden mostrarlo con coma, y con coma ML contesta
 * "El valor que ingresaste en X es incorrecto". Un texto que no es un número pasa tal cual.
 */
function numberText(text, catAttr) {
  const type = catAttr?.value_type;
  if (type !== 'number_unit' && type !== 'number') return text;
  const m = String(text).trim().match(/^(\d+(?:[.,]\d+)?)\s*(\S*)$/);
  if (!m) return text;
  const num = m[1].replace(',', '.');
  if (type === 'number') return num;
  const unit = m[2] || catAttr.default_unit?.id || catAttr.default_unit || catAttr.allowed_units?.[0]?.id;
  return unit ? `${num} ${unit}` : num;
}

/** Atributos de un ítem: los que ya tenía, con los cambios del borrador encima. Sin los de solo lectura. */
async function mergedMlAttributes(ctx, item, op) {
  const cat = await ctx.categoryAttrs(item.category_id);
  const isReadOnly = (id) => {
    const tags = cat.get(id)?.tags || {};
    return !!(tags.read_only || tags.fixed || tags.inferred);
  };
  const out = new Map();
  // ML NO hace merge: un PUT de `attributes` tiene que llevar también los que ya tenía el ítem o se
  // pierden (doc de Atributos). Uno con varios valores va solo con su `id`, que ML conserva tal cual
  // (reenviarlo con el valor de arriba le borraría los demás).
  for (const a of item.attributes || []) {
    if (!a.id || isReadOnly(a.id) || a.id === 'SELLER_SKU') continue;
    if ((a.values || []).length > 1) out.set(a.id, { id: a.id });
    else {
      const v = itemAttrValue(a, cat.get(a.id));
      if (v) out.set(a.id, v);
    }
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
  // Una variación que no está en el borrador (se borra en este mismo guardado, después) sigue en el
  // ítem hasta entonces: sus fotos tienen que seguir en la galería o ML rechaza el PUT.
  for (const v of item.variations || []) {
    if (overrides[String(v.id)]) continue;
    for (const id of v.picture_ids || []) if (!gallery.includes(String(id))) gallery.push(String(id));
  }
  await ml.updateItem(ctx.token, itemId, { pictures: gallery.map((id) => ({ id })), variations: ml.mlVariationsBody(item, overrides) });
  ctx.picturesSynced.add(itemId);
  ctx.forget(itemId);
  return `${gallery.length} fotos`;
}

const axisCombination = (axes, values) =>
  (axes || []).map((ax, i) => (ax.mlAttributeId ? { id: ax.mlAttributeId, value_name: values[i] } : { name: ax.name, value_name: values[i] }));

/**
 * Un atributo (o `sale_term`) leído de `GET /items`, tal cual lo tiene la publicación, para
 * mandarlo en un `POST`/`PUT /items`: con su `value_id` Y su `value_name`. El id solo no alcanza (un
 * valor propio de la cuenta: "Value name of attribute DESIGN was not provided and couldn't be
 * resolved") y el texto solo tampoco (ML rechazó "1-5mm" en "Grosor del trazo", que con su id sí
 * acepta): con los dos, ML usa el valor que ya conoce. Un multivalor (chips) va con todos sus
 * valores en `values`. Sin id, un número sale de `value_struct` (ver numberText).
 * `null` = no tiene valor: no se manda.
 */
function itemAttrValue(a, catAttr) {
  if (String(a.value_id ?? '') === ML_NA) return { id: a.id, value_id: ML_NA, value_name: null };
  const values = (a.values || []).filter((x) => x?.id != null || String(x?.name ?? '').trim());
  if (values.length > 1) {
    return { id: a.id, values: values.map((x) => ({ ...(x.id != null ? { id: String(x.id) } : {}), name: x.name ?? null })) };
  }
  const raw = a.value_name != null && String(a.value_name).trim() ? String(a.value_name) : null;
  if (a.value_id != null && a.value_id !== '') return { id: a.id, value_id: String(a.value_id), ...(raw ? { value_name: raw } : {}) };
  const st = a.value_struct;
  const name = st?.number != null ? `${st.number}${st.unit ? ` ${st.unit}` : ''}` : raw;
  return name ? { id: a.id, value_name: numberText(name, catAttr) } : null;
}

/** El valor de un atributo del ítem como lo muestra el form (los chips, separados por coma). */
function itemAttrText(a) {
  if (String(a.value_id ?? '') === ML_NA) return ML_NA;
  const names = (a.values || []).map((x) => String(x?.name ?? '').trim()).filter(Boolean);
  return (names.length > 1 ? names.join(',') : String(a.value_name ?? '')).trim().toLowerCase();
}

/** Modo de envío del ítem nuevo: el del form (el mismo que usa Crear producto); `me1` la cuenta no lo tiene. */
function shippingMode(d, sibling) {
  const mode = d.ml?.shippingMode || sibling.shipping?.mode;
  return mode === 'custom' || mode === 'not_specified' ? mode : 'me2';
}

/** Body de POST /items para una variante nueva, copiando lo que no es de la variante de un ítem hermano. */
async function newItemBody(ctx, p, v) {
  const d = ctx.payload.draft;
  const refItems = ctx.payload.refs.ml.items || [];
  const sibling = await ctx.item(refItems[0].itemId);
  const cat = await ctx.categoryAttrs(sibling.category_id);
  const axisIds = new Set((d.axes || []).map((ax) => ax.mlAttributeId).filter(Boolean));
  const skip = new Set(['SELLER_SKU', 'GTIN', ...axisIds]);
  const isReadOnly = (id) => {
    const tags = cat.get(id)?.tags || {};
    return !!(tags.read_only || tags.fixed || tags.inferred);
  };
  const byId = new Map();
  // Base: lo que tiene el hermano, tal cual (incluye lo que el form no muestra). Encima, lo que la
  // usuaria cambió en el form en esta misma edición (a los hermanos les llega por su propia
  // operación, no antes de que se cree este ítem).
  const siblingAttrs = new Map();
  for (const a of sibling.attributes || []) {
    if (!a.id || skip.has(a.id) || isReadOnly(a.id)) continue;
    siblingAttrs.set(a.id, a);
    const val = itemAttrValue(a, cat.get(a.id));
    if (val) byId.set(a.id, val);
  }
  for (const a of d.ml.attributes || []) {
    if (!a.id || skip.has(a.id) || isReadOnly(a.id)) continue;
    // Sin tocar en el form (mismo valor que el hermano): queda como lo tiene el hermano, con sus ids.
    const prev = siblingAttrs.get(a.id);
    const text = a.notApplicable ? ML_NA : String(a.value ?? '').trim().toLowerCase();
    if (prev && !a.removed && text === itemAttrText(prev)) continue;
    const val = mlAttrValue(a, cat.get(a.id));
    if (val.value_id == null && val.value_name == null) byId.delete(a.id);
    else byId.set(a.id, val);
  }
  if (d.common?.brand) byId.set('BRAND', { id: 'BRAND', value_name: d.common.brand });
  for (const a of packageAttributes(d.common || {})) byId.set(a.id, a);
  const attributes = [...byId.values()];
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
    listing_type_id: d.ml.listingType || sibling.listing_type_id,
    condition: sibling.condition,
    pictures,
    attributes: withUnitsPerPack(attributes),
    sale_terms: (sibling.sale_terms || []).map((t) => itemAttrValue(t, null)).filter(Boolean),
    shipping: { mode: shippingMode(d, sibling), free_shipping: !!sibling.shipping?.free_shipping, local_pick_up: !!sibling.shipping?.local_pick_up },
  };
  // User Products: ML rechaza `title` y agrupa por `family_name` (ver CLAUDE.md). Si el grupo es UNA
  // ficha, el ítem nuevo entra a esa familia; si son ítems sueltos, arma la suya con su título.
  const families = new Set(refItems.map((x) => x.familyName || (x.itemId === sibling.id ? sibling.family_name : null)));
  const oneFamily = families.size === 1 && !families.has(null) && !families.has(undefined);
  if (oneFamily) body.family_name = [...families][0];
  else if (await isUserProductSeller(ctx.token)) body.family_name = p.title;
  else body.title = p.title;
  return body;
}

const normName = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

/** Nombres de las características que ML rechazó por valor ("El valor que ingresaste en "X" es incorrecto"). */
const rejectedAttrNames = (msg) =>
  [...String(msg || '').matchAll(/ingresaste en ["“']([^"”']+)["”'] es incorrecto/gi)].map((m) => normName(m[1]));

/**
 * El MISMO valor de una característica escrito de las formas que ML puede esperar, empezando por
 * la que ya se mandó. ML devuelve igual un texto libre cargado como un único texto, como una lista
 * de valores (los chips) o con la unidad pegada/separada, pero en un alta valida uno solo de esos
 * formatos según el dominio, y no lo informa.
 */
function attrEncodings(a) {
  const names = a.values?.length ? a.values.map((x) => String(x.name ?? '')).filter(Boolean) : a.value_name != null ? [String(a.value_name)] : [];
  const text = names.join(',');
  const out = [a];
  if (a.value_id != null && a.value_id !== ML_NA && text) out.push({ id: a.id, value_name: text });
  if (names.length) out.push({ id: a.id, values: names.map((name) => ({ name })) });
  for (const t of [text.replace(/(\d)\s*([^\d\s,.-]+)(?=,|$)/g, '$1 $2'), text.replace(/(\d)\s+([^\d\s,.-]+)(?=,|$)/g, '$1$2')]) {
    if (t && t !== text) out.push({ id: a.id, value_name: t });
  }
  const seen = new Set();
  return out.filter((x) => {
    const k = JSON.stringify(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** El valor de un atributo de ML como texto (uno o varios, separados por coma). */
const attrValueText = (a) => (a?.values?.length ? a.values.map((x) => x?.name).filter(Boolean).join(', ') : a?.value_name ?? '');

/**
 * Por qué ML rechaza una característica cuyo texto es válido para la ficha técnica. Todo con
 * `POST /items/validate` (no crea nada) y lecturas; cada paso queda en los logs. Distingue:
 * - sin la característica ML acepta el ítem y con otro valor también → choca ESTE valor;
 * - sin ella acepta pero con otro valor tampoco → ML no deja cargarla en este producto;
 * y busca en el catálogo de ML el producto de esa marca/modelo/variante para ver qué valor tiene
 * (una publicación nueva se asocia al catálogo y ML rechaza lo que lo contradice).
 * Devuelve una frase para el error.
 */
async function diagnoseRejectedAttr(ctx, body, a, name) {
  const notes = [];
  const without = { ...body, attributes: body.attributes.filter((x) => x.id !== a.id) };
  const other = { ...body, attributes: body.attributes.map((x) => (x.id === a.id ? { id: a.id, value_name: '1 mm' } : x)) };
  try {
    const rWithout = await ml.validateItem(ctx.token, without);
    const rOther = await ml.validateItem(ctx.token, other);
    console.log('[Edit] diagnóstico "%s": sin la característica → %s · con "1 mm" → %s', name, rWithout.ok ? 'ok' : rWithout.error, rOther.ok ? 'ok' : rOther.error);
    const rejectedOther = !rOther.ok && rejectedAttrNames(rOther.error).includes(normName(name));
    if (rWithout.ok && rejectedOther) notes.push(`ML rechaza cualquier valor de "${name}" en esta publicación (sin la característica sí la acepta).`);
    else if (rWithout.ok && !rejectedOther) notes.push(`ML acepta otros valores de "${name}", no este.`);
    else if (!rWithout.ok) notes.push(`Sin "${name}" ML tampoco la acepta: ${rWithout.error}`);
  } catch (e) {
    console.warn('[Edit] diagnóstico: no se pudo validar:', e.message);
  }
  try {
    const val = (id) => attrValueText(body.attributes.find((x) => x.id === id));
    const axisIds = new Set((ctx.payload.draft.axes || []).map((ax) => ax.mlAttributeId).filter(Boolean));
    const q = [val('BRAND'), val('MODEL'), ...[...axisIds].map(val)].filter(Boolean).join(' ');
    const found = q ? await ml.searchCatalogProducts(ctx.token, q) : null;
    const results = (found?.results || []).slice(0, 3);
    const lines = results.map((r) => `${r.name || r.id} (${r.id}): ${attrValueText((r.attributes || []).find((x) => x.id === a.id)) || 'sin dato'}`);
    console.log('[Edit] diagnóstico "%s": catálogo de ML para "%s" → %s', name, q, lines.length ? lines.join(' | ') : 'sin resultados');
    const withValue = results.map((r) => attrValueText((r.attributes || []).find((x) => x.id === a.id))).filter(Boolean);
    if (withValue.length) notes.push(`En el catálogo de ML "${results[0].name || results[0].id}" tiene "${name}" = "${withValue[0]}".`);
  } catch (e) {
    console.warn('[Edit] diagnóstico: no se pudo buscar en el catálogo:', e.message);
  }
  return notes.join(' ');
}

/**
 * `POST /items` del ítem nuevo. Si ML rechaza el valor de una característica copiada ("El valor que
 * ingresaste en "Grosor del trazo" es incorrecto"), no se saca ni se cambia el valor: se prueba ESE
 * valor en los otros formatos (attrEncodings) con `POST /items/validate`, que no crea nada, y se crea
 * con el que ML acepte. Si no acepta ninguno, el error lista qué se probó y qué contestó ML.
 */
async function createItemExplained(ctx, body) {
  let first;
  try {
    return await ml.createItem(ctx.token, body);
  } catch (e) {
    first = e;
  }
  const names = rejectedAttrNames(first.message);
  if (!names.length) throw first;
  const cat = await ctx.categoryAttrs(body.category_id);
  const nameOf = (a) => cat.get(a.id)?.name || a.name || a.id;
  const show = (a) => JSON.stringify(Object.fromEntries(Object.entries(a).filter(([k]) => k !== 'id')));
  let attributes = body.attributes;
  const unresolved = [];
  const rejectedAttrs = body.attributes.filter((x) => names.includes(normName(nameOf(x))));
  for (const a of rejectedAttrs) {
    const tried = [show(a)];
    let chosen = null;
    for (const alt of attrEncodings(a).slice(1)) {
      const candidate = attributes.map((x) => (x.id === a.id ? alt : x));
      const r = await ml.validateItem(ctx.token, { ...body, attributes: candidate });
      const stillRejected = !r.ok && rejectedAttrNames(r.error).includes(normName(nameOf(a)));
      console.log('[Edit] validar "%s" como %s → %s', nameOf(a), show(alt), r.ok ? 'ok' : r.error);
      if (!stillRejected) {
        chosen = alt;
        break;
      }
      tried.push(show(alt));
    }
    if (chosen) attributes = attributes.map((x) => (x.id === a.id ? chosen : x));
    else unresolved.push(`"${nameOf(a)}" (se probó ${tried.join(' · ')})`);
  }
  if (unresolved.length) {
    const notes = [];
    for (const a of rejectedAttrs) notes.push(await diagnoseRejectedAttr(ctx, body, a, nameOf(a)));
    throw Object.assign(new Error(`${first.message} ML no aceptó el valor en ningún formato: ${unresolved.join('; ')}. ${notes.join(' ')}`.replace(/\s+/g, ' ').trim()), { mlStatus: first.mlStatus });
  }
  return ml.createItem(ctx.token, { ...body, attributes });
}

/** Espera a que la Cola ML aplique una tarea (o la dé por fallada) hasta `ML_TASK_WAIT_MS`. */
async function waitForMlTask(taskId) {
  const start = Date.now();
  for (;;) {
    const t = await getMlTaskStatus(taskId);
    if (!t || t.status === 'done') return t;
    if ((t.status === 'failed' || t.status === 'processing') && Number(t.attempts) >= ML_TASK_MAX_ATTEMPTS) return t;
    if (Date.now() - start >= ML_TASK_WAIT_MS) return t;
    await sleep(ML_TASK_POLL_MS);
  }
}

/** Resultado de un cambio que fue por la Cola ML: "ok" solo si la cola lo aplicó (o sigue en curso, avisado). */
function queuedResult(taskId, t) {
  if (t?.status === 'done') return { detail: `Aplicado por la Cola ML (#${taskId})` };
  if (t && Number(t.attempts) >= ML_TASK_MAX_ATTEMPTS && t.status !== 'pending') {
    throw new Error(`La Cola ML no pudo aplicarlo (#${taskId})${t.lastError ? `: ${t.lastError}` : ''}. Se puede reintentar desde Cola ML.`);
  }
  const why = t?.lastError ? `, reintentando: ${t.lastError}` : '';
  return { detail: `Sigue en la Cola ML (#${taskId}${why}): el resultado se ve en Cola ML` };
}

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
      // Solo viene el dato que cambió; el otro queda como lo tiene el ítem.
      const item = await ctx.item(itemId, { fresh: true });
      const cur = item.shipping || {};
      const res = await ml.updateItem(ctx.token, itemId, {
        shipping: {
          mode: cur.mode,
          free_shipping: p.free_shipping !== undefined ? !!p.free_shipping : !!cur.free_shipping,
          local_pick_up: p.local_pick_up !== undefined ? !!p.local_pick_up : !!cur.local_pick_up,
        },
      });
      ctx.forget(itemId);
      // ML ignora en silencio sacar el envío gratis cuando es obligatorio por precio: se mira el ítem
      // que devuelve el PUT (si no vino, no hay con qué comparar).
      const after = res?.shipping;
      if (!after) return {};
      const missed = [];
      if (p.free_shipping !== undefined && !!after.free_shipping !== !!p.free_shipping) missed.push('envío gratis');
      if (p.local_pick_up !== undefined && !!after.local_pick_up !== !!p.local_pick_up) missed.push('retiro en persona');
      if (missed.length) {
        const mandatory = [...(res.tags || []), ...(after.tags || []), ...(item.tags || [])].includes('mandatory_free_shipping');
        throw new Error(`ML no cambió ${missed.join(' ni ')}${mandatory && missed.includes('envío gratis') ? ': por su precio el envío gratis es obligatorio' : ''}.`);
      }
      return {};
    }
    case 'warranty': {
      // Un sale_term se borra mandando value_id y value_name en null (doc de ML); sin eso, "Sin
      // garantía" dejaba el tiempo de la garantía anterior.
      const time = String(p.time ?? '').trim();
      const sale_terms = [
        { id: 'WARRANTY_TYPE', value_name: p.type },
        p.type !== 'Sin garantía' && time ? { id: 'WARRANTY_TIME', value_name: time } : { id: 'WARRANTY_TIME', value_id: null, value_name: null },
      ];
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
      if (!p.variationId) {
        // Ítem de una ficha (User Products) o suelto: no tiene `variations`; el valor de la variante
        // es un atributo del propio ítem (ej. COLOR).
        const attributes = (p.axes || [])
          .map((ax, i) => (ax.mlAttributeId ? { id: ax.mlAttributeId, value: p.values?.[i] ?? '' } : null))
          .filter(Boolean);
        if (!attributes.length) throw new Error('Esta publicación no tiene un atributo de ML para la variante: cambiá su título en su lugar.');
        await ml.updateItem(ctx.token, itemId, { attributes: await mergedMlAttributes(ctx, item, { payload: { attributes } }) });
        ctx.forget(itemId);
        return {};
      }
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
      return queuedResult(taskId, await waitForMlTask(taskId));
    }
    case 'add_variation': {
      const v = p.variant;
      let item = await ctx.item(itemId, { fresh: true });
      // Sin SKU no hay cómo reconocer una ya creada (se adoptaría cualquiera sin SKU).
      const existing = v.sku ? (item.variations || []).find((x) => attrText(x.attributes, 'SELLER_SKU') === v.sku) : null;
      if (existing) {
        // Un intento anterior la creó pero se cortó antes de la foto: se completa.
        const photo = (v.tn?.imageIds || [])[0];
        if (photo && existing.image_id == null) await setTnVariantImage(ctx, productId, existing.id, photo);
        return { externalId: String(existing.id), detail: 'Ya existía: se usó la que estaba' };
      }
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
      const known = new Set((ctx.payload.refs.ml.items || []).map((x) => x.itemId));
      // Idempotencia: si ya hay una publicación con este SKU (un intento anterior que ML creó aunque
      // respondió con error o se cortó), se adopta en vez de duplicarla.
      const findExisting = async () => {
        const ids = await ml.findItemIdsBySellerSku(ctx.token, tokens.mercadolibre?.user_id, v.sku);
        if (ids === null) return null;
        return { id: ids.find((id) => !known.has(id)) || '' };
      };
      let found = v.sku ? await findExisting() : { id: '' };
      if (!found) throw new Error('No pudimos consultar en Mercado Libre si la publicación ya existe; reintentá en un rato (así no se duplica).');
      let itemIdNew = found.id;
      const adopted = !!itemIdNew;
      if (!itemIdNew) {
        const body = await newItemBody(ctx, p, v);
        try {
          const created = await createItemExplained(ctx, body);
          itemIdNew = created?.id || '';
        } catch (e) {
          // ML a veces crea el ítem y contesta con error: antes de dar por fallado, se busca.
          await sleep(2000);
          found = v.sku ? await findExisting() : null;
          if (!found?.id) throw e;
          itemIdNew = found.id;
        }
      }
      if (!itemIdNew) throw new Error('Mercado Libre no devolvió el id de la publicación creada.');
      ctx.touched.add(itemIdNew);
      const desc = effective(d.ml.description, '');
      if (desc.trim()) {
        const r = await ml.setItemDescription(ctx.token, itemIdNew, toMlPlainText(desc));
        if (!r.ok) throw new Error(`Se creó la publicación ${itemIdNew}, pero ML no aceptó la descripción (${r.error}). Reintentá: no se duplica.`);
      }
      return { externalId: itemIdNew, detail: adopted ? 'Ya existía: se usó la que estaba' : undefined };
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

/**
 * Foto de una variante en un producto de TN con varias variantes: TN admite UNA por variante y tiene
 * que estar en la galería del producto (que es de todas sus variantes: no se borra ninguna).
 */
async function setTnVariantImage(ctx, productId, variantId, imageId) {
  const product = await ctx.product(productId, { fresh: true });
  const gallery = (product.images || []).map((img) => `tn-${img.id}`);
  if (!gallery.includes(imageId)) gallery.push(imageId);
  const finalIds = await syncTnImages(ctx, productId, gallery);
  await tn.updateVariantImage(ctx.token, ctx.storeId, productId, variantId, Number(finalIds[gallery.indexOf(imageId)]));
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
      // Solo los campos que vienen (los que cambiaron) y nunca un null: cada variante conserva lo demás.
      const body = {};
      for (const k of ['weight', 'height', 'width', 'depth', 'mpn', 'age_group', 'gender']) if (p[k] != null && p[k] !== '') body[k] = p[k];
      if (!Object.keys(body).length) return { detail: 'Nada que cambiar' };
      for (const v of product.variants || []) await tn.updateVariant(ctx.token, ctx.storeId, productId, v.id, body);
      ctx.forget(productId);
      return { detail: `${(product.variants || []).length} variantes` };
    }
    case 'images': {
      const ids = p.image_ids || [];
      if (p.variantId != null && (p.multiVariant || d.tn.mappingMode === 'single_with_variants')) {
        // Producto con variantes: TN admite UNA foto por variante (la primera elegida). Las fotos del
        // producto son de todas sus variantes: no se borra ninguna.
        if (!ids.length) return { detail: 'Sin foto elegida: no se cambia' };
        await setTnVariantImage(ctx, productId, p.variantId, ids[0]);
        return {};
      }
      const finalIds = await syncTnImages(ctx, productId, ids);
      return { detail: `${finalIds.length} fotos` };
    }
    case 'variant': {
      const product = await ctx.product(productId);
      // Solo lo que cambió (`fields`); una operación vieja sin `fields` manda lo de antes.
      const f = p.fields ? new Set(p.fields) : new Set(['sku', 'barcode', 'values']);
      const body = {};
      if (f.has('sku')) body.sku = p.sku;
      if (f.has('barcode')) body.barcode = p.barcode || '';
      if (f.has('values') && (product.attributes || []).length) body.values = (p.values || []).map((value) => ({ es: value }));
      if (!Object.keys(body).length) return { detail: 'Nada que cambiar' };
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
      const existing = v.sku ? (product.variants || []).find((x) => String(x.sku || '').trim() === v.sku) : null;
      if (existing) return { externalId: String(existing.id), detail: 'Ya existía: se usó la que estaba' };
      const created = await tn.createVariant(ctx.token, ctx.storeId, productId, {
        ...tnVariantBody(d, v),
        values: (v.values || []).map((value) => ({ es: value })),
      });
      ctx.forget(productId);
      const variantId = created?.id != null ? String(created.id) : null;
      // Sin foto propia TN le muestra la portada del producto: se le pone la que se eligió.
      const photo = (v.tn?.imageIds || [])[0];
      if (variantId && photo) {
        try {
          await setTnVariantImage(ctx, productId, variantId, photo);
        } catch (e) {
          throw new Error(`Se creó la variante (${variantId}), pero no se le pudo poner la foto: ${e.message}. Reintentá: no se duplica.`);
        }
      }
      return { externalId: variantId };
    }
    case 'create_product': {
      const v = p.variant;
      const existing = v.sku ? await tn.findProductBySku(ctx.token, ctx.storeId, v.sku) : null;
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
