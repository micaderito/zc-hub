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
import { hasDatabase, getAnalysisCache, setAnalysisCache } from '../db.js';
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

/** Solo una ejecución a la vez por proceso. Caché en DB (90s) para que otras réplicas/requests no vuelvan a llamar a ML. */
let analysisInFlight = null;

export async function getAnalysis() {
  if (hasDatabase()) {
    const cached = await getAnalysisCache();
    if (cached) return cached;
  }
  if (analysisInFlight) return analysisInFlight;
  const p = getAnalysisImpl()
    .then(async (result) => {
      if (hasDatabase()) await setAnalysisCache(result);
      return result;
    })
    .finally(() => {
      analysisInFlight = null;
    });
  analysisInFlight = p;
  return p;
}

async function getAnalysisImpl() {
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
      const maxPages = 200;
      const userId = tokens.mercadolibre.user_id;
      const runSearch = async () => {
        const ids = [];
        let offset = 0;
        const delayMs = 180;
        for (let page = 0; page < maxPages; page++) {
          if (page > 0) await new Promise((r) => setTimeout(r, delayMs));
          const url = `https://api.mercadolibre.com/users/${userId}/items/search?limit=${limit}&offset=${offset}`;
          const r = await ml.fetchWith429Retry(
            url,
            { headers: { Authorization: `Bearer ${token}` } },
            'search'
          );
          if (!r.ok) {
            if (r.status === 401) authFailed = true;
            const errText = await r.text();
            console.error('[ML] search failed:', r.status, url, errText.slice(0, 400));
            return ids;
          }
          const data = await r.json();
          const results = data.results || [];
          const pageIds = results.map(x => (typeof x === 'string' ? x : (x && x.id) || null)).filter(Boolean);
          ids.push(...pageIds);
          const total = data.paging?.total ?? 0;
          if (page === 0) {
            console.log('[ML] search ok:', results.length, 'en esta página, paging.total:', total);
            if (results.length === 0 && total === 0) {
              console.log('[ML] respuesta search (keys):', Object.keys(data));
            }
          }
          if (results.length < limit || offset + limit >= total) break;
          offset += limit;
        }
        return ids;
      };
      const allIds = await runSearch();
      if (authFailed) return { mlRows: rows, authFailed: true };
      console.log('[ML] total ids obtenidos:', allIds.length);
      // Doc ML: multiget GET /items?ids=ID1,ID2,... máx 20 por request; respuesta [{ code, body }]
      const batchSize = 20;
      const delayMs = 180;
      for (let i = 0; i < allIds.length; i += batchSize) {
        if (i > 0) await new Promise((r) => setTimeout(r, delayMs));
        const batch = allIds.slice(i, i + batchSize);
        const idsQuery = batch.join(',');
        const url = `https://api.mercadolibre.com/items?ids=${idsQuery}&include_attributes=all`;
        const res = await ml.fetchWith429Retry(
          url,
          { headers: { Authorization: `Bearer ${token}` } },
          'multiget'
        );
        if (!res.ok) {
          console.error('[ML] multiget failed:', res.status);
          break;
        }
        const multiget = await res.json();
        const items = Array.isArray(multiget)
          ? multiget.map(x => (x && x.code === 200 ? x.body : null)).filter(Boolean)
          : [];
        const valid = items.filter(it => it && it.id && !it.error);
        const originalsOnly = valid.filter(it => it.catalog_listing !== true);
        const toFlatten = originalsOnly.length ? originalsOnly : valid;
        rows.push(...flattenMlItems(toFlatten));
      }
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
