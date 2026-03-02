import fetch from 'node-fetch';

function getBaseUrl(storeId) {
  return `https://api.tiendanube.com/v1/${storeId}`;
}

/** TN doc: máx 2 req/s. Esperamos 500ms entre requests para no superar el límite. */
const MIN_INTERVAL_MS = 500;
let lastRequestAt = 0;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitRateLimit() {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < MIN_INTERVAL_MS) await delay(MIN_INTERVAL_MS - elapsed);
  lastRequestAt = Date.now();
}

/**
 * GET a la API TN con rate limit y retry en 429 (usa x-rate-limit-reset).
 */
async function fetchTn(url, options) {
  await waitRateLimit();
  let res = await fetch(url, options);
  if (res.status === 429) {
    const resetMs = res.headers.get('x-rate-limit-reset');
    const waitMs = resetMs ? Math.min(Number(resetMs), 15000) : 2000;
    await delay(waitMs);
    await waitRateLimit();
    res = await fetch(url, options);
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
 * Si responde 429 (Too Many Requests), espera según x-rate-limit-reset y reintenta una vez.
 * Doc TN: rate limit = 2 req/s (Leaky Bucket); header x-rate-limit-reset = ms hasta vaciar el bucket.
 */
export async function updateVariant(accessToken, storeId, productId, variantId, payload) {
  const url = `${getBaseUrl(storeId)}/products/${productId}/variants/${variantId}`;
  const doRequest = () =>
    fetch(url, {
      method: 'PUT',
      headers: {
        Authentication: `bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'ZonacuadernoSync/1.0'
      },
      body: JSON.stringify(payload)
    });

  let res = await doRequest();

  if (res.status === 429) {
    const resetMs = res.headers.get('x-rate-limit-reset');
    const waitMs = resetMs ? Math.min(Number(resetMs), 10000) : 2000;
    await delay(waitMs);
    res = await doRequest();
  }

  if (res.ok) return true;
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
  throw new Error(msg || `Tienda Nube respondió ${res.status}`);
}

/** Actualizar stock de una variante. TN acepta "stock" en el payload (deprecated pero funcional) o inventory_levels. */
export async function updateVariantStock(accessToken, storeId, productId, variantId, stock) {
  return updateVariant(accessToken, storeId, productId, variantId, { stock });
}

export async function updateVariantPrice(accessToken, storeId, productId, variantId, price) {
  return updateVariant(accessToken, storeId, productId, variantId, { price: String(price) });
}

/** Actualizar SKU de una variante. */
export async function updateVariantSku(accessToken, storeId, productId, variantId, sku) {
  return updateVariant(accessToken, storeId, productId, variantId, { sku: String(sku) });
}

export async function getOrder(accessToken, storeId, orderId) {
  const url = `${getBaseUrl(storeId)}/orders/${orderId}`;
  const res = await fetch(url, {
    headers: {
      Authentication: `bearer ${accessToken}`,
      'User-Agent': 'ZonacuadernoSync/1.0'
    }
  });
  if (!res.ok) return null;
  return res.json();
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

/** Registra los webhooks de órdenes en TN (order/paid, order/created, etc.) si no existen. */
export async function registerOrderWebhooks(accessToken, storeId, baseUrl) {
  const webhookUrl = baseUrl.replace(/\/$/, '') + '/api/webhooks/tiendanube';
  const events = ['order/paid', 'order/created', 'order/fulfilled', 'order/cancelled'];
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
