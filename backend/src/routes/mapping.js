import { Router } from 'express';
import { getResolvedMappings, tokens, getMlToken, persistTokens } from '../store.js';
import { persistSkuToChannels } from '../services/syncService.js';
import * as ml from '../lib/mercadolibre.js';
import * as tn from '../lib/tiendanube.js';

export const mappingRoutes = Router();

/** Lista los pares vinculados por SKU (mismo SKU en ML y TN). Se rellena desde el análisis. */
mappingRoutes.get('/', (_, res) => {
  const list = getResolvedMappings();
  res.json(list);
});

/** Igualar SKU en ML y TN (igual que POST /conflicts/link). No guardamos mapeo aparte. */
mappingRoutes.post('/', async (req, res) => {
  const { sku, mercadolibre, tiendanube, priceML, priceTN } = req.body;
  if (!sku) return res.status(400).json({ error: 'sku es requerido' });
  if (!mercadolibre?.itemId || tiendanube?.productId == null || tiendanube?.variantId == null) {
    return res.status(400).json({ error: 'mercadolibre (itemId) y tiendanube (productId, variantId) son requeridos' });
  }
  const entry = {
    sku: sku.trim(),
    mercadolibre: { itemId: mercadolibre.itemId, variationId: mercadolibre.variationId },
    tiendanube: { productId: Number(tiendanube.productId), variantId: Number(tiendanube.variantId) },
    priceML: priceML ?? 0,
    priceTN: priceTN ?? 0
  };
  try {
    const persisted = await persistSkuToChannels(entry);
    return res.json({ ok: true, sku: entry.sku, persisted });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/** Ya no hay mapeo persistido; PUT y DELETE son no-op (la vinculación es por SKU en las plataformas). */
mappingRoutes.put('/:sku', (_, res) => res.json({ ok: true }));
mappingRoutes.delete('/:sku', (_, res) => res.json({ ok: true }));

/** Listar publicaciones de ML del usuario (para mapear por SKU). */
mappingRoutes.get('/sources/mercadolibre', async (_, res) => {
  const accessToken = await getMlToken();
  if (!accessToken) return res.status(401).json({ error: 'No conectado a Mercado Libre' });
  let userId = tokens.mercadolibre?.user_id;
  if (!userId) {
    try {
      const me = await ml.getMe(accessToken);
      if (me?.id != null) {
        tokens.mercadolibre.user_id = me.id;
        persistTokens();
        userId = me.id;
        console.log('[ML] user_id obtenido en /sources/mercadolibre:', userId);
      }
    } catch (e) {
      console.warn('[ML] getMe falló en sources:', e.message);
    }
  }
  if (!userId) {
    return res.status(503).json({
      error: 'Falta el user_id de Mercado Libre. Desconectá y volvé a conectar ML en Inicio para que se guarde.'
    });
  }
  try {
    const r = await fetch(
      `https://api.mercadolibre.com/users/${userId}/items/search?limit=50&catalog_listing=false`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!r.ok) throw new Error(await r.text());
    const { results } = await r.json();
    const items = await Promise.all(
      (results || []).slice(0, 50).map(id =>
        fetch(`https://api.mercadolibre.com/items/${id}`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        }).then(r => r.json())
      )
    );
    const originalsOnly = items.filter(it => it && it.catalog_listing !== true);
    const withSku = originalsOnly.map(it => ({
      id: it.id,
      title: it.title,
      sku: it.seller_sku || (it.variations?.[0]?.seller_sku) || null,
      variations: (it.variations || []).map(v => ({ id: v.id, sku: v.seller_sku }))
    }));
    res.json(withSku);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Listar productos y variantes de Tienda Nube. */
mappingRoutes.get('/sources/tiendanube', async (_, res) => {
  if (!tokens.tiendanube?.access_token) return res.status(401).json({ error: 'No conectado a Tienda Nube' });
  const storeId = tokens.tiendanube.store_id;
  try {
    const products = await tn.getProducts(tokens.tiendanube.access_token, storeId);
    const withVariants = await Promise.all(
      (products || []).slice(0, 100).map(async p => {
        const variants = await tn.getProductVariants(
          tokens.tiendanube.access_token,
          storeId,
          p.id
        );
        return {
          id: p.id,
          name: p.name?.es || p.name || p.title,
          variants: (variants || []).map(v => ({
            id: v.id,
            sku: v.sku,
            price: v.price,
            stock: v.stock
          }))
        };
      })
    );
    res.json(withVariants);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
