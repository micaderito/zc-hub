import { Router } from 'express';
import { tokens, getMlToken, addResolution } from '../store.js';
import { getAnalysis } from '../services/conflictsService.js';
import { persistSkuToChannels } from '../services/syncService.js';
import { invalidateAnalysisCache } from '../db.js';
import * as ml from '../lib/mercadolibre.js';
import * as tn from '../lib/tiendanube.js';

export const conflictsRoutes = Router();

/** TN: solo GET /products paginado (variants/images vienen embebidos). Timeout por ML y red. */
const ANALYSIS_TIMEOUT_MS = 120000;

/** GET análisis: coincidencias, solo ML, solo TN, sin SKU, duplicados. */
conflictsRoutes.get('/', async (_, res) => {
  try {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), ANALYSIS_TIMEOUT_MS)
    );
    const analysis = await Promise.race([getAnalysis(), timeout]);
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.json(analysis);
  } catch (e) {
    if (e.message === 'timeout') {
      return res.status(504).json({ error: 'El análisis tardó demasiado. Volvé a intentar en un momento.' });
    }
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST actualizar SKU en una plataforma.
 * Body: { channel: 'mercadolibre' | 'tiendanube', sku: string, itemId?, variationId? } para ML
 *       { channel: 'tiendanube', sku: string, productId, variantId } para TN
 */
conflictsRoutes.post('/update-sku', async (req, res) => {
  const { channel, sku, itemId, variationId, productId, variantId } = req.body;
  if (!sku || typeof sku !== 'string' || !sku.trim()) {
    return res.status(400).json({ error: 'sku es requerido' });
  }
  const skuTrim = sku.trim();
  if (channel === 'mercadolibre') {
    const accessToken = await getMlToken();
    if (!accessToken) return res.status(401).json({ error: 'No conectado a Mercado Libre' });
    if (!itemId) return res.status(400).json({ error: 'itemId es requerido para ML' });
    try {
      await (variationId
        ? ml.updateVariationSku(accessToken, itemId, variationId, skuTrim)
        : ml.updateItemSku(accessToken, itemId, skuTrim));
      await invalidateAnalysisCache();
      await getAnalysis();
      return res.json({ ok: true });
    } catch (e) {
      let msg = e.message || 'No se pudo actualizar el SKU en Mercado Libre';
      if (msg.includes('has_bids') && msg.includes('true')) {
        msg = 'La API de Mercado Libre no permite actualizar el SKU en este ítem desde la app. Podés cambiarlo desde el panel de ML (Mis ventas → Publicaciones → editar la publicación).';
      } else if (msg.includes('Cannot update item') || (msg.includes('status') && (msg.includes('active') || msg.includes('under_review')))) {
        if (msg.includes('under_review')) {
          msg = 'Esta publicación está en revisión o deshabilitada en Mercado Libre. La API de ML no permite editar el SKU en ese estado. Entrá a Mercado Libre → Mis ventas → Publicaciones, activá la publicación si está pausada y editá el SKU desde ahí.';
        } else {
          msg = 'La API de Mercado Libre no permitió actualizar el SKU en este ítem. Probá cambiarlo desde el panel de ML: Mis ventas → Publicaciones → editar la publicación.';
        }
      }
      return res.status(502).json({ error: msg });
    }
  }
  if (channel === 'tiendanube') {
    if (!tokens.tiendanube?.access_token) return res.status(401).json({ error: 'No conectado a Tienda Nube' });
    if (productId == null || variantId == null) {
      return res.status(400).json({ error: 'productId y variantId son requeridos para TN' });
    }
    try {
      await tn.updateVariantSku(
        tokens.tiendanube.access_token,
        tokens.tiendanube.store_id,
        Number(productId),
        Number(variantId),
        skuTrim
      );
      await invalidateAnalysisCache();
      await getAnalysis();
      return res.json({ ok: true });
  } catch (e) {
    const msg = e.message || 'No se pudo actualizar el SKU en Tienda Nube';
      return res.status(502).json({ error: msg });
    }
  }
  res.status(400).json({ error: 'channel debe ser mercadolibre o tiendanube' });
});

/**
 * POST vincular manualmente: esta publicación ML = esta variante TN, con este SKU.
 * Siempre persiste el SKU en ML y TN al resolver el conflicto.
 */
conflictsRoutes.post('/link', async (req, res) => {
  const { sku, mercadolibre, tiendanube, priceML, priceTN } = req.body;
  const skuTrim = (sku || '').trim();
  if (!skuTrim) return res.status(400).json({ error: 'sku es requerido' });
  if (!mercadolibre?.itemId) return res.status(400).json({ error: 'mercadolibre.itemId es requerido' });
  if (tiendanube?.productId == null || tiendanube?.variantId == null) {
    return res.status(400).json({ error: 'tiendanube.productId y variantId son requeridos' });
  }
  if (!(await getMlToken())) return res.status(401).json({ error: 'No conectado a Mercado Libre' });
  if (!tokens.tiendanube?.access_token) return res.status(401).json({ error: 'No conectado a Tienda Nube' });

  const entry = {
    sku: skuTrim,
    mercadolibre: { itemId: mercadolibre.itemId, variationId: mercadolibre.variationId || undefined },
    tiendanube: { productId: Number(tiendanube.productId), variantId: Number(tiendanube.variantId) },
    priceML: priceML ?? 0,
    priceTN: priceTN ?? 0
  };
  try {
    // Solo igualamos el SKU en ML y TN; la vinculación es tener el mismo SKU (no guardamos mapeo aparte)
    const persisted = await persistSkuToChannels(entry);
    if (entry.mercadolibre?.itemId && persisted.ml === false) {
      const msg = persisted.mlError || 'No se pudo actualizar el SKU en la publicación de Mercado Libre. Si está en revisión o pausada, activala y editá el SKU desde ML (Mis ventas → Publicaciones).';
      return res.status(502).json({ error: msg, persisted });
    }
    addResolution(entry);
    return res.json({ ok: true, sku: skuTrim, persisted });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/**
 * POST actualizar precios y/o stock de un par (ML y TN pueden tener valores distintos).
 * Body: { itemId, variationId?, productId, variantId, priceML?, priceTN?, stockML?, stockTN? }
 */
conflictsRoutes.post('/update-prices', async (req, res) => {
  const { itemId, variationId, productId, variantId, priceML, priceTN, stockML, stockTN } = req.body;
  if (!itemId) return res.status(400).json({ error: 'itemId es requerido' });
  if (productId == null || variantId == null) return res.status(400).json({ error: 'productId y variantId son requeridos' });
  const accessToken = await getMlToken();
  if (!accessToken) return res.status(401).json({ error: 'No conectado a Mercado Libre' });
  if (!tokens.tiendanube?.access_token) return res.status(401).json({ error: 'No conectado a Tienda Nube' });

  let mlPriceOk = false;
  let tnPriceOk = false;
  let mlStockOk = false;
  let tnStockOk = false;
  const priceMLNum = Number(priceML);
  const priceTNNum = Number(priceTN);
  const stockMLNum = typeof stockML !== 'undefined' && stockML !== null ? Number(stockML) : undefined;
  const stockTNNum = typeof stockTN !== 'undefined' && stockTN !== null ? Number(stockTN) : undefined;

  if (priceMLNum > 0) {
    mlPriceOk = await ml.updateItemPrice(accessToken, itemId, priceMLNum);
  }
  if (priceTNNum > 0) {
    tnPriceOk = await tn.updateVariantPrice(
      tokens.tiendanube.access_token,
      tokens.tiendanube.store_id,
      Number(productId),
      Number(variantId),
      priceTNNum
    );
  }
  if (stockMLNum !== undefined && stockMLNum >= 0) {
    mlStockOk = await ml.updateItemOrVariationStock(
      accessToken,
      itemId,
      variationId ?? undefined,
      stockMLNum
    );
  }
  if (stockTNNum !== undefined && stockTNNum >= 0) {
    tnStockOk = await tn.updateVariantStock(
      tokens.tiendanube.access_token,
      tokens.tiendanube.store_id,
      Number(productId),
      Number(variantId),
      Math.max(0, Math.floor(stockTNNum))
    );
  }
  await invalidateAnalysisCache();
  return res.json({ ok: true, ml: mlPriceOk || mlStockOk, tn: tnPriceOk || tnStockOk });
});
