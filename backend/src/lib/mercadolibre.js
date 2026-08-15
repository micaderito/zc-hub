import fetch from 'node-fetch';
import { mlSchedule, pauseMlFor, recordMl429, recordMlOk, recordMlRequest } from './mlLimiter.js';

const BASE = 'https://api.mercadolibre.com';

/** Doc ML: "local_rate_limited (429): Inténtalo de nuevo en unos segundos." */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Espera ante un 429. Respeta Retry-After si viene; si no, backoff exponencial
 * (1.5s, 3s, 6s… cap 12s) con jitter para evitar que varias llamadas reintenten
 * todas en el mismo instante. Además pausa TODO el caño a ML (pauseMlFor) para
 * que un solo 429 frene a las demás llamadas pendientes, no solo a esta.
 *
 * El backoff base es corto a propósito: ML documenta "inténtalo de nuevo en unos
 * segundos" y como pausa TODO el caño, un base grande (antes 10s) congelaba la app
 * entera por cada 429. Con la Fase C casi no hay 429, así que priorizamos recuperar
 * rápido cuando aparece uno aislado.
 */
function waitFor429(res, context = '', attemptIndex = 0) {
  if (res.status !== 429) return Promise.resolve();
  const retryAfter = res.headers.get('retry-after');
  let secs;
  if (retryAfter) {
    secs = parseInt(retryAfter, 10) || 1;
  } else {
    const base = Math.min(1.5 * Math.pow(2, attemptIndex), 12);
    // Jitter ±25% para desincronizar reintentos concurrentes.
    secs = base * (0.75 + Math.random() * 0.5);
  }
  const ms = Math.min(secs * 1000, 15000);
  pauseMlFor(ms / 1000);
  console.warn(`[ML] 429 ${context}, esperando ${Math.round(ms / 1000)}s antes de reintentar (doc: unos segundos)`);
  return sleep(ms);
}

/** Máximo de reintentos ante 429 (intentos totales = max429Retries + 1). */
const MAX_429_RETRIES = 5;

/**
 * GET (o otro) a la API de ML con reintentos ante 429. Respeta Retry-After; si no
 * viene, backoff exponencial con jitter. Cada intento pasa por el limitador global
 * (mlSchedule), que espacia los requests y respeta el cooldown por 429.
 */
export async function fetchWith429Retry(url, options = {}, context = '') {
  recordMlRequest(context);
  let res = await mlSchedule(() => fetch(url, options));
  for (let r = 0; r < MAX_429_RETRIES && res.status === 429; r++) {
    // Alimenta el circuit breaker global: N 429 consecutivos abren el circuito y pausan TODO el
    // caño por un cooldown escalado, para que un bloqueo sostenido de ML pueda levantarse.
    const cooldownMs = recordMl429(context);
    if (cooldownMs > 0) {
      console.warn(`[ML] circuit breaker abierto tras 429 sostenidos: pausando TODO el caño ${Math.round(cooldownMs / 1000)}s (${context})`);
    }
    await waitFor429(res, context, r);
    res = await mlSchedule(() => fetch(url, options));
  }
  if (res.status !== 429) recordMlOk();
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
    mlSchedule(() => fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: OAUTH_HEADERS,
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.ML_CLIENT_ID,
        client_secret: process.env.ML_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri
      })
    }));
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
    mlSchedule(() => fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: OAUTH_HEADERS,
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: process.env.ML_CLIENT_ID,
        client_secret: process.env.ML_CLIENT_SECRET,
        refresh_token: refreshToken
      })
    }));
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
    mlSchedule(() => fetch(`${BASE}/users/me`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    }));
  let res = await doRequest();
  if (res.status === 429) {
    await waitFor429(res, 'getMe');
    res = await doRequest();
  }
  if (!res.ok) return null;
  return res.json();
}

/**
 * Costos de publicación de ML para un precio dado (la "calculadora" oficial).
 * GET /sites/{site}/listing_prices?price=X&listing_type_id=...&category_id=...
 *
 * Devuelve `sale_fee_details` con el desglose que usamos para llenar el motor de precios:
 *   - meli_percentage_fee: comisión pura por vender (nuestro "15%")
 *   - fixed_fee: cargo fijo por venta (nuestros tramos 1115/2300/2810/0)
 *   - percentage_fee: comisión total (incluye el add-on de cuotas si lo hay)
 *
 * Endpoint público en cuanto al recurso, pero ML exige token (cerró el acceso anónimo en 2025).
 * En Argentina conviene mandar billable_weight/logistic_type para que el fixed_fee coincida con
 * lo que realmente se cobra; sin eso, es una aproximación (suficiente para precargar Ajustes).
 */
export async function getListingPrices(accessToken, { price, siteId = 'MLA', listingTypeId, categoryId, extraParams = {} } = {}) {
  const params = new URLSearchParams({ price: String(price) });
  if (listingTypeId) params.set('listing_type_id', listingTypeId);
  if (categoryId) params.set('category_id', categoryId);
  for (const [k, v] of Object.entries(extraParams)) if (v != null) params.set(k, String(v));

  const res = await fetchWith429Retry(
    `${BASE}/sites/${siteId}/listing_prices?${params.toString()}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    'getListingPrices'
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`listing_prices ${res.status}: ${body.slice(0, 200)}`);
    err.mlStatus = res.status;
    throw err;
  }
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

/** ML permite pedir como máximo 20 ítems por llamada al multiget. */
const MULTIGET_MAX_IDS = 20;

/**
 * Multiget de ítems: GET /items?ids=ID1,ID2,...&attributes=...
 * Trae hasta 20 ítems por request (los pedimos en tandas), en vez de un GET por ítem.
 * ML responde un array "verb format": [{ code, body }, ...]; devolvemos solo los body
 * de las entradas con code 200. `attributes` (opcional) limita los campos a traer.
 *
 * Nota: ML documenta `include_attributes=all` solo en el GET de un ítem. Acá pedimos
 * `variations` como campo del ítem; trae el array con su `seller_sku`. Si en producción
 * se observa que el multiget no devuelve `variations`, hay que volver a getItem para
 * los ítems con variantes (ver propuesta).
 */
export async function getItems(accessToken, ids, attributes) {
  const all = (ids || []).map((x) => String(x)).filter(Boolean);
  const out = [];
  for (let i = 0; i < all.length; i += MULTIGET_MAX_IDS) {
    const chunk = all.slice(i, i + MULTIGET_MAX_IDS);
    const params = new URLSearchParams({ ids: chunk.join(',') });
    if (attributes) params.set('attributes', attributes);
    const res = await fetchWith429Retry(
      `${BASE}/items?${params.toString()}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      'getItems'
    );
    if (!res.ok) {
      console.warn('[ML] getItems falló:', res.status, chunk.length, 'ids');
      continue;
    }
    const arr = await res.json();
    for (const entry of Array.isArray(arr) ? arr : []) {
      if (entry?.code === 200 && entry.body) out.push(entry.body);
    }
  }
  return out;
}

/**
 * Crear una publicación: POST /items con el body ya armado (title, category_id, price,
 * currency_id, available_quantity/variations, condition, listing_type_id, attributes,
 * sale_terms, pictures, shipping…). Devuelve el ítem creado o lanza con el mensaje real de ML.
 */
export async function createItem(accessToken, itemBody) {
  const res = await fetchWith429Retry(
    `${BASE}/items`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(itemBody)
    },
    'createItem'
  );
  if (!res.ok) {
    const errBody = await errorMessage(res);
    console.error('[ML] createItem → HTTP %s: %s', res.status, errBody);
    throw Object.assign(new Error(errBody || `HTTP ${res.status}`), { mlStatus: res.status });
  }
  return res.json();
}

/**
 * Setea la descripción (texto plano) de un ítem: ML la maneja como recurso APARTE, no en POST /items.
 * POST /items/{id}/description; si el ítem ya tiene descripción, cae a PUT ?api_version=2.
 * Solo texto plano (saltos de línea con \n; sin HTML). No lanza: la publicación ya existe.
 */
export async function setItemDescription(accessToken, itemId, plainText) {
  const text = String(plainText || '');
  if (!text.trim()) return false;
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  const body = JSON.stringify({ plain_text: text });
  let res = await fetchWith429Retry(`${BASE}/items/${itemId}/description`, { method: 'POST', headers, body }, 'setItemDescription');
  if (res.status === 400) {
    // Ya existía una descripción → editar con PUT.
    res = await fetchWith429Retry(`${BASE}/items/${itemId}/description?api_version=2`, { method: 'PUT', headers, body }, 'setItemDescription:put');
  }
  if (!res.ok) {
    console.warn('[ML] setItemDescription %s → HTTP %s: %s', itemId, res.status, await errorMessage(res));
    return false;
  }
  return true;
}

/**
 * Sube una imagen binaria a ML y devuelve su `picture_id` reutilizable.
 * POST /pictures/items/upload — multipart/form-data, campo `file`, token del vendedor.
 * Usa el `fetch` GLOBAL (Node) con FormData/Blob nativos (node-fetch v3 no serializa bien el
 * FormData global). Igual pasa por mlSchedule para respetar el rate limit. ML: JPG/PNG, ≤10MB.
 */
export async function uploadPicture(accessToken, buffer, filename, mime) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime || 'application/octet-stream' }), filename || 'image.jpg');
  recordMlRequest('uploadPicture');
  const res = await mlSchedule(() =>
    globalThis.fetch(`${BASE}/pictures/items/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` }, // el boundary lo pone FormData
      body: form
    })
  );
  if (!res.ok) {
    const errBody = await errorMessage(res);
    console.error('[ML] uploadPicture → HTTP %s: %s', res.status, errBody);
    throw Object.assign(new Error(errBody || `HTTP ${res.status}`), { mlStatus: res.status });
  }
  const json = await res.json();
  if (!json?.id) throw new Error('ML no devolvió picture id al subir la imagen');
  return json.id;
}

/* ============================ Categorías ============================ */

/**
 * Categorías raíz de un sitio: GET /sites/{site}/categories → array plano [{ id, name }, ...]
 * (solo las ~30 raíz, sin children). Es el punto de entrada para navegar el árbol.
 * El endpoint es público, pero mandamos el token igual (es inocuo y unifica el manejo de 429).
 */
export async function getSiteCategories(accessToken, siteId = 'MLA') {
  const res = await fetchWith429Retry(
    `${BASE}/sites/${siteId}/categories`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    'getSiteCategories'
  );
  if (!res.ok) {
    console.warn('[ML] getSiteCategories falló:', res.status, siteId);
    return null;
  }
  return res.json();
}

/**
 * Detalle de una categoría: GET /categories/{id} → { id, name, path_from_root[],
 * children_categories[], settings, attribute_types, ... }. Se usa para navegar el árbol
 * (siguiendo children_categories) y para saber si una categoría es HOJA
 * (children_categories vacío) y si permite publicar (settings.listing_allowed).
 */
export async function getCategory(accessToken, categoryId) {
  const res = await fetchWith429Retry(
    `${BASE}/categories/${categoryId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    'getCategory'
  );
  if (!res.ok) {
    console.warn('[ML] getCategory falló:', res.status, categoryId);
    return null;
  }
  return res.json();
}

/**
 * Atributos de una categoría: GET /categories/{id}/attributes → array de atributos con
 * { id, name, value_type, tags: { required, new_required, ... }, values: [{ id, name }] }.
 * Sirve para saber qué atributos son obligatorios al publicar y renderizarlos según su tipo.
 */
export async function getCategoryAttributes(accessToken, categoryId) {
  const res = await fetchWith429Retry(
    `${BASE}/categories/${categoryId}/attributes`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    'getCategoryAttributes'
  );
  if (!res.ok) {
    console.warn('[ML] getCategoryAttributes falló:', res.status, categoryId);
    return null;
  }
  return res.json();
}

/**
 * Predictor de categoría por título: GET /sites/{site}/domain_discovery/search?q={título}
 * → array ordenado por confianza [{ domain_id, domain_name, category_id, category_name,
 * attributes: [{ id, name, value_id, value_name }] }]. Siempre devuelve categorías HOJA,
 * así evita que el usuario elija una intermedia. Para MLA funciona en español.
 */
export async function predictCategory(accessToken, q, siteId = 'MLA', limit = 5) {
  const params = new URLSearchParams({ q: String(q || '').trim(), limit: String(limit) });
  const res = await fetchWith429Retry(
    `${BASE}/sites/${siteId}/domain_discovery/search?${params.toString()}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    'predictCategory'
  );
  if (!res.ok) {
    console.warn('[ML] predictCategory falló:', res.status, q);
    return null;
  }
  return res.json();
}

/** Pack (nro de venta): GET https://api.mercadolibre.com/packs/:packId → { id, orders: [{ id: orderId }, ...], shipment, status, ... }. Reintenta ante 429. */
export async function getPack(accessToken, packId) {
  const url = `${BASE}/packs/${packId}`;
  const res = await fetchWith429Retry(
    url,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    'getPack'
  );
  if (!res.ok) {
    const text = await res.text();
    console.warn('[ML] getPack failed:', res.status, packId, text?.slice(0, 150));
    return null;
  }
  return res.json();
}

/** Orden: GET https://api.mercadolibre.com/orders/:orderId → { id, pack_id, order_items: [{ item: { id, title }, quantity }, ...], payments, status, ... }. Reintenta ante 429. */
export async function getOrder(accessToken, orderId) {
  const url = `${BASE}/orders/${orderId}`;
  const res = await fetchWith429Retry(
    url,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    'getOrder'
  );
  if (!res.ok) {
    const text = await res.text();
    console.warn('[ML] getOrder failed:', res.status, orderId, text?.slice(0, 200));
    if (res.status === 429) {
      const e = new Error(`ML rate limited (429) order ${orderId}`);
      e.statusCode = 429;
      throw e;
    }
    return null;
  }
  return res.json();
}

/** Buscar órdenes del vendedor (orders/search). Params: seller, q (order id / item id / título), item (ID o título del ítem), limit, offset. Ver doc: Filtrar órdenes. */
export async function getOrdersSearch(accessToken, params = {}) {
  const q = new URLSearchParams();
  if (params.seller != null) q.set('seller', params.seller);
  if (params.q != null && params.q !== '') q.set('q', String(params.q).trim());
  if (params.item != null && params.item !== '') q.set('item', String(params.item).trim());
  if (params.limit != null) q.set('limit', params.limit);
  if (params.offset != null) q.set('offset', params.offset);
  const url = `${BASE}/orders/search?${q.toString()}`;
  const res = await fetchWith429Retry(
    url,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    'getOrdersSearch'
  );
  if (!res.ok) {
    const text = await res.text();
    console.warn('[ML] getOrdersSearch failed:', res.status, text?.slice(0, 200));
    if (res.status === 429) {
      const e = new Error('ML rate limited (429) getOrdersSearch');
      e.statusCode = 429;
      throw e;
    }
    return null;
  }
  return res.json();
}

/** Detalle de un reclamo por ID (post-purchase v1). Reintenta ante 429. */
export async function getClaim(accessToken, claimId) {
  const res = await fetchWith429Retry(
    `${BASE}/post-purchase/v1/claims/${claimId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    'getClaim'
  );
  if (!res.ok) return null;
  return res.json();
}

/** Listar reclamos/devoluciones del vendedor (post-purchase). ML exige al menos: [resource+resource_id] o [player_role+player_user_id]. Reintenta ante 429. */
export async function getClaimsSearch(accessToken, params = {}) {
  const q = new URLSearchParams();
  if (params.limit != null) q.set('limit', params.limit);
  if (params.offset != null) q.set('offset', params.offset);
  if (params.status) q.set('status', params.status);
  if (params.stage) q.set('stage', params.stage);
  if (params.type) q.set('type', params.type);
  if (params.resource) q.set('resource', params.resource);
  if (params.resource_id) q.set('resource_id', params.resource_id);
  if (params.player_role) q.set('player_role', params.player_role);
  if (params.player_user_id != null) q.set('player_user_id', params.player_user_id);
  if (params.range) q.set('range', params.range);
  const url = `${BASE}/post-purchase/v1/claims/search?${q.toString()}`;
  const res = await fetchWith429Retry(url, { headers: { Authorization: `Bearer ${accessToken}` } }, 'getClaimsSearch');
  if (!res.ok) {
    const text = await res.text();
    console.warn('[ML] getClaimsSearch failed:', res.status, text?.slice(0, 200));
    return null;
  }
  return res.json();
}

/**
 * Un reclamo tiene una devolución asociada si `related_entities` incluye `"return"` (así lo
 * indica la doc de ML: es el campo que hay que mirar, no `type`). `type === 'return'` se
 * mantiene como respaldo porque la doc es inconsistente entre versiones, pero por sí solo pierde
 * devoluciones que llegan como `type: 'mediations'` (p. ej. producto defectuoso).
 */
export function claimHasReturn(claim) {
  if (!claim) return false;
  if (Array.isArray(claim.related_entities) && claim.related_entities.includes('return')) return true;
  return (claim.type || '').toLowerCase() === 'return';
}

/** Detalle de devoluciones de un reclamo. Devuelve info de envío y puede incluir ítems. Reintenta ante 429. */
export async function getClaimReturns(accessToken, claimId) {
  const res = await fetchWith429Retry(
    `${BASE}/post-purchase/v2/claims/${claimId}/returns`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    'getClaimReturns'
  );
  if (!res.ok) return null;
  return res.json();
}

/**
 * Envío: GET https://api.mercadolibre.com/shipments/:shipmentId → { id, status, substatus, ... }.
 * Sirve para saber si la mercadería llegó a salir del depósito: una orden cancelada con envío en
 * `not_delivered`/`returning_to_sender` es una devolución en tránsito (todavía no la tenemos),
 * no una cancelación previa al despacho. Reintenta ante 429.
 */
export async function getShipment(accessToken, shipmentId) {
  const res = await fetchWith429Retry(
    `${BASE}/shipments/${shipmentId}`,
    { headers: { Authorization: `Bearer ${accessToken}`, 'x-format-new': 'true' } },
    'getShipment'
  );
  if (!res.ok) {
    const text = await res.text();
    console.warn('[ML] getShipment failed:', res.status, shipmentId, text?.slice(0, 150));
    if (res.status === 429) {
      const e = new Error(`ML rate limited (429) shipment ${shipmentId}`);
      e.statusCode = 429;
      throw e;
    }
    return null;
  }
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

/** Actualizar precio de un ítem simple. Lanza error con el mensaje de ML si falla. */
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
  if (!res.ok) {
    const errBody = await errorMessage(res);
    console.error('[ML] updateItemPrice %s → HTTP %s: %s', itemId, res.status, errBody);
    throw Object.assign(new Error(errBody || `HTTP ${res.status}`), { mlStatus: res.status });
  }
  return true;
}

/**
 * Actualizar precio de un ítem o variación.
 *
 * IMPORTANTE: en ítems con array `variations` (formato legacy, anterior a User Products),
 * la API de ML EXIGE el mismo precio en todas las variaciones. Si se mandan precios distintos
 * rechaza con "Found different prices in variations". El precio por variación solo existe en
 * ítems creados bajo el modelo User Products (sin array `variations`; cada variación es un ítem
 * `MLA` propio que se edita con `PUT /items/{itemId}` sin variationId).
 * Ref: https://developers.mercadolibre.com.ar/en_us/price-per-variation
 *
 * - Con variationId (ítem legacy con variaciones): aplica el nuevo precio a TODAS las
 *   variaciones del ítem (única operación que ML acepta). El front confirma con el usuario.
 * - Sin variationId: actualiza el ítem simple / User Product directamente.
 */
export async function updateItemOrVariationPrice(accessToken, itemId, variationId, price) {
  if (variationId != null && variationId !== '') {
    const item = await getItem(accessToken, itemId);
    if (!item?.variations?.length) {
      // Sin array variations: es un ítem simple (o User Product) — precio directo.
      return updateItemPrice(accessToken, itemId, price);
    }
    const newPrice = Number(price);
    // ML legacy: mismo precio en todas las variaciones (ver nota arriba).
    const variations = item.variations.map(v => ({ id: Number(v.id ?? v.id_plain), price: newPrice }));
    const res = await fetchWith429Retry(
      `${BASE}/items/${itemId}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ variations })
      },
      'updateVariationPrice'
    );
    if (!res.ok) {
      const errBody = await errorMessage(res);
      console.error('[ML] updateVariationPrice %s/%s → HTTP %s: %s', itemId, variationId, res.status, errBody);
      throw Object.assign(new Error(errBody || `HTTP ${res.status}`), { mlStatus: res.status });
    }
    return true;
  }
  return updateItemPrice(accessToken, itemId, price);
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
  let res = await fetchWith429Retry(
    `${BASE}/items/${itemId}`,
    { method: 'PUT', headers, body: JSON.stringify({ seller_sku: sku }) },
    'updateItemSku'
  );
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
  res = await fetchWith429Retry(
    `${BASE}/items/${itemId}`,
    { method: 'PUT', headers, body: JSON.stringify({ attributes }) },
    'updateItemSku:attributes'
  );
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
  const res = await fetchWith429Retry(
    `${BASE}/items/${itemId}`,
    { method: 'PUT', headers, body: JSON.stringify({ variations }) },
    'updateVariationSku'
  );
  if (!res.ok) {
    const errMsg = await errorMessage(res);
    throw new Error(errMsg);
  }
  return true;
}
