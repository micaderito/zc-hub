/**
 * Analiza productos de ML y TN para detectar:
 * - Coincidencias por SKU (mismo SKU en ambos)
 * - Solo en ML (SKU sin par en TN)
 * - Solo en TN (SKU sin par en ML)
 * - Sin SKU (producto sin SKU en ML o TN)
 * - SKU duplicados (mismo SKU usado por varios ítems en una plataforma)
 *
 * API Mercado Libre (doc Variaciones / Items):
 * - Búsqueda: GET /users/{USER_ID}/items/search?limit=100&offset=N (limit máx 100; results = IDs).
 * - Ítem con variaciones y SKU: GET /items/{id}?include_attributes=all
 *   Doc: "To view the attributes property in each variation, you should add the include_attributes=all
 *   parameter to the query URL" → así cada variación trae .attributes con SELLER_SKU. Una sola llamada.
 * - Alternativa ?attributes=variations devuelve variaciones pero sin attributes (no sirve para SKU).
 * - GET /items/{id}/variations devuelve solo variaciones, sin attributes por defecto.
 * - Multiget: GET /items?ids=ID1,ID2 (máx 20); respuesta = [{ code, body }, ...].
 */

import { tokens, getMlToken, tryRefreshMlToken, setMlTokenKnownInvalid, setTnTokenKnownInvalid } from '../store.js';
import { setResolutionFromAnalysis } from '../store.js';
import { hasDatabase, getAnalysisSnapshot, setAnalysisSnapshot, invalidateAnalysisCache } from '../db.js';
import * as ml from '../lib/mercadolibre.js';
import * as tn from '../lib/tiendanube.js';

/** Extrae el SKU del vendedor (SELLER_SKU). No usar obj.sku ni GTIN/EAN: ese es el código universal del producto. */
function getMlSku(obj) {
  if (!obj) return null;
  const direct = (obj.seller_sku || '').trim();
  if (direct) return direct;
  const idOrName = (a) => String(a.id || a.name || '').toUpperCase();
  const valueOf = (a) => (a.value_name || a.value || '').trim();
  const findSellerSku = (attrs) => {
    if (!attrs || !attrs.length) return null;
    const a = attrs.find(x => idOrName(x) === 'SELLER_SKU');
    return a ? valueOf(a) : null;
  };
  return findSellerSku(obj.attributes) || findSellerSku(obj.attribute_combinations) || null;
}

/** URL de imagen del ítem ML (thumbnail). */
function getMlThumbnail(it) {
  return it?.secure_thumbnail || it?.thumbnail || (it?.pictures?.[0]?.secure_url) || (it?.pictures?.[0]?.url) || null;
}

/** URL de imagen de una variante: usa picture_ids de la variante y resuelve contra item.pictures; si no hay, usa la del ítem. */
function getMlVariationThumbnail(item, variation) {
  const pictureIds = variation?.picture_ids;
  if (pictureIds && pictureIds.length > 0 && item?.pictures?.length) {
    const id = String(pictureIds[0]).trim();
    const pic = item.pictures.find(p => p && String(p.id || p.id_plain || '').trim() === id);
    if (pic) return pic.secure_url || pic.url || null;
  }
  return getMlThumbnail(item);
}

/** Descripción legible de una variante ML a partir de attribute_combinations (ej. "Negro · A4"). */
function variationLabel(v) {
  const comb = v.attribute_combinations || v.attributes;
  if (!comb || !comb.length) return null;
  const parts = comb.map(a => (a.value_name || a.value || '').trim()).filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/** Una "fila" ML: puede ser ítem simple o una variante. */
function flattenMlItems(items) {
  const rows = [];
  for (const it of items) {
    const itemThumbnail = getMlThumbnail(it);
    if (it.variations && it.variations.length > 0) {
      for (const v of it.variations) {
        const sku = getMlSku(v) || getMlSku(it);
        const skuTrim = (sku || '').trim() || null;
        const varLabel = variationLabel(v);
        const price = v.price ?? it.price ?? 0;
        const stock = v.available_quantity ?? it.available_quantity ?? 0;
        const thumbnail = getMlVariationThumbnail(it, v);
        rows.push({
          type: 'ml',
          itemId: it.id,
          variationId: String(v.id),
          variationName: varLabel || null,
          title: it.title,
          sku: skuTrim,
          hasSku: !!skuTrim,
          price: Number(price) || 0,
          stock: Number(stock) || 0,
          thumbnail: thumbnail || itemThumbnail
        });
      }
    } else {
      const sku = getMlSku(it);
      const skuTrim = (sku || '').trim() || null;
      rows.push({
        type: 'ml',
        itemId: it.id,
        variationId: null,
        variationName: null,
        title: it.title,
        sku: skuTrim,
        hasSku: !!skuTrim,
        price: Number(it.price) || 0,
        stock: Number(it.available_quantity) || 0,
        thumbnail: itemThumbnail
      });
    }
  }
  return rows;
}

/** Extrae el primer string legible de un objeto (locale es/en/pt o value/label/name). */
function firstLocaleOrLabel(obj) {
  if (!obj || typeof obj !== 'object') return '';
  if (typeof obj === 'string') return obj;
  const keys = ['es', 'en', 'pt', 'pt_br', 'value', 'label', 'name'];
  for (const k of keys) {
    if (obj[k] != null && typeof obj[k] === 'string' && obj[k].trim()) return obj[k].trim();
  }
  const firstStr = Object.values(obj).find(x => x != null && typeof x === 'string' && String(x).trim());
  return firstStr ? String(firstStr).trim() : '';
}

/** Nombre legible de una variante TN a partir de values (ej. "A4 · Raya" o "Chico"). Si no hay values, usa SKU como fallback. */
function tnVariantLabel(v) {
  const values = v.values;
  if (values && Array.isArray(values) && values.length > 0) {
    const parts = values.map(val => firstLocaleOrLabel(val)).filter(Boolean);
    if (parts.length) return parts.join(' · ');
  }
  const sku = (v.sku || '').trim();
  if (sku) return sku;
  return null;
}

/** URL de imagen TN: usa src o url y fuerza HTTPS para evitar mixed content en el frontend. */
function tnImageSrc(img) {
  if (!img) return null;
  const raw = img.src ?? img.url ?? null;
  if (!raw || typeof raw !== 'string') return null;
  return raw.startsWith('http:') ? raw.replace(/^http:/, 'https:') : raw;
}

/** Una fila TN: cada variante es una fila. products deben tener .images = [{ id, src }]. */
function flattenTnVariants(products) {
  const rows = [];
  for (const p of products) {
    const name = p.name?.es || p.name || p.title || '';
    const images = Array.isArray(p.images) ? p.images : [];
    const firstImg = images[0];
    const firstSrc = tnImageSrc(firstImg);
    for (const v of p.variants || []) {
      const img = v.image_id != null
        ? images.find(i => String(i.id) === String(v.image_id))
        : null;
      const thumbnail = tnImageSrc(img) || firstSrc;
      const variantName = tnVariantLabel(v);
      const price = v.price != null ? Number(v.price) : 0;
      const stock = v.stock ?? v.inventory_levels?.[0]?.stock ?? 0;
      rows.push({
        type: 'tn',
        productId: p.id,
        variantId: v.id,
        variantName: variantName || null,
        productName: name,
        sku: (v.sku || '').trim() || null,
        hasSku: !!(v.sku && v.sku.trim()),
        price: price || 0,
        stock: Number(stock) || 0,
        thumbnail
      });
    }
  }
  return rows;
}

/** Agrupa por SKU para detectar duplicados. */
function groupBySku(rows, key = 'sku') {
  const bySku = new Map();
  for (const r of rows) {
    const sku = r[key] || '__sin_sku__';
    if (!bySku.has(sku)) bySku.set(sku, []);
    bySku.get(sku).push(r);
  }
  return bySku;
}

/**
 * Modelo de snapshot (ver db.js): guardamos las FILAS CRUDAS del catálogo (mlRows/tnRows) y
 * computamos el análisis en cada lectura (barato). El crawl completo a ML/TN solo ocurre cuando
 * no hay snapshot (primer arranque), en refresh manual (force), o en un reconcile por antigüedad
 * (stale-while-revalidate). Las escrituras y el webhook `items` parchan filas puntuales — nunca
 * re-bajan todo el catálogo. Esto elimina las ráfagas de requests que disparaban 429.
 */

/** Antigüedad a partir de la cual se dispara un reconcile en background (no bloquea la lectura). */
const SNAPSHOT_STALE_MS = 6 * 60 * 60 * 1000; // 6 h

/** Snapshot en memoria para cuando no hay Postgres (dev). Con DB, la fuente es sync_settings. */
let memSnapshot = null; // { at, data: { mlRows, tnRows, mlConnected, tnConnected, mlAuthError } }

/** Serializa las lecturas/escrituras del snapshot para evitar carreras read-modify-write entre parches. */
let snapshotLock = Promise.resolve();
function withSnapshotLock(fn) {
  const run = snapshotLock.then(fn, fn);
  snapshotLock = run.then(() => {}, () => {});
  return run;
}

async function loadSnapshot() {
  if (hasDatabase()) return getAnalysisSnapshot();
  return memSnapshot;
}
async function storeSnapshot(data) {
  memSnapshot = { at: Date.now(), data };
  if (hasDatabase()) await setAnalysisSnapshot(data);
}

/** Dedupe: un solo crawl completo a la vez por proceso. */
let crawlInFlight = null;
function crawlAndStore() {
  if (crawlInFlight) return crawlInFlight;
  crawlInFlight = fetchRawRows()
    .then(async (rows) => { await withSnapshotLock(() => storeSnapshot(rows)); return rows; })
    .finally(() => { crawlInFlight = null; });
  return crawlInFlight;
}

/**
 * Devuelve el análisis. Sirve del snapshot si existe (y refresca en background si está viejo);
 * si no hay snapshot o se pide `force`, hace el crawl completo. `computeAnalysis` corre siempre
 * (también refresca la resolución por SKU que usa sync).
 * @param {{ force?: boolean }} [opts]
 */
export async function getAnalysis(opts = {}) {
  if (!opts.force) {
    const snap = await loadSnapshot();
    if (snap?.data?.mlRows) {
      if (Date.now() - (snap.at ?? 0) > SNAPSHOT_STALE_MS && !crawlInFlight) {
        crawlAndStore().catch((e) => console.error('[Analysis] reconcile en background falló:', e.message));
      }
      return computeAnalysis(snap.data);
    }
  }
  const rows = await crawlAndStore();
  return computeAnalysis(rows);
}

/** Fuerza un crawl completo y actualiza el snapshot (refresh manual desde la UI). */
export async function refreshAnalysis() {
  return getAnalysis({ force: true });
}

/**
 * Descarta el snapshot (memoria + DB) para forzar un crawl completo en la próxima lectura.
 * Se usa al conectar/reconectar un canal (OAuth): así los datos del canal recién conectado
 * aparecen enseguida sin esperar al reconcile por antigüedad.
 */
export async function invalidateSnapshot() {
  memSnapshot = null;
  crawlInFlight = null;
  if (hasDatabase()) await invalidateAnalysisCache();
}

/** Solo para tests: limpia el snapshot en memoria y el crawl en curso (aislamiento entre casos). */
export function __resetSnapshotCacheForTests() {
  memSnapshot = null;
  crawlInFlight = null;
}

/** Baja TODO el catálogo de ML y TN y devuelve las filas crudas (sin computar el análisis). */
async function fetchRawRows() {
  const accessToken = await getMlToken();
  const mlConnected = !!accessToken;
  const tnConnected = !!tokens.tiendanube?.access_token;
  const storeId = tokens.tiendanube?.store_id;

  let mlRows = [];
  let tnRows = [];

  let mlAuthError = false;
  if (mlConnected && tokens.mercadolibre?.user_id) {
    const runMlFetch = async (token) => {
      const rows = [];
      let authFailed = false;
      // Doc ML: /users/$USER_ID/items/search con limit (máx 100) y offset; results = array de IDs
      const limit = 100;
      const userId = tokens.mercadolibre.user_id;
      /**
       * Paginación con search_type=scan + scroll_id. El offset tradicional está capado en 1000
       * ítems por ML; scan no tiene ese límite. Además es secuencial (no paralelizable), lo que
       * evita la ráfaga de N/100 requests simultáneos que contribuía a los 429. El scroll_id
       * expira ~5 min y puede cambiar en cada respuesta: reenviamos siempre el último.
       */
      const runSearch = async () => {
        const ids = [];
        const authHeaders = { Authorization: `Bearer ${token}` };
        const base = `https://api.mercadolibre.com/users/${userId}/items/search?search_type=scan&limit=${limit}`;
        let scrollId = null;
        let firstCall = true;
        // Tope de seguridad para no ciclar indefinidamente si ML devolviera siempre scroll_id.
        const maxIterations = 2000;
        for (let guard = 0; guard < maxIterations; guard++) {
          const url = scrollId ? `${base}&scroll_id=${encodeURIComponent(scrollId)}` : base;
          const res = await ml.fetchWith429Retry(url, { headers: authHeaders }, 'search');
          if (!res.ok) {
            if (res.status === 401) authFailed = true;
            console.error('[ML] search(scan) failed:', res.status, (await res.text()).slice(0, 400));
            break;
          }
          const data = await res.json();
          const results = data.results || [];
          const newScroll = data.scroll_id || null;
          if (firstCall) console.log('[ML] search(scan) ok: primera tanda', results.length, 'de paging.total:', data.paging?.total ?? '?');
          if (results.length) {
            ids.push(...results.map(x => (typeof x === 'string' ? x : (x && x.id) || null)).filter(Boolean));
          }
          // Continuar mientras haya scroll_id y (haya resultados, o sea la 1ª llamada — algunas
          // cuentas devuelven la 1ª tanda recién con el scroll_id en la 2ª request).
          const canContinue = !!newScroll && (results.length > 0 || firstCall);
          firstCall = false;
          if (!canContinue) break;
          scrollId = newScroll;
        }
        return ids;
      };
      const allIds = await runSearch();
      if (authFailed) return { mlRows: rows, authFailed: true };
      console.log('[ML] total ids obtenidos:', allIds.length);

      // Doc ML: multiget GET /items?ids=ID1,ID2,... máx 20 por request; respuesta [{ code, body }]
      // El mlLimiter controla concurrencia y espaciado — no hace falta delay manual.
      const batchSize = 20;
      const headers = { Authorization: `Bearer ${token}` };
      const batches = [];
      for (let i = 0; i < allIds.length; i += batchSize) batches.push(allIds.slice(i, i + batchSize));

      const batchResults = await Promise.all(
        batches.map(batch => {
          const url = `https://api.mercadolibre.com/items?ids=${batch.join(',')}&include_attributes=all`;
          return ml.fetchWith429Retry(url, { headers }, 'multiget').then(async res => {
            if (!res.ok) {
              console.error('[ML] multiget failed:', res.status);
              return [];
            }
            const multiget = await res.json();
            const items = Array.isArray(multiget)
              ? multiget.map(x => (x && x.code === 200 ? x.body : null)).filter(Boolean)
              : [];
            const valid = items.filter(it => it && it.id && !it.error);
            const originalsOnly = valid.filter(it => it.catalog_listing !== true);
            return originalsOnly.length ? originalsOnly : valid;
          });
        })
      );
      for (const batchItems of batchResults) rows.push(...flattenMlItems(batchItems));
      console.log('[ML] mlRows final:', rows.length);
      return { mlRows: rows, authFailed: false };
    };
    try {
      let result = await runMlFetch(accessToken);
      if (result.authFailed) {
        console.log('[ML] 401: intentando refrescar token…');
        const newToken = await tryRefreshMlToken();
        if (newToken) {
          result = await runMlFetch(newToken);
          if (!result.authFailed) mlRows = result.mlRows;
        }
        if (result.authFailed) {
          mlAuthError = true;
          setMlTokenKnownInvalid(true);
        }
      } else {
        mlRows = result.mlRows;
      }
    } catch (e) {
      console.error('ML analysis error:', e);
    }
  } else {
    if (mlConnected && !tokens.mercadolibre?.user_id) {
      console.warn('[ML] conectado pero falta user_id en tokens');
    }
  }

  if (tnConnected && storeId) {
    try {
      // Doc TN: GET /products ya devuelve cada producto con variants e images embebidos. Una sola serie de GETs paginados.
      const products = await tn.getProducts(tokens.tiendanube.access_token, storeId);
      const withVariants = (products || []).map(p => ({
        ...p,
        variants: p.variants ?? [],
        images: Array.isArray(p.images) ? p.images : []
      }));
      tnRows = flattenTnVariants(withVariants);
    } catch (e) {
      if (e.status === 401) setTnTokenKnownInvalid(true);
      console.error('TN analysis error:', e);
    }
  }

  return { mlRows, tnRows, mlConnected, tnConnected, mlAuthError };
}

/**
 * Computa el análisis (matched/onlyML/onlyTN/sin-SKU/duplicados) a partir de las filas crudas.
 * Es barato (solo agrupa en memoria), así que corre en cada lectura. También refresca la
 * resolución por SKU (setResolutionFromAnalysis) que usa la sincronización de stock.
 */
function computeAnalysis({ mlRows = [], tnRows = [], mlConnected = false, tnConnected = false, mlAuthError = false }) {
  const mlBySku = groupBySku(mlRows);
  const tnBySku = groupBySku(tnRows);

  const matched = [];
  const onlyML = [];
  const onlyTN = [];
  const noSkuML = [];
  const noSkuTN = [];
  const duplicateSkuML = [];
  const duplicateSkuTN = [];

  const skuSetML = new Set(mlRows.map(r => r.sku).filter(Boolean));
  const skuSetTN = new Set(tnRows.map(r => r.sku).filter(Boolean));

  for (const row of mlRows) {
    if (!row.hasSku) {
      noSkuML.push(row);
      continue;
    }
    const count = mlBySku.get(row.sku)?.length || 0;
    if (count > 1) {
      if (!duplicateSkuML.some(g => g.sku === row.sku)) {
        duplicateSkuML.push({ sku: row.sku, items: mlBySku.get(row.sku) });
      }
      continue;
    }
    if (skuSetTN.has(row.sku)) {
      const tnItem = tnRows.find(r => r.sku === row.sku);
      matched.push({ ml: row, tn: tnItem, sku: row.sku });
    } else {
      onlyML.push(row);
    }
  }

  for (const row of tnRows) {
    if (!row.hasSku) {
      noSkuTN.push(row);
      continue;
    }
    const count = tnBySku.get(row.sku)?.length || 0;
    if (count > 1) {
      if (!duplicateSkuTN.some(g => g.sku === row.sku)) {
        duplicateSkuTN.push({ sku: row.sku, items: tnBySku.get(row.sku) });
      }
      continue;
    }
    if (!skuSetML.has(row.sku)) {
      onlyTN.push(row);
    }
  }

  // Resolución por SKU para sync: mismo SKU en ML y TN = vinculado (fuente de verdad es el SKU)
  setResolutionFromAnalysis(mlRows, tnRows);

  return {
    mlConnected,
    tnConnected,
    mlAuthError: mlAuthError || false,
    summary: {
      totalML: mlRows.length,
      totalTN: tnRows.length,
      matched: matched.length,
      onlyML: onlyML.length,
      onlyTN: onlyTN.length,
      noSkuML: noSkuML.length,
      noSkuTN: noSkuTN.length,
      duplicateSkuML: duplicateSkuML.length,
      duplicateSkuTN: duplicateSkuTN.length,
      resolved: matched.length
    },
    matched,
    onlyML,
    onlyTN,
    noSkuML,
    noSkuTN,
    duplicateSkuML,
    duplicateSkuTN,
    mappings: matched.map(({ ml, tn, sku }) => ({
      sku,
      mercadolibre: { itemId: ml.itemId, variationId: ml.variationId ?? undefined },
      tiendanube: { productId: tn.productId, variantId: tn.variantId }
    }))
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Parches puntuales del snapshot. Reemplazan al viejo `invalidateAnalysisCache()`:
// en vez de borrar todo el catálogo y re-bajarlo de ML, actualizan la(s) fila(s)
// afectada(s) en memoria/DB. El análisis se recomputa en la próxima lectura.
// Todas son no-op si todavía no hay snapshot (la primera lectura hará el crawl).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aplica `mutator(data)` sobre las filas del snapshot bajo lock; guarda solo si hubo cambios.
 * Si hay un crawl completo en curso (reconcile por antigüedad o refresh manual), espera a que
 * termine antes de leer: `fetchRawRows()` corre FUERA del lock (tarda decenas de segundos) y su
 * `storeSnapshot()` final SÍ pasa por el lock, así que si el parche entrara primero, el crawl lo
 * pisaría al terminar con datos de antes de la edición (el usuario ve el SKU/precio/stock
 * "volver" al valor viejo). Esperar el crawl garantiza que el parche se aplique último.
 */
async function patchSnapshot(mutator) {
  if (crawlInFlight) await crawlInFlight.catch(() => {});
  await withSnapshotLock(async () => {
    const snap = await loadSnapshot();
    if (!snap?.data?.mlRows) return;
    const changed = mutator(snap.data);
    if (changed) await storeSnapshot(snap.data);
  });
}

const sameVar = (a, b) => String(a ?? '') === String(b ?? '');

/** Precio ML: en ítems legacy con variaciones ML aplica el mismo precio a TODAS las variaciones del ítem. */
export function patchMlPrice(itemId, price) {
  return patchSnapshot((data) => {
    let changed = false;
    for (const r of data.mlRows) {
      if (r.itemId === itemId && r.price !== price) { r.price = price; changed = true; }
    }
    return changed;
  });
}

/** Stock ML: por variación (o por ítem si no tiene variación). */
export function patchMlStock(itemId, variationId, stock) {
  return patchSnapshot((data) => {
    let changed = false;
    for (const r of data.mlRows) {
      if (r.itemId !== itemId) continue;
      if (variationId != null && variationId !== '' && !sameVar(r.variationId, variationId)) continue;
      if (r.stock !== stock) { r.stock = stock; changed = true; }
    }
    return changed;
  });
}

/** SKU ML: por variación (o por ítem simple). */
export function patchMlSku(itemId, variationId, sku) {
  const skuTrim = (sku || '').trim() || null;
  return patchSnapshot((data) => {
    let changed = false;
    for (const r of data.mlRows) {
      if (r.itemId !== itemId) continue;
      if (variationId != null && variationId !== '' && !sameVar(r.variationId, variationId)) continue;
      if (r.sku !== skuTrim) { r.sku = skuTrim; r.hasSku = !!skuTrim; changed = true; }
    }
    return changed;
  });
}

/** Precio TN: por variante, o a todas las variantes del producto si applyAll. */
export function patchTnPrice(productId, variantId, price, applyAll = false) {
  return patchSnapshot((data) => {
    let changed = false;
    for (const r of data.tnRows) {
      if (String(r.productId) !== String(productId)) continue;
      if (!applyAll && !sameVar(r.variantId, variantId)) continue;
      if (r.price !== price) { r.price = price; changed = true; }
    }
    return changed;
  });
}

/** Stock TN: por variante. */
export function patchTnStock(productId, variantId, stock) {
  return patchSnapshot((data) => {
    let changed = false;
    for (const r of data.tnRows) {
      if (String(r.productId) !== String(productId)) continue;
      if (!sameVar(r.variantId, variantId)) continue;
      if (r.stock !== stock) { r.stock = stock; changed = true; }
    }
    return changed;
  });
}

/** SKU TN: por variante. */
export function patchTnSku(productId, variantId, sku) {
  const skuTrim = (sku || '').trim() || null;
  return patchSnapshot((data) => {
    let changed = false;
    for (const r of data.tnRows) {
      if (String(r.productId) !== String(productId)) continue;
      if (!sameVar(r.variantId, variantId)) continue;
      if (r.sku !== skuTrim) { r.sku = skuTrim; r.hasSku = !!skuTrim; changed = true; }
    }
    return changed;
  });
}

/**
 * Webhook `items` de ML: re-baja UN ítem (1 request) y reemplaza sus filas en el snapshot.
 * Si el ítem ya no existe/está inactivo, quita sus filas. Recomendación oficial de ML: mantener
 * el catálogo con notificaciones de `items` en vez de re-bajarlo entero.
 */
export async function refreshMlItemInSnapshot(accessToken, itemId) {
  if (!itemId) return;
  let item = null;
  try {
    item = await ml.getItem(accessToken, itemId);
  } catch (e) {
    console.error('[Analysis] refreshMlItemInSnapshot getItem falló:', e.message);
    return;
  }
  const newRows = item && item.id ? flattenMlItems([item]) : [];
  await patchSnapshot((data) => {
    const before = data.mlRows.length;
    data.mlRows = data.mlRows.filter((r) => r.itemId !== itemId);
    data.mlRows.push(...newRows);
    return data.mlRows.length !== before || newRows.length > 0;
  });
}

/**
 * Webhook `product/*` de TN: re-baja UN producto (1 request) y reemplaza sus filas en el snapshot.
 * Si el producto ya no existe (deleted / 404), quita sus filas. Análogo a `refreshMlItemInSnapshot`
 * (topic `items` de ML): mantiene el catálogo fresco cuando editan un producto por fuera de la app,
 * sin re-bajarlo entero.
 */
export async function refreshTnProductInSnapshot(accessToken, storeId, productId) {
  if (productId == null) return;
  let product = null;
  try {
    product = await tn.getProduct(accessToken, storeId, productId);
  } catch (e) {
    if (e.status === 401) setTnTokenKnownInvalid(true);
    console.error('[Analysis] refreshTnProductInSnapshot getProduct falló:', e.message);
    return;
  }
  const withVariants = product && product.id
    ? [{ ...product, variants: product.variants ?? [], images: Array.isArray(product.images) ? product.images : [] }]
    : [];
  const newRows = flattenTnVariants(withVariants);
  await patchSnapshot((data) => {
    const before = data.tnRows.length;
    data.tnRows = data.tnRows.filter((r) => String(r.productId) !== String(productId));
    data.tnRows.push(...newRows);
    return data.tnRows.length !== before || newRows.length > 0;
  });
}
