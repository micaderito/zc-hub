import { Router } from 'express';
import express from 'express';
import crypto from 'crypto';
import { tokens, getMlToken } from '../store.js';
import * as ml from '../lib/mercadolibre.js';
import * as tn from '../lib/tiendanube.js';
import { publishProduct } from '../services/productPublish.js';
import { saveImage, saveImageBuffer, saveThumbBuffer, getImage, getThumb, removeImage } from '../services/imageStore.js';
import { generateSeo, isLlmConfigured } from '../lib/llm.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { listPacksWithStock, savePack, removePack, assignSkuPack } from '../services/packsService.js';
import {
  createProductDraft,
  updateProductDraft,
  setProductDraftStatus,
  getProductDraft,
  listProductDrafts,
  deleteProductDraft,
  createPublishJob,
  getPublishJob,
  listPublishJobsForDraft,
  deletePublishJob,
  retryPublishJob,
  getPublishUnits
} from '../db.js';

export const productRoutes = Router();

// Todo el router exige sesión, EXCEPTO los GET de imagen (`/images/:id` y `/images/:id/thumb`):
// se usan como <img src> en el front (crear-producto) y una etiqueta <img> no puede mandar el
// header Authorization. Los ids son aleatorios y de vida corta (services/imageStore.js) — se deja
// abierto a propósito. Ojo: el POST del thumb NO entra acá, sigue exigiendo sesión.
const PUBLIC_IMAGE_GET = /^\/images\/[^/]+(\/thumb)?$/;
productRoutes.use((req, res, next) => {
  if (req.method === 'GET' && PUBLIC_IMAGE_GET.test(req.path)) return next();
  return requireAuth(req, res, next);
});

/** Sitio de ML de la cuenta (Argentina). Si algún día se opera en otro país, parametrizar. */
const ML_SITE = 'MLA';

/**
 * Límite saneado: el 0 que ML devuelve en categorías mal configuradas NO es un límite real, y
 * `??` no lo atrapa. Con ese 0 llegando al front, la guarda `length >= limite` daba `0 >= 0` y
 * bloqueaba en silencio toda selección de fotos por variación.
 */
const positiveOr = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : fallback);

/**
 * Atributos de categoría que NO se le piden al usuario porque ya los completamos nosotros
 * (desde los datos comunes) o los llena ML solo. Evita pedir dos veces lo mismo.
 */
const ML_AUTO_FILLED_ATTRS = new Set([
  'SELLER_SKU', // sale del SKU
  'GTIN', 'EMPTY_GTIN_REASON', // código universal → va en el común (código de barras)
  'LENGTH', 'WIDTH', 'HEIGHT', 'DEPTH', 'WEIGHT', // medidas → van en "Peso y dimensiones"
  'VALUE_ADDED_TAX', 'INTERNAL_TAX', 'IMPORT_DUTY' // IVA / impuesto interno → los completa ML
]);

/* ============================ Imágenes (temporales) ============================ */

/**
 * Sube UNA imagen al store temporal del backend y devuelve su id. El front sube cada foto a
 * medida que la elige (varias en paralelo), guarda solo el id en el draft, y al publicar el
 * backend lee la imagen de acá y la sube a ML/TN.
 *
 * Dos formas de mandarla, para no romper compatibilidad:
 * - Binaria (la que usa crear-producto hoy): `Content-Type: image/*` con el archivo crudo en el
 *   body y el nombre en el header `X-Image-Filename` (URL-encoded). Evita la conversión a base64
 *   (~33% más grande) y el `JSON.stringify` de ese texto en el navegador — con fotos de varios MB
 *   ese stringify sincrónico era lo que trababa la página al cargar muchas de una.
 * - JSON con base64 (`{ filename, mime, data }`): se mantiene por compatibilidad con integraciones
 *   o borradores que todavía la usen.
 */
productRoutes.post('/images', express.raw({ type: 'image/*', limit: '12mb' }), async (req, res) => {
  if (Buffer.isBuffer(req.body) && req.body.length) {
    const filenameHeader = req.headers['x-image-filename'];
    let filename;
    try {
      filename = filenameHeader ? decodeURIComponent(String(filenameHeader)) : undefined;
    } catch {
      filename = String(filenameHeader);
    }
    try {
      const saved = await saveImageBuffer({ filename, mime: req.headers['content-type'], buffer: req.body });
      return res.json(saved);
    } catch (e) {
      return res.status(e.statusCode || 500).json({ error: e.message });
    }
  }
  const { filename, mime, data } = req.body || {};
  if (!data) return res.status(400).json({ error: 'Falta el archivo (data base64)' });
  try {
    const saved = await saveImage({ filename, mime, data });
    res.json(saved);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

/** Sirve el binario de una imagen temporal (para la previsualización en el front). */
productRoutes.get('/images/:id', async (req, res) => {
  const img = await getImage(req.params.id);
  if (!img) return res.status(404).end();
  res.setHeader('Content-Type', img.mime);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(img.buffer);
});

/**
 * Guarda la miniatura que generó el cliente para una imagen ya subida. Body: binario `image/*`.
 * Exige sesión (a diferencia del GET). La miniatura es solo para el preview del borrador: NUNCA
 * se publica en ML ni en TN — el fan-out usa `getImage()`, el original.
 */
productRoutes.post('/images/:id/thumb', express.raw({ type: 'image/*', limit: '1mb' }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) {
    return res.status(400).json({ error: 'Falta la miniatura' });
  }
  try {
    res.json(await saveThumbBuffer(req.params.id, req.body));
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

/**
 * Sirve la miniatura de una imagen temporal. Si esa imagen todavía no tiene una (borradores
 * guardados antes de que existieran), cae al ORIGINAL: así no hay regresión, solo deja de haber
 * mejora para esos casos.
 */
productRoutes.get('/images/:id/thumb', async (req, res) => {
  const thumb = await getThumb(req.params.id);
  if (thumb) {
    res.setHeader('Content-Type', thumb.mime);
    // El contenido de un id nunca cambia, así que se puede cachear agresivo.
    res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
    return res.send(thumb.buffer);
  }
  const img = await getImage(req.params.id);
  if (!img) return res.status(404).end();
  res.setHeader('Content-Type', img.mime);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('X-Thumb', 'original');
  res.send(img.buffer);
});

/** Descarta una imagen temporal (si el usuario la saca antes de publicar). */
productRoutes.delete('/images/:id', async (req, res) => {
  await removeImage(req.params.id);
  res.json({ ok: true });
});

/**
 * Crear un producto en ambos canales (fan-out). Recibe el payload del front (crear-producto)
 * y devuelve { results: [{ channel, status, detail }] }. Cada canal es independiente: uno puede
 * salir OK y el otro fallar. Requiere estar conectado (si falta un token, ese canal reporta error).
 */
productRoutes.post('/', async (req, res) => {
  const payload = req.body;
  if (!payload || !payload.ml || !payload.tn) {
    return res.status(400).json({ error: 'Payload inválido: faltan ml/tn' });
  }
  try {
    const mlToken = await getMlToken();
    const tnToken = tokens.tiendanube?.access_token || null;
    const storeId = tokens.tiendanube?.store_id || null;
    const channels = Array.isArray(payload.channels) ? payload.channels : undefined;
    const out = await publishProduct(payload, { mlToken, tnToken, storeId, channels });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ============================ Borradores + publicación en background ============================
 * `POST /` (arriba) sigue disponible mientras dura la migración del front al flujo asíncrono, y se
 * retira cuando deje de usarse. El nuevo camino es: guardar el borrador acá (para conservar el
 * historial y poder retomarlo desde cualquier navegador), encolar la publicación como un job, y
 * consultar el progreso con polling — ver el plan en CLAUDE.md / docs/plans.
 */

/** Ids de imagen (32 hex) referenciados en un draft_json — para borrarlas del store al borrar el borrador. */
function extractImageIds(draftJson) {
  const ids = new Set();
  for (const m of String(draftJson || '').matchAll(/"([a-f0-9]{32})"/g)) ids.add(m[1]);
  return ids;
}

/** Lista de borradores para el panel "Mis borradores" (sin el draft completo — pesado para una lista). */
productRoutes.get('/drafts', async (_req, res) => {
  try {
    res.json(await listProductDrafts());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Crea un borrador nuevo. Body: { name?, sku?, draft }. */
productRoutes.post('/drafts', async (req, res) => {
  const { name, sku, draft } = req.body || {};
  if (!draft) return res.status(400).json({ error: 'Falta "draft"' });
  const id = crypto.randomBytes(12).toString('hex');
  try {
    const created = await createProductDraft({ id, name, sku, draftJson: JSON.stringify(draft) });
    if (!created) return res.status(500).json({ error: 'No se pudo guardar el borrador' });
    res.status(201).json({ id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Un borrador con su historial de publicaciones (jobs), para reabrirlo y ver qué pasó. */
productRoutes.get('/drafts/:id', async (req, res) => {
  try {
    const draft = await getProductDraft(req.params.id);
    if (!draft) return res.status(404).json({ error: 'Borrador no encontrado' });
    const jobs = await listPublishJobsForDraft(req.params.id);
    res.json({ ...draft, jobs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Guarda cambios de un borrador (autosave). Body: { name?, sku?, draft }. */
productRoutes.put('/drafts/:id', async (req, res) => {
  const { name, sku, draft } = req.body || {};
  if (!draft) return res.status(400).json({ error: 'Falta "draft"' });
  try {
    const ok = await updateProductDraft(req.params.id, { name, sku, draftJson: JSON.stringify(draft) });
    if (!ok) return res.status(404).json({ error: 'Borrador no encontrado' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Borra un borrador (en cascada, sus jobs/unidades) y las imágenes que tenía en el store. */
productRoutes.delete('/drafts/:id', async (req, res) => {
  try {
    const draft = await getProductDraft(req.params.id);
    const ok = await deleteProductDraft(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Borrador no encontrado' });
    if (draft) {
      for (const imageId of extractImageIds(draft.draftJson)) {
        await removeImage(imageId).catch(() => {});
      }
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Encola la publicación de un borrador (reemplaza el POST síncrono de arriba). Body: { payload,
 * channels? } — `payload` es el mismo body que ya arma buildPayloads() en el front. El worker
 * (services/publishWorker.js) lo procesa en background; el front hace polling de
 * GET /jobs/:id hasta que termine.
 */
productRoutes.post('/drafts/:id/publish', async (req, res) => {
  const { payload, channels } = req.body || {};
  if (!payload || !payload.ml || !payload.tn) {
    return res.status(400).json({ error: 'Payload inválido: faltan ml/tn' });
  }
  const draft = await getProductDraft(req.params.id);
  if (!draft) return res.status(404).json({ error: 'Borrador no encontrado' });
  const jobId = crypto.randomBytes(12).toString('hex');
  const channelsStr = Array.isArray(channels) && channels.length ? channels.join(',') : 'ml,tn';
  try {
    const created = await createPublishJob({ id: jobId, draftId: req.params.id, channels: channelsStr, payloadJson: JSON.stringify(payload) });
    if (!created) return res.status(500).json({ error: 'No se pudo encolar la publicación' });
    await setProductDraftStatus(req.params.id, 'publishing');
    res.status(202).json({ jobId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Progreso de un job: su estado + el detalle de cada unidad publicada. Para polling desde el front. */
productRoutes.get('/jobs/:id', async (req, res) => {
  try {
    const job = await getPublishJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job no encontrado' });
    const units = await getPublishUnits(req.params.id);
    res.json({ job, units });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Reintenta un job (solo si quedó 'error', o 'processing' con lock vencido). No duplica lo ya creado. */
productRoutes.post('/jobs/:id/retry', async (req, res) => {
  try {
    const ok = await retryPublishJob(req.params.id);
    if (!ok) return res.status(409).json({ error: 'El job no está en un estado reintentable' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Borra una entrada del historial de publicación (ej. "ya está todo bien, no lo quiero ver más"). */
productRoutes.delete('/jobs/:id', async (req, res) => {
  try {
    const ok = await deletePublishJob(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Job no encontrado' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ============================ Tienda Nube ============================ */

/**
 * Categorías existentes de la tienda (para el selector al crear producto).
 * Devuelve un árbol plano normalizado: { id, name, parent, subcategories, path }.
 * `name` se resuelve al español (con fallback a otros idiomas) y `path` es el
 * breadcrumb "Padre › Hija" para mostrarlo claro en un desplegable jerárquico.
 */
productRoutes.get('/categories/tiendanube', async (_req, res) => {
  const accessToken = tokens.tiendanube?.access_token;
  const storeId = tokens.tiendanube?.store_id;
  if (!accessToken || !storeId) return res.status(401).json({ error: 'No conectado a Tienda Nube' });
  try {
    const raw = await tn.getCategories(accessToken, storeId);
    const list = (raw || []).map((c) => ({
      id: c.id,
      name: pickTnName(c.name),
      parent: c.parent ?? null,
      subcategories: Array.isArray(c.subcategories) ? c.subcategories : []
    }));
    const byId = new Map(list.map((c) => [c.id, c]));
    for (const c of list) c.path = tnCategoryPath(c, byId);
    // Orden alfabético por path para que el desplegable quede prolijo.
    list.sort((a, b) => a.path.localeCompare(b.path, 'es'));
    res.json(list);
  } catch (e) {
    if (e.status === 401) return res.status(401).json({ error: 'Token de Tienda Nube inválido' });
    res.status(500).json({ error: e.message });
  }
});

/** Nombre de categoría TN en es (fallback a pt/en/string plano). */
function pickTnName(name) {
  if (!name) return '';
  if (typeof name === 'string') return name;
  return name.es || name.pt || name.en || Object.values(name)[0] || '';
}

/** Breadcrumb "Abuelo › Padre › Hija" subiendo por `parent`. */
function tnCategoryPath(cat, byId) {
  const parts = [cat.name];
  let current = cat;
  const seen = new Set([cat.id]);
  while (current.parent != null) {
    const parent = byId.get(current.parent);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    parts.unshift(parent.name);
    current = parent;
  }
  return parts.join(' › ');
}

/* ============================ Mercado Libre ============================ */

/** Categorías raíz del sitio (punto de entrada del árbol). */
productRoutes.get('/categories/mercadolibre/roots', async (_req, res) => {
  const accessToken = await getMlToken();
  if (!accessToken) return res.status(401).json({ error: 'No conectado a Mercado Libre' });
  try {
    const roots = await ml.getSiteCategories(accessToken, ML_SITE);
    if (!roots) return res.status(502).json({ error: 'No se pudieron traer las categorías de Mercado Libre' });
    res.json(roots);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Predictor de categoría por título: ?q=texto → sugerencias de categorías HOJA.
 * Cada sugerencia trae category_id, category_name, domain y atributos pre-inferidos.
 */
productRoutes.get('/categories/mercadolibre/predict', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Falta el parámetro q (título del producto)' });
  const accessToken = await getMlToken();
  if (!accessToken) return res.status(401).json({ error: 'No conectado a Mercado Libre' });
  try {
    const preds = await ml.predictCategory(accessToken, q, ML_SITE, 5);
    res.json(preds || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Detalle de una categoría de ML: incluye `children_categories` (para navegar el árbol),
 * `path_from_root` (breadcrumb) y `leaf`/`listing_allowed` derivados para el front.
 */
productRoutes.get('/categories/mercadolibre/:id', async (req, res) => {
  const accessToken = await getMlToken();
  if (!accessToken) return res.status(401).json({ error: 'No conectado a Mercado Libre' });
  try {
    const cat = await ml.getCategory(accessToken, req.params.id);
    if (!cat) return res.status(404).json({ error: `Categoría ${req.params.id} no encontrada` });
    const children = Array.isArray(cat.children_categories) ? cat.children_categories : [];
    res.json({
      id: cat.id,
      name: cat.name,
      path_from_root: cat.path_from_root || [],
      children_categories: children,
      // Una categoría es publicable si es hoja (sin hijas) y permite listar.
      leaf: children.length === 0,
      listing_allowed: cat.settings?.listing_allowed !== false,
      // Límite de fotos por ítem y por variación (fallback 12/10 si la categoría no lo trae).
      max_pictures: positiveOr(cat.settings?.max_pictures_per_item, 12),
      max_pictures_per_var: positiveOr(cat.settings?.max_pictures_per_item_var, 10),
      settings: cat.settings || null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Atributos de una categoría de ML. Se filtran/normalizan para el front:
 * { id, name, valueType, required, conditionalRequired, allowVariations, values: [{ id, name }] }.
 * `required` combina los tags `required` y `new_required` (obligatorio para publicar un ítem nuevo).
 * `conditionalRequired` (tag `conditional_required`) es obligatorio SOLO si otro atributo está
 * completo — el caso típico es `UNITS_PER_PACK`, que ML exige apenas se manda `SALE_FORMAT`
 * ("Formato de venta": Unidad/Pack). El front lo trata como obligatorio si su disparador tiene
 * valor (ver product-draft.model: CONDITIONAL_REQUIRED_TRIGGERS). `allowVariations` marca los
 * candidatos a EJE de variante (COLOR, SIZE…) — antes se descartaban acá directamente, pero el
 * front los necesita para el selector "qué atributo de ML es este eje" (ver variants-section: sin
 * esto, ML no agrupa bien la familia de variaciones de un producto, ver CLAUDE.md).
 */
productRoutes.get('/categories/mercadolibre/:id/attributes', async (req, res) => {
  const accessToken = await getMlToken();
  if (!accessToken) return res.status(401).json({ error: 'No conectado a Mercado Libre' });
  try {
    const attrs = await ml.getCategoryAttributes(accessToken, req.params.id);
    if (!attrs) return res.status(502).json({ error: 'No se pudieron traer los atributos de la categoría' });
    const normalized = (attrs || [])
      .filter((a) => {
        const t = a.tags || {};
        // Ocultamos los internos/no editables (allow_variations YA NO se excluye acá: se ofrece
        // como candidato a eje en vez de como atributo general).
        if (t.hidden || t.read_only || t.fixed) return false;
        if (ML_AUTO_FILLED_ATTRS.has(String(a.id || ''))) return false;
        // Paquete (lo arma el backend desde peso/medidas) e impuestos (los completa ML).
        const id = String(a.id || '');
        if (id.startsWith('SELLER_PACKAGE_') || id.startsWith('PACKAGE_') || id.endsWith('_TAX')) return false;
        return true;
      })
      .map((a) => ({
        id: a.id,
        name: a.name,
        valueType: a.value_type || 'string',
        required: !!(a.tags?.required || a.tags?.new_required),
        conditionalRequired: !!a.tags?.conditional_required,
        allowVariations: !!a.tags?.allow_variations,
        relevance: Number.isFinite(a.relevance) ? a.relevance : 99,
        allowedValues: Array.isArray(a.values) ? a.values.map((v) => ({ id: v.id, name: v.name })) : [],
        allowedUnits: a.allowed_units ? a.allowed_units.map((u) => u.name || u.id) : undefined,
        defaultUnit: a.default_unit?.name || a.default_unit || undefined
      }))
      // Obligatorios primero, luego por relevancia (1 = más relevante).
      .sort((a, b) => Number(b.required) - Number(a.required) || a.relevance - b.relevance);
    res.json(normalized);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Genera SEO (título + meta descripción) con IA a partir de los datos del producto.
 * TN no expone API para sus sugerencias de SEO (son internas del panel), así que lo generamos acá.
 * POST /seo  body: { name, description?, brand?, category? } → { seoTitle, seoDescription }.
 */
productRoutes.post('/seo', async (req, res) => {
  if (!isLlmConfigured()) {
    return res.status(503).json({ error: 'Falta configurar LLM_API_KEY en el backend para generar SEO' });
  }
  const { name, description, brand, category } = req.body || {};
  try {
    const seo = await generateSeo({ name, description, brand, category });
    res.json(seo);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

/**
 * Comisiones de ML para un precio/categoría/tipo de publicación → cuánto recibe el vendedor.
 * GET /ml/listing-prices?price=&category_id=&listing_type_id=
 * Devuelve { currency_id, sale_fee_amount, listing_fee_amount, percentage_fee, net }.
 */
productRoutes.get('/ml/listing-prices', async (req, res) => {
  const accessToken = await getMlToken();
  if (!accessToken) return res.status(401).json({ error: 'No conectado a Mercado Libre' });
  const price = Number(req.query.price);
  if (!Number.isFinite(price) || price <= 0) return res.status(400).json({ error: 'price inválido' });
  const categoryId = req.query.category_id || undefined;
  const listingTypeId = req.query.listing_type_id || undefined;
  try {
    const data = await ml.getListingPrices(accessToken, { price, categoryId, listingTypeId });
    // Con listing_type_id devuelve un objeto; sin él, un array con todos los tipos.
    const entry = Array.isArray(data) ? data.find((d) => d.listing_type_id === listingTypeId) || data[0] : data;
    if (!entry) return res.status(502).json({ error: 'No se pudieron traer las comisiones de ML' });
    const saleFee = Number(entry.sale_fee_amount) || 0;
    const listingFee = Number(entry.listing_fee_amount) || 0;
    res.json({
      currency_id: entry.currency_id || 'ARS',
      sale_fee_amount: saleFee,
      listing_fee_amount: listingFee,
      percentage_fee: entry.sale_fee_details?.percentage_fee ?? null,
      // Neto = precio − comisión de venta − costo de publicar. (No incluye el costo de envío gratis.)
      net: Math.max(0, price - saleFee - listingFee)
    });
  } catch (e) {
    // getListingPrices lanza con .mlStatus cuando la API responde error.
    res.status(e.mlStatus ? 502 : 500).json({ error: e.message });
  }
});

/* ============================ Packs (fase 5) ============================ */

/** Todos los packs con sus productos, stock de hoy y umbral de alerta de cada uno. */
productRoutes.get('/packs', async (_req, res) => {
  try {
    res.json({ packs: await listPacksWithStock() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Alta de un pack. Body: { name, unitCount?, mode?, sku? } (mode: 'assorted' | 'single'; sku: código propio del pack, opcional). */
productRoutes.post('/packs', async (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name requerido' });
  try {
    const id = await savePack({ name, unitCount: req.body?.unitCount, mode: req.body?.mode, sku: req.body?.sku });
    if (!id) return res.status(500).json({ error: 'No se pudo crear el pack' });
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Edición de un pack existente. */
productRoutes.put('/packs/:id', async (req, res) => {
  const id = Number(req.params.id);
  const name = (req.body?.name || '').trim();
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
  if (!name) return res.status(400).json({ error: 'name requerido' });
  try {
    const saved = await savePack({ id, name, unitCount: req.body?.unitCount, mode: req.body?.mode, sku: req.body?.sku });
    if (!saved) return res.status(500).json({ error: 'No se pudo guardar el pack' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Borra un pack. Sus SKUs quedan "sin pack"; no toca reglas de alerta ni historial. */
productRoutes.delete('/packs/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
  try {
    await removePack(id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Mueve un SKU a un pack, o lo saca. Body: { packId: number | null }. */
productRoutes.put('/packs/sku/:sku', async (req, res) => {
  const sku = (req.params.sku || '').trim();
  if (!sku) return res.status(400).json({ error: 'sku requerido' });
  const packId = req.body?.packId;
  if (packId != null && !Number.isFinite(Number(packId))) return res.status(400).json({ error: 'packId inválido' });
  try {
    await assignSkuPack(sku, packId == null ? null : Number(packId));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
