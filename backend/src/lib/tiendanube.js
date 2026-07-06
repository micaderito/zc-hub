import fetch from 'node-fetch';
import { tnSchedule, pauseTnFor, sleep } from './tnLimiter.js';

function getBaseUrl(storeId) {
  return `https://api.tiendanube.com/v1/${storeId}`;
}

const delay = sleep;

/** Máximo de reintentos ante 429 (intentos totales = MAX_429_RETRIES + 1). */
const MAX_429_RETRIES = 4;

/**
 * Toda request a la API de TN pasa por acá: la encola en el limitador global (tnSchedule, que
 * espacia a ~2 req/s y respeta el cooldown por 429) y reintenta ante 429 respetando el header
 * `x-rate-limit-reset` (ms hasta que el leaky bucket se vacíe). Al reintentar pausa TODO el caño
 * (pauseTnFor) para que un solo 429 frene también a las demás llamadas pendientes, no solo a esta.
 * Devuelve el `res` final (los callers manejan .ok/.json).
 */
async function fetchTn(url, options, retries = MAX_429_RETRIES) {
  let res = await tnSchedule(() => fetch(url, options));
  for (let r = 0; r < retries && res.status === 429; r++) {
    const resetMs = Number(res.headers.get('x-rate-limit-reset'));
    const waitMsVal = Number.isFinite(resetMs) && resetMs > 0 ? Math.min(resetMs, 15000) : 2000;
    pauseTnFor(waitMsVal / 1000);
    console.warn(`[TN] 429, esperando ${Math.round(waitMsVal / 1000)}s antes de reintentar (x-rate-limit-reset)`);
    await delay(waitMsVal);
    res = await tnSchedule(() => fetch(url, options));
  }
  return res;
}

export async function getAuthUrl(redirectUri, state) {
  const appId = process.env.TN_CLIENT_ID;
  const params = new URLSearchParams({
    redirect_uri: redirectUri,
    state: state || 'tn'
  });
  return `https://www.tiendanube.com/apps/${appId}/authorize?${params}`;
}

export async function exchangeCodeForToken(code, redirectUri) {
  const body = {
    client_id: process.env.TN_CLIENT_ID,
    client_secret: process.env.TN_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code
  };
  if (redirectUri) body.redirect_uri = redirectUri;
  const res = await fetch('https://www.tiendanube.com/apps/authorize/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`TN token error: ${res.status} ${err}`);
  }
  return res.json();
}

/** Extrae array de una respuesta que puede ser array directo o { data: [] }. */
function toList(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  if (data && Array.isArray(data.results)) return data.results;
  return [];
}

/** GET /products con paginación: trae todos los productos. Rate limit 2 req/s; 429 → retry. */
export async function getProducts(accessToken, storeId) {
  const perPage = 100;
  const all = [];
  const maxPages = 200;
  const headers = {
    Authentication: `bearer ${accessToken}`,
    'User-Agent': 'ZonacuadernoSync/1.0'
  };
  for (let page = 1; page <= maxPages; page++) {
    const url = `${getBaseUrl(storeId)}/products?page=${page}&per_page=${perPage}`;
    const res = await fetchTn(url, { headers });
    if (!res.ok) {
      if (res.status === 401) {
        const err = new Error(await res.text());
        err.status = 401;
        throw err;
      }
      throw new Error(`TN products page ${page}: ${res.status}`);
    }
    const data = await res.json();
    const list = toList(data);
    all.push(...list);
    if (list.length < perPage) break;
  }
  return all;
}

/** GET /products/:id/variants con paginación. Rate limit 2 req/s; 429 → retry. No devuelve lista parcial. */
export async function getProductVariants(accessToken, storeId, productId) {
  const perPage = 100;
  const all = [];
  const headers = {
    Authentication: `bearer ${accessToken}`,
    'User-Agent': 'ZonacuadernoSync/1.0'
  };
  for (let page = 1; page <= 50; page++) {
    const url = `${getBaseUrl(storeId)}/products/${productId}/variants?page=${page}&per_page=${perPage}`;
    const res = await fetchTn(url, { headers });
    if (!res.ok) {
      if (res.status === 401) {
        const err = new Error(await res.text());
        err.status = 401;
        throw err;
      }
      throw new Error(`TN variants product ${productId} page ${page}: ${res.status}`);
    }
    const data = await res.json();
    const list = toList(data);
    all.push(...list);
    if (list.length < perPage) break;
  }
  return all;
}

export async function getProductImages(accessToken, storeId, productId) {
  const url = `${getBaseUrl(storeId)}/products/${productId}/images`;
  const headers = {
    Authentication: `bearer ${accessToken}`,
    'User-Agent': 'ZonacuadernoSync/1.0'
  };
  const res = await fetchTn(url, { headers });
  if (!res.ok) {
    if (res.status === 401) {
      const err = new Error(await res.text());
      err.status = 401;
      throw err;
    }
    return [];
  }
  const data = await res.json();
  let list = toList(data);
  if (list.length === 0 && data && Array.isArray(data.images)) list = data.images;
  // Normalizar: asegurar que cada imagen tenga .src (API puede devolver .url en algunos casos)
  return list.map(img => ({
    ...img,
    id: img?.id ?? img?.image_id,
    src: img?.src ?? img?.url ?? img?.src_url ?? null
  }));
}

/**
 * PUT variante. Si falla, lanza Error con el mensaje del body de TN.
 * Pasa por el limitador global (fetchTn), que espacia los requests, comparte el gate con TODAS
 * las llamadas TN (GETs y writes de cualquier ruta + sync) y reintenta ante 429 respetando
 * x-rate-limit-reset. Doc TN: rate limit = 2 req/s (Leaky Bucket); header = ms hasta vaciar el bucket.
 */
export async function updateVariant(accessToken, storeId, productId, variantId, payload) {
  const url = `${getBaseUrl(storeId)}/products/${productId}/variants/${variantId}`;
  const res = await fetchTn(url, {
    method: 'PUT',
    headers: {
      Authentication: `bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'ZonacuadernoSync/1.0'
    },
    body: JSON.stringify(payload)
  });

  if (res.ok) return true;
  throw new Error(await parseTnError(res));
}

/** Traduce el body de error de TN a un mensaje legible (maneja errors array/objeto/string). */
async function parseTnError(res) {
  const text = await res.text();
  let msg = text;
  try {
    const j = JSON.parse(text);
    if (j.errors) {
      if (Array.isArray(j.errors)) {
        msg = j.errors.map(e => e.message || e).join('; ');
      } else if (typeof j.errors === 'object') {
        const parts = [];
        for (const [field, val] of Object.entries(j.errors)) {
          const list = Array.isArray(val) ? val : [val];
          parts.push(`${field}: ${list.map(m => typeof m === 'string' ? m : m?.message || JSON.stringify(m)).join(', ')}`);
        }
        msg = parts.length ? parts.join('; ') : j.message || j.description || text;
      } else {
        msg = String(j.errors);
      }
    }
    if (!msg || msg === text) msg = j.message || j.error || j.description || msg || text;
  } catch (_) {}
  return msg || `Tienda Nube respondió ${res.status}`;
}

/** Actualizar stock de una variante. TN acepta "stock" en el payload (deprecated pero funcional) o inventory_levels. */
export async function updateVariantStock(accessToken, storeId, productId, variantId, stock) {
  return updateVariant(accessToken, storeId, productId, variantId, { stock });
}

export async function updateVariantPrice(accessToken, storeId, productId, variantId, price) {
  return updateVariant(accessToken, storeId, productId, variantId, { price: String(price) });
}

/** TN: máximo de variantes por request al endpoint bulk (contando todos los productos). */
const BULK_MAX_VARIANTS = 50;

/**
 * Bulk `PATCH /products/stock-price`: actualiza precio y/o stock de muchas variantes (de uno o
 * varios productos) en una sola request. Reemplaza N PUTs por ceil(N/50) requests — clave para el
 * caso "lista de precios nueva".
 *
 * `updates` = [{ productId, variantId, price?, stock? }]. Devuelve true si todo salió OK.
 * TN acepta hasta 50 variantes por request (más → 422 "Too many variants sent for update"), así
 * que se parte en chunks; cada chunk pasa por el limitador (fetchTn) con retry ante 429.
 * Body TN: [{ id: productId, variants: [{ id: variantId, price, inventory_levels: [{ stock }] }] }].
 */
export async function updateVariantsStockPrice(accessToken, storeId, updates) {
  const list = (updates || []).filter((u) => u && u.productId != null && u.variantId != null);
  if (list.length === 0) return true;
  const headers = {
    Authentication: `bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': 'ZonacuadernoSync/1.0'
  };
  const url = `${getBaseUrl(storeId)}/products/stock-price`;
  for (let i = 0; i < list.length; i += BULK_MAX_VARIANTS) {
    const chunk = list.slice(i, i + BULK_MAX_VARIANTS);
    // Agrupar por producto: el body es un array de productos, cada uno con sus variantes.
    const byProduct = new Map();
    for (const u of chunk) {
      const key = String(u.productId);
      if (!byProduct.has(key)) byProduct.set(key, { id: Number(u.productId), variants: [] });
      const variant = { id: Number(u.variantId) };
      if (u.price != null) variant.price = String(u.price);
      if (u.stock != null) variant.inventory_levels = [{ stock: Math.max(0, Math.floor(Number(u.stock))) }];
      byProduct.get(key).variants.push(variant);
    }
    const body = Array.from(byProduct.values());
    const res = await fetchTn(url, { method: 'PATCH', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(await parseTnError(res));
  }
  return true;
}

/**
 * Aplicar el mismo precio a TODAS las variantes de un producto TN.
 * A diferencia de ML, en TN el precio vive en cada variante de forma independiente
 * (no hay reconciliación server-side), así que "aplicar a todas" es una elección de UX,
 * no una limitación de la API. Usa el bulk endpoint: 1 request cada 50 variantes en vez de 1 por variante.
 */
export async function updateVariantPriceAllVariants(accessToken, storeId, productId, price) {
  const variants = await getProductVariants(accessToken, storeId, productId);
  if (variants.length === 0) return true;
  await updateVariantsStockPrice(
    accessToken,
    storeId,
    variants.map((v) => ({ productId, variantId: v.id, price }))
  );
  return true;
}

/** Actualizar SKU de una variante. */
export async function updateVariantSku(accessToken, storeId, productId, variantId, sku) {
  return updateVariant(accessToken, storeId, productId, variantId, { sku: String(sku) });
}

export async function getOrder(accessToken, storeId, orderId) {
  const url = `${getBaseUrl(storeId)}/orders/${orderId}`;
  const res = await fetchTn(url, {
    headers: {
      Authentication: `bearer ${accessToken}`,
      'User-Agent': 'ZonacuadernoSync/1.0'
    }
  });
  if (!res.ok) return null;
  return res.json();
}

/** GET /products/:id — un producto con sus variants e images embebidos (para refrescar el snapshot). */
export async function getProduct(accessToken, storeId, productId) {
  const url = `${getBaseUrl(storeId)}/products/${productId}`;
  const res = await fetchTn(url, {
    headers: {
      Authentication: `bearer ${accessToken}`,
      'User-Agent': 'ZonacuadernoSync/1.0'
    }
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    if (res.status === 401) {
      const err = new Error(await res.text());
      err.status = 401;
      throw err;
    }
    throw new Error(`TN getProduct ${productId}: ${res.status}`);
  }
  return res.json();
}

/**
 * Busca una orden por su número visible (order.number, el "nro de venta" que ve el dueño en TN),
 * que NO es el id interno que espera GET /orders/:id. Recorre /orders paginado (más recientes
 * primero) hasta encontrar el número o agotar maxPages. Devuelve la orden completa o null.
 */
export async function findOrderByNumber(accessToken, storeId, number) {
  const target = String(number).trim();
  if (!target) return null;
  const perPage = 100;
  const maxPages = 20;
  const headers = {
    Authentication: `bearer ${accessToken}`,
    'User-Agent': 'ZonacuadernoSync/1.0'
  };
  for (let page = 1; page <= maxPages; page++) {
    const url = `${getBaseUrl(storeId)}/orders?page=${page}&per_page=${perPage}`;
    const res = await fetchTn(url, { headers });
    if (!res.ok) return null;
    const data = await res.json();
    const list = toList(data);
    const match = list.find(o => String(o.number) === target || String(o.id) === target);
    if (match) return match;
    if (list.length < perPage) break;
  }
  return null;
}

/** GET /webhooks - lista webhooks registrados en la tienda. */
export async function getWebhooks(accessToken, storeId) {
  const url = `${getBaseUrl(storeId)}/webhooks`;
  const res = await fetchTn(url, {
    headers: {
      Authentication: `bearer ${accessToken}`,
      'User-Agent': 'ZonacuadernoSync/1.0'
    }
  });
  if (!res.ok) return [];
  const data = await res.json();
  return toList(data);
}

/** POST /webhooks - registra un webhook (evento + URL). */
export async function createWebhook(accessToken, storeId, event, url) {
  const apiUrl = `${getBaseUrl(storeId)}/webhooks`;
  const res = await fetchTn(apiUrl, {
    method: 'POST',
    headers: {
      Authentication: `bearer ${accessToken}`,
      'User-Agent': 'ZonacuadernoSync/1.0',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ event, url })
  });
  if (!res.ok) {
    const errText = await res.text();
    if (res.status === 403 && /scope/i.test(errText)) {
      throw new Error(
        'Tienda Nube: falta permiso de Órdenes. En https://partners.tiendanube.com → tu app → Editar datos → Permisos, activá "Órdenes" (read_orders/write_orders). Luego desconectá y volvé a conectar Tienda Nube en esta app.'
      );
    }
    throw new Error(`TN createWebhook ${event}: ${res.status} ${errText}`);
  }
  return res.json();
}

/**
 * Registra los webhooks de TN que necesita la app (si no existen ya con la misma URL):
 *  - órdenes (order/*) → descuento/restauración de stock,
 *  - productos (product/*) → mantener fresco el snapshot cuando editan un producto por fuera de
 *    la app (análogo al topic `items` de ML). Requiere scope read_products (que ya usamos para el crawl).
 */
export async function registerOrderWebhooks(accessToken, storeId, baseUrl) {
  const webhookUrl = baseUrl.replace(/\/$/, '') + '/api/webhooks/tiendanube';
  const events = [
    'order/paid', 'order/created', 'order/fulfilled', 'order/cancelled',
    'product/created', 'product/updated', 'product/deleted'
  ];
  const existing = await getWebhooks(accessToken, storeId);
  const byEvent = new Map(existing.map((w) => [w.event, w]));
  const created = [];
  for (const event of events) {
    if (byEvent.get(event)?.url === webhookUrl) continue;
    const w = await createWebhook(accessToken, storeId, event, webhookUrl);
    created.push({ event, id: w.id });
  }
  return created;
}
