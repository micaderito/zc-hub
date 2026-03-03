/**
 * Almacenamiento en memoria (+ tokens persistidos en archivo y/o base de datos).
 * - Tokens OAuth: en local en data/tokens.json; si hay DATABASE_URL, también en Supabase (oauth_tokens) para que sobrevivan redeploys en Render.
 * - Resolución por SKU: se rellena desde el análisis (mismo SKU en ML y TN = vinculado). No se guarda mapeo aparte.
 */

import fs from 'fs';
import path from 'path';
import * as ml from './lib/mercadolibre.js';
import { getOAuthTokens, setOAuthTokens, hasDatabase } from './db.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');

export const tokens = {
  mercadolibre: { access_token: null, refresh_token: null, user_id: null, expires_at: null },
  tiendanube: { access_token: null, store_id: null }
};

/** Cuando se detecta 401 (o refresh falla en ML), se setea para que Inicio muestre "Sesión vencida". Persistido para que sobreviva reinicios. */
let mlTokenKnownInvalid = false;
let tnTokenKnownInvalid = false;
export function setMlTokenKnownInvalid(invalid) {
  mlTokenKnownInvalid = !!invalid;
  persistTokens();
}
export function isMlTokenKnownInvalid() {
  return mlTokenKnownInvalid;
}
export function setTnTokenKnownInvalid(invalid) {
  tnTokenKnownInvalid = !!invalid;
  persistTokens();
}
export function isTnTokenKnownInvalid() {
  return tnTokenKnownInvalid;
}

function applyTokensData(data) {
  if (!data) return;
  if (data.mercadolibre && data.mercadolibre.access_token) {
    Object.assign(tokens.mercadolibre, data.mercadolibre);
  }
  if (data.tiendanube && data.tiendanube.access_token) {
    Object.assign(tokens.tiendanube, data.tiendanube);
  }
  if (typeof data.mlTokenKnownInvalid === 'boolean') mlTokenKnownInvalid = data.mlTokenKnownInvalid;
  if (typeof data.tnTokenKnownInvalid === 'boolean') tnTokenKnownInvalid = data.tnTokenKnownInvalid;
}

export function loadTokensFromFile() {
  try {
    if (!fs.existsSync(TOKENS_FILE)) return;
    const raw = fs.readFileSync(TOKENS_FILE, 'utf8');
    const data = JSON.parse(raw);
    applyTokensData(data);
  } catch (e) {
    console.warn('No se pudieron cargar tokens guardados:', e.message);
  }
}

/** Carga tokens desde la base de datos (si hay) o desde archivo. Llamar al arrancar el servidor. */
export async function loadTokens() {
  if (hasDatabase()) {
    const data = await getOAuthTokens();
    if (data && (data.mercadolibre?.access_token || data.tiendanube?.access_token)) {
      applyTokensData(data);
      console.log('Tokens OAuth cargados desde la base de datos.');
      return;
    }
  }
  loadTokensFromFile();
}

const tokensPayload = () => ({
  mercadolibre: tokens.mercadolibre,
  tiendanube: tokens.tiendanube,
  mlTokenKnownInvalid,
  tnTokenKnownInvalid
});

export function persistTokens() {
  const payload = tokensPayload();
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (e) {
    console.error('Error guardando tokens:', e.message);
  }
  if (hasDatabase()) {
    setOAuthTokens(payload).catch(e => console.error('Error guardando tokens en DB:', e.message));
  }
}

/** Persiste tokens y espera a que la DB termine (para que sobrevivan reinicios del contenedor). */
export async function persistTokensAsync() {
  const payload = tokensPayload();
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (e) {
    console.error('Error guardando tokens:', e.message);
  }
  if (hasDatabase()) {
    try {
      await setOAuthTokens(payload);
    } catch (e) {
      console.error('Error guardando tokens en DB:', e.message);
    }
  }
}

/** Doc ML: access token expira en 6 h. Refrescar solo cuando pierda validez (margin 1 h). */
const ML_REFRESH_MARGIN_MS = 60 * 60 * 1000;

/** Obtiene access_token de ML; refresca si está por vencer o ya venció. Si falta user_id, lo obtiene con /users/me. */
export async function getMlToken() {
  const t = tokens.mercadolibre;
  if (!t?.access_token) return null;
  const needsRefresh = !t.expires_at || (Date.now() > t.expires_at - ML_REFRESH_MARGIN_MS);
  if (needsRefresh && t.refresh_token) {
    const refreshed = await tryRefreshMlToken();
    if (!refreshed) return null;
  }
  if (!t.user_id) {
    try {
      const me = await ml.getMe(t.access_token);
      if (me?.id != null) {
        t.user_id = me.id;
        persistTokens();
        console.log('[ML] user_id obtenido por /users/me:', t.user_id);
      }
    } catch (e) {
      console.warn('[ML] no se pudo obtener user_id:', e.message);
    }
  }
  return t.access_token;
}

/**
 * Intenta refrescar el token de ML. Doc ML: el refresh_token es de uso único; la respuesta trae
 * un nuevo refresh_token que hay que guardar; el anterior queda inválido.
 * Solo una ejecución a la vez: si dos refreshes corren en paralelo (webhooks + sync + timer),
 * el segundo usa el refresh_token viejo y ML devuelve invalid_grant.
 */
let refreshInFlight = null;

export async function tryRefreshMlToken() {
  if (refreshInFlight) {
    await refreshInFlight;
    return tokens.mercadolibre?.access_token || null;
  }
  const t = tokens.mercadolibre;
  if (!t?.refresh_token) return null;
  const doRefresh = async () => {
    try {
      const data = await ml.refreshAccessToken(t.refresh_token);
      t.access_token = data.access_token;
      t.refresh_token = data.refresh_token || t.refresh_token;
      t.expires_at = data.expires_in ? Date.now() + data.expires_in * 1000 : null;
      if (data.user_id != null) t.user_id = data.user_id;
      await persistTokensAsync();
      return t.access_token;
    } catch (e) {
      console.warn('ML refresh token failed:', e.message);
      setMlTokenKnownInvalid(true);
      return null;
    } finally {
      refreshInFlight = null;
    }
  };
  refreshInFlight = doRefresh();
  return refreshInFlight;
}

/** Desconecta Mercado Libre: borra tokens para que el usuario pueda reconectar. */
export function clearMlTokens() {
  tokens.mercadolibre.access_token = null;
  tokens.mercadolibre.refresh_token = null;
  tokens.mercadolibre.user_id = null;
  tokens.mercadolibre.expires_at = null;
  mlTokenKnownInvalid = false;
  persistTokens();
}

/** Desconecta Tienda Nube: borra tokens para que el usuario pueda reconectar. */
export function clearTnTokens() {
  tokens.tiendanube.access_token = null;
  tokens.tiendanube.store_id = null;
  tnTokenKnownInvalid = false;
  persistTokens();
}

/**
 * Resolución por SKU: se rellena desde getAnalysis() con los ítems que tienen el mismo SKU en ML y TN.
 * La fuente de verdad es el SKU en cada plataforma; no guardamos un mapeo aparte.
 */
const skuToMlItem = new Map();
const skuToTnVariant = new Map();
const mlItemKeyToSku = new Map();
const variantIdToSku = new Map();

/**
 * Rellena la resolución desde las filas del análisis (mlRows y tnRows con SKU).
 * Se llama al final de getAnalysis() para que sync use siempre el estado real de las APIs.
 */
export function setResolutionFromAnalysis(mlRows, tnRows) {
  skuToMlItem.clear();
  skuToTnVariant.clear();
  mlItemKeyToSku.clear();
  variantIdToSku.clear();
  for (const row of mlRows || []) {
    const sku = (row.sku || '').trim();
    if (!sku) continue;
    const key = row.variationId ? `${row.itemId}:${row.variationId}` : row.itemId;
    skuToMlItem.set(sku, { itemId: row.itemId, variationId: row.variationId ?? undefined });
    mlItemKeyToSku.set(key, sku);
  }
  for (const row of tnRows || []) {
    const sku = (row.sku || '').trim();
    if (!sku) continue;
    skuToTnVariant.set(sku, { productId: row.productId, variantId: row.variantId });
    variantIdToSku.set(Number(row.variantId), sku);
  }
}

/**
 * Añade o actualiza un par vinculado en la caché (después de POST /link).
 * Así la resolución queda al día sin re-ejecutar todo el análisis.
 */
export function addResolution(entry) {
  const sku = (entry.sku || '').trim();
  if (!sku) return;
  if (entry.mercadolibre?.itemId) {
    const key = entry.mercadolibre.variationId
      ? `${entry.mercadolibre.itemId}:${entry.mercadolibre.variationId}`
      : entry.mercadolibre.itemId;
    skuToMlItem.set(sku, { itemId: entry.mercadolibre.itemId, variationId: entry.mercadolibre.variationId ?? undefined });
    mlItemKeyToSku.set(key, sku);
  }
  if (entry.tiendanube?.productId != null && entry.tiendanube?.variantId != null) {
    skuToTnVariant.set(sku, { productId: entry.tiendanube.productId, variantId: entry.tiendanube.variantId });
    variantIdToSku.set(Number(entry.tiendanube.variantId), sku);
  }
}

export function getMlItemBySku(sku) {
  return skuToMlItem.get((sku || '').trim()) || null;
}

export function getTnVariantBySku(sku) {
  return skuToTnVariant.get((sku || '').trim()) || null;
}

export function getResolvedSkus() {
  const set = new Set(skuToMlItem.keys());
  for (const sku of skuToTnVariant.keys()) set.add(sku);
  return [...set];
}

export function getSkuByMlItem(itemId, variationId) {
  const key = variationId ? `${itemId}:${variationId}` : itemId;
  return mlItemKeyToSku.get(key) || mlItemKeyToSku.get(itemId) || null;
}

export function getSkuByTnVariant(variantId) {
  return variantIdToSku.get(Number(variantId)) || null;
}

/** Para compatibilidad: listar "mapeos" = pares resueltos por SKU (para GET /mapping). */
export function getResolvedMappings() {
  const list = [];
  for (const sku of getResolvedSkus()) {
    const ml = getMlItemBySku(sku);
    const tn = getTnVariantBySku(sku);
    if (ml && tn) list.push({ sku, mercadolibre: ml, tiendanube: tn });
  }
  return list;
}
