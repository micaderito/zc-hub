import fetch from 'node-fetch';

const BASE = 'https://api.mercadolibre.com';

/** Doc ML: "local_rate_limited (429): Inténtalo de nuevo en unos segundos." */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Si ML no manda Retry-After, usamos backoff exponencial: 10s, 20s, 40s (cap 30s). */
function waitFor429(res, context = '', attemptIndex = 0) {
  if (res.status !== 429) return Promise.resolve();
  const retryAfter = res.headers.get('retry-after');
  let secs = retryAfter ? parseInt(retryAfter, 10) : Math.min(10 * Math.pow(2, attemptIndex), 30);
  const ms = Math.min(secs * 1000, 30000);
  console.warn(`[ML] 429 ${context}, esperando ${Math.round(ms / 1000)}s antes de reintentar (doc: unos segundos)`);
  return sleep(ms);
}

/** Máximo de reintentos ante 429 (intentos totales = max429Retries + 1). */
const MAX_429_RETRIES = 3;

/**
 * GET (o otro) a la API de ML con reintentos ante 429. Respeta Retry-After; si no viene, backoff exponencial.
 */
export async function fetchWith429Retry(url, options = {}, context = '') {
  let res = await fetch(url, options);
  for (let r = 0; r < MAX_429_RETRIES && res.status === 429; r++) {
    await waitFor429(res, context, r);
    res = await fetch(url, options);
  }
  return res;
}

export async function getAuthUrl(redirectUri, state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.ML_CLIENT_ID,
    redirect_uri: redirectUri,
    state: state || 'ml'
  });
  return `https://auth.mercadolibre.com.ar/authorization?${params}`;
}

/** Doc ML: POST con accept + content-type; redirect_uri debe coincidir exactamente con el de la autorización. */
const OAUTH_HEADERS = {
  'Accept': 'application/json',
  'Content-Type': 'application/x-www-form-urlencoded'
};

export async function exchangeCodeForToken(code, redirectUri) {
  const doRequest = () =>
    fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: OAUTH_HEADERS,
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.ML_CLIENT_ID,
        client_secret: process.env.ML_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri
      })
    });
  const maxRetries = 2;
  let res = await doRequest();
  for (let r = 0; r < maxRetries && res.status === 429; r++) {
    await waitFor429(res, 'exchangeCodeForToken');
    res = await doRequest();
  }
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ML token error: ${res.status} ${err}`);
  }
  return res.json();
}

export async function refreshAccessToken(refreshToken) {
  const doRequest = () =>
    fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: OAUTH_HEADERS,
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: process.env.ML_CLIENT_ID,
        client_secret: process.env.ML_CLIENT_SECRET,
        refresh_token: refreshToken
      })
    });
  const maxRetries = 2;
  let res = await doRequest();
  for (let r = 0; r < maxRetries && res.status === 429; r++) {
    await waitFor429(res, 'refreshAccessToken');
    res = await doRequest();
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ML refresh failed: ${res.status} ${text}`);
  }
  return res.json();
}

/** Usuario actual (para obtener user_id si falta en tokens). Reintenta una vez si 429. */
export async function getMe(accessToken) {
  const doRequest = () =>
    fetch(`${BASE}/users/me`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
  let res = await doRequest();
  if (res.status === 429) {
    await waitFor429(res, 'getMe');
    res = await doRequest();
  }
  if (!res.ok) return null;
  return res.json();
}

/** Incluir include_attributes=all para que las variaciones traigan el array attributes (ej. SELLER_SKU). */
export async function getItem(accessToken, itemId) {
  const url = `${BASE}/items/${itemId}?include_attributes=all`;
  const res = await fetchWith429Retry(
    url,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    'getItem'
  );
  if (!res.ok) return null;
  return res.json();
}

export async function getOrder(accessToken, orderId) {
  const url = `${BASE}/orders/${orderId}`;
  const res = await fetchWith429Retry(
    url,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    'getOrder'
  );
  if (!res.ok) return null;
  return res.json();
}

/** Listar reclamos/devoluciones del vendedor (post-purchase). Params: limit, offset, status, stage, type, resource, etc. */
export async function getClaimsSearch(accessToken, params = {}) {
  const q = new URLSearchParams();
  if (params.limit != null) q.set('limit', params.limit);
  if (params.offset != null) q.set('offset', params.offset);
  if (params.status) q.set('status', params.status);
  if (params.stage) q.set('stage', params.stage);
  if (params.type) q.set('type', params.type);
  if (params.resource) q.set('resource', params.resource);
  const url = `${BASE}/post-purchase/v1/claims/search?${q.toString()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) return null;
  return res.json();
}

/** Detalle de devoluciones de un reclamo. Devuelve info de envío y puede incluir ítems. */
export async function getClaimReturns(accessToken, claimId) {
  const res = await fetch(`${BASE}/post-purchase/v2/claims/${claimId}/returns`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) return null;
  return res.json();
}

/** Actualizar stock de un ítem sin variaciones (publicación simple). */
export async function updateItemStock(accessToken, itemId, quantity) {
  const res = await fetchWith429Retry(
    `${BASE}/items/${itemId}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ available_quantity: quantity })
    },
    'updateItemStock'
  );
  return res.ok;
}

/**
 * Actualizar stock de un ítem: si tiene variationId, actualiza esa variación (ML exige enviar todas las variaciones);
 * si no, actualiza el ítem simple.
 */
export async function updateItemOrVariationStock(accessToken, itemId, variationId, quantity) {
  const qty = Math.max(0, Math.floor(Number(quantity)));
  if (variationId != null && variationId !== '') {
    const item = await getItem(accessToken, itemId);
    if (!item?.variations?.length) return false;
    const variations = item.variations.map((v) => {
      const id = v.id ?? v.id_plain;
      if (String(id) === String(variationId)) return { id: Number(id), available_quantity: qty };
      return { id: Number(id) };
    });
    const res = await fetchWith429Retry(
      `${BASE}/items/${itemId}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ variations })
      },
      'updateItemStock'
    );
    return res.ok;
  }
  return updateItemStock(accessToken, itemId, qty);
}

/** Actualizar precio de un ítem. */
export async function updateItemPrice(accessToken, itemId, price) {
  const res = await fetchWith429Retry(
    `${BASE}/items/${itemId}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ price: price })
    },
    'updateItemPrice'
  );
  return res.ok;
}

/** Obtener SKU de un item (campo seller_sku en la respuesta). Para variantes, puede estar en variations. */
export function extractSkuFromItem(item) {
  if (item?.seller_sku) return item.seller_sku;
  if (item?.variations?.length) {
    const v = item.variations.find(v => v.seller_sku);
    return v?.seller_sku || null;
  }
  return null;
}

/** Lee el mensaje de error del body (incl. validación: cause[], message, error). */
async function errorMessage(res) {
  const text = await res.text();
  try {
    const j = JSON.parse(text);
    if (Array.isArray(j.cause) && j.cause.length > 0) {
      const parts = j.cause.map(c => c.message || c.error || JSON.stringify(c)).filter(Boolean);
      if (parts.length) return parts.join('; ');
    }
    if (j.validation_errors && Array.isArray(j.validation_errors)) {
      const parts = j.validation_errors.map(v => v.message || v.field || JSON.stringify(v)).filter(Boolean);
      if (parts.length) return parts.join('; ');
    }
    return j.message || j.error || text || res.statusText;
  } catch {
    return text || res.statusText;
  }
}

/** Arma el array attributes con SELLER_SKU actualizado (para usar cuando PUT con seller_sku falla). */
function attributesWithSku(attributes, sku) {
  const skuAttr = { id: 'SELLER_SKU', value_name: sku };
  if (!attributes || !attributes.length) return [skuAttr];
  const byId = (a) => String(a.id || a.name || '').toUpperCase();
  const has = attributes.some(a => byId(a) === 'SELLER_SKU');
  if (has) return attributes.map(a => (byId(a) === 'SELLER_SKU' ? skuAttr : a));
  return [...attributes, skuAttr];
}

/** Actualizar seller_sku de un ítem simple (sin variantes). Si falla (has_bids, status active, "Cannot update item"), reintenta vía atributo SELLER_SKU. */
export async function updateItemSku(accessToken, itemId, sku) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  };
  let res = await fetch(`${BASE}/items/${itemId}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ seller_sku: sku })
  });
  if (res.ok) return true;
  const errMsg = await errorMessage(res);
  const canRetryViaAttributes =
    (errMsg.includes('has_bids') && errMsg.includes('true')) ||
    errMsg.includes('Cannot update item') ||
    errMsg.includes('seller_sku is not modifiable') ||
    errMsg.toLowerCase().includes('not modifiable') ||
    (errMsg.includes('status') && (errMsg.includes('active') || errMsg.includes('under_review')));
  if (!canRetryViaAttributes) throw new Error(errMsg);
  const item = await getItem(accessToken, itemId);
  if (!item) throw new Error(errMsg);
  const attributes = attributesWithSku(item.attributes, sku);
  res = await fetch(`${BASE}/items/${itemId}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ attributes })
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return true;
}

/** Pone o reemplaza SELLER_SKU en el array attributes de una variación (según doc ML). */
function variationAttributesWithSku(attrs, sku) {
  const skuAttr = { id: 'SELLER_SKU', value_name: sku };
  if (!attrs || !attrs.length) return [skuAttr];
  const byId = (a) => String(a.id || a.name || '').toUpperCase();
  const has = attrs.some(a => byId(a) === 'SELLER_SKU');
  if (has) return attrs.map(a => (byId(a) === 'SELLER_SKU' ? skuAttr : a));
  return [...attrs, skuAttr];
}

/** Extrae el SKU del vendedor (SELLER_SKU). No usar v.sku: puede ser el código universal (GTIN/EAN). */
function getVariationSku(v) {
  if (!v) return '';
  const direct = (v.seller_sku || '').trim();
  if (direct) return direct;
  const idOrName = (a) => String(a.id || a.name || '').toUpperCase();
  const valueOf = (a) => (a.value_name || a.value || '').trim();
  const findSellerSku = (attrs) => {
    if (!attrs?.length) return null;
    const a = attrs.find(x => idOrName(x) === 'SELLER_SKU');
    return a ? valueOf(a) : null;
  };
  return findSellerSku(v.attributes) || findSellerSku(v.attribute_combinations) || '';
}

/**
 * Actualizar solo el SKU de una variante. Enviamos:
 * - La variación a modificar: id + attributes (solo actualizamos SELLER_SKU en ese array).
 * - Las demás variaciones: solo { id } para que ML no las borre y no toque sus datos.
 */
export async function updateVariationSku(accessToken, itemId, variationId, sku) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  };
  const item = await getItem(accessToken, itemId);
  if (!item?.variations?.length) throw new Error('El ítem no tiene variaciones');
  const skuTrim = (sku || '').trim();
  const variations = item.variations.map((v) => {
    const isTarget = String(v.id) === String(variationId);
    if (isTarget) {
      const payload = {
        id: v.id,
        attributes: variationAttributesWithSku(v.attributes, skuTrim)
      };
      if (v.attribute_combinations?.length > 0) {
        payload.attribute_combinations = v.attribute_combinations;
      }
      return payload;
    }
    return { id: v.id };
  });
  const res = await fetch(`${BASE}/items/${itemId}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ variations })
  });
  if (!res.ok) {
    const errMsg = await errorMessage(res);
    throw new Error(errMsg);
  }
  return true;
}
