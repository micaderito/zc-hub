import { Router } from 'express';
import { tokens, getMlToken, addResolution } from '../store.js';
import {
  getAnalysis,
  patchMlSku,
  patchTnSku,
  patchTnPrice,
  patchTnStock,
} from '../services/conflictsService.js';
import { persistSkuToChannels } from '../services/syncService.js';
import { enqueueMlTask, getMlTaskStatus, insertAuditLog } from '../db.js';
import * as ml from '../lib/mercadolibre.js';
import * as tn from '../lib/tiendanube.js';

export const conflictsRoutes = Router();

/** TN: solo GET /products paginado (variants/images vienen embebidos). Timeout por ML y red. */
const ANALYSIS_TIMEOUT_MS = 120000;

/** Serializar updates sincrónicos a TN/stock: cada POST update-prices espera al anterior + esta pausa. */
const UPDATE_ML_DELAY_MS = 450;
let updatePricesTail = Promise.resolve();

/** GET análisis: coincidencias, solo ML, solo TN, sin SKU, duplicados.
 *  Soporta paginación: ?page=1&limit=25&filter=all|mismatch|synced|no-stock|with-stock&search=texto
 */
conflictsRoutes.get('/', async (req, res) => {
  try {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), ANALYSIS_TIMEOUT_MS)
    );
    // ?refresh=1 fuerza un crawl completo a ML/TN (botón "actualizar"); si no, sirve del snapshot.
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const analysis = await Promise.race([getAnalysis({ force: forceRefresh }), timeout]);

    const allMatched = analysis.matched || [];

    // Resumen de stock para los tabs de filtro (siempre del total completo, independiente del filtro/búsqueda activos).
    const stockSummary = {
      total: allMatched.length,
      mismatch: allMatched.filter(p => (p.ml?.stock ?? 0) !== (p.tn?.stock ?? 0)).length,
      synced: allMatched.filter(p => (p.ml?.stock ?? 0) === (p.tn?.stock ?? 0)).length,
      noStock: allMatched.filter(p => (p.ml?.stock ?? 0) === 0 || (p.tn?.stock ?? 0) === 0).length,
      withStock: allMatched.filter(p => (p.ml?.stock ?? 0) > 0 && (p.tn?.stock ?? 0) > 0).length,
    };

    const tab = req.query.tab || 'coincidencias';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(5, parseInt(req.query.limit) || 25));
    const searchRaw = (req.query.search || '').trim().toLowerCase();
    const searchTokens = searchRaw ? searchRaw.split(/\s+/).filter(Boolean) : [];
    const filterParam = req.query.filter || 'all';

    function searchRows(rows, toks) {
      if (!toks.length) return rows;
      return rows.filter(r => {
        const text = [r.title, r.productName, r.sku, r.variationName, r.variantName]
          .filter(Boolean).join(' ').toLowerCase();
        return toks.every(t => text.includes(t));
      });
    }

    let responseOverride = {};
    let total = 0;
    let paging;

    if (tab === 'coincidencias') {
      // Filtro por estado de stock
      let filtered = allMatched;
      if (filterParam === 'mismatch')    filtered = allMatched.filter(p => (p.ml?.stock ?? 0) !== (p.tn?.stock ?? 0));
      else if (filterParam === 'synced')      filtered = allMatched.filter(p => (p.ml?.stock ?? 0) === (p.tn?.stock ?? 0));
      else if (filterParam === 'no-stock')    filtered = allMatched.filter(p => (p.ml?.stock ?? 0) === 0 || (p.tn?.stock ?? 0) === 0);
      else if (filterParam === 'with-stock')  filtered = allMatched.filter(p => (p.ml?.stock ?? 0) > 0 && (p.tn?.stock ?? 0) > 0);

      // Búsqueda por tokens
      if (searchTokens.length) {
        filtered = filtered.filter(p => {
          const text = [p.ml?.title, p.tn?.productName, p.sku, p.ml?.sku, p.tn?.sku, p.ml?.variationName, p.tn?.variantName]
            .filter(Boolean).join(' ').toLowerCase();
          return searchTokens.every(t => text.includes(t));
        });
      }

      total = filtered.length;
      // Stock total de la búsqueda/filtro activos (para el chip informativo del listado): por
      // par se usa el menor entre ML y TN (mismo criterio que syncStock en el front), ya que un
      // ítem con stock distinto entre canales solo puede vender hasta el mínimo de los dos.
      const stockTotal = {
        units: filtered.reduce((sum, p) => sum + Math.min(p.ml?.stock ?? 0, p.tn?.stock ?? 0), 0),
        products: filtered.length,
      };
      const offset = (page - 1) * limit;
      responseOverride = { matched: filtered.slice(offset, offset + limit), stockTotal };
      paging = { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) };
    } else if (tab === 'solo-ml') {
      const filtered = searchRows(analysis.onlyML || [], searchTokens);
      total = filtered.length;
      const offset = (page - 1) * limit;
      responseOverride = { onlyML: filtered.slice(offset, offset + limit) };
      paging = { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) };
    } else if (tab === 'solo-tn') {
      const filtered = searchRows(analysis.onlyTN || [], searchTokens);
      total = filtered.length;
      const offset = (page - 1) * limit;
      responseOverride = { onlyTN: filtered.slice(offset, offset + limit) };
      paging = { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) };
    } else {
      // sin-sku, duplicados, resumen: no override, no pagination
      paging = { page: 1, limit, total: 0, pages: 1 };
    }

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.json({
      ...analysis,
      ...responseOverride,
      paging,
      stockSummary,
    });
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
      // Parche puntual del snapshot (sin re-bajar el catálogo). El análisis se recomputa al leer.
      await patchMlSku(itemId, variationId ?? null, skuTrim);
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
      await patchTnSku(Number(productId), Number(variantId), skuTrim);
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
    // persisted.ml === true significa que la actualización del SKU en ML quedó ENCOLADA (se procesa
    // en segundo plano y aparece en «Actualizaciones en cola»). Solo es false si no se pudo encolar
    // (típicamente porque no hay base de datos configurada).
    if (entry.mercadolibre?.itemId && persisted.ml === false) {
      return res.status(502).json({
        error: 'No se pudo encolar la actualización del SKU en Mercado Libre. Verificá que la base de datos (DATABASE_URL) esté configurada en el backend.',
        persisted
      });
    }
    addResolution(entry);
    return res.json({ ok: true, sku: skuTrim, persisted });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/**
 * POST actualizar precios y/o stock de un par (ML y TN pueden tener valores distintos).
 * Body: { itemId, variationId?, productId, variantId, priceML?, priceTN?, stockML?, stockTN?, applyTnToAllVariants? }
 * Las requests se serializan con una pausa entre una y otra para no saturar la API de ML.
 */
conflictsRoutes.post('/update-prices', async (req, res) => {
  const myTurn = updatePricesTail.then(() => new Promise((r) => setTimeout(r, UPDATE_ML_DELAY_MS)));
  let release;
  updatePricesTail = new Promise((r) => { release = r; });
  await myTurn;

  try {
    const { itemId, variationId, productId, variantId, priceML, priceTN, stockML, stockTN, applyTnToAllVariants } = req.body;
    if (!itemId) return res.status(400).json({ error: 'itemId es requerido' });
    if (productId == null || variantId == null) return res.status(400).json({ error: 'productId y variantId son requeridos' });
    const accessToken = await getMlToken();
    if (!accessToken) return res.status(401).json({ error: 'No conectado a Mercado Libre' });
    if (!tokens.tiendanube?.access_token) return res.status(401).json({ error: 'No conectado a Tienda Nube' });

    let mlPriceTaskId = null;
    let mlStockTaskId = null;
    let tnPriceOk = false;
    let tnStockOk = false;
    const priceMLNum = Number(priceML);
    const priceTNNum = Number(priceTN);
    const stockMLNum = typeof stockML !== 'undefined' && stockML !== null ? Number(stockML) : undefined;
    const stockTNNum = typeof stockTN !== 'undefined' && stockTN !== null ? Number(stockTN) : undefined;

    // El precio en ML se encola (igual que el SKU): el worker lo aplica con reintentos ante 429,
    // así muchos cambios seguidos no saturan la API. Aparece en «Actualizaciones en cola».
    if (priceMLNum > 0) {
      const vid = variationId != null && variationId !== '' ? String(variationId) : null;
      mlPriceTaskId = await enqueueMlTask({
        kind: 'price_ml',
        itemId,
        variationId: vid,
        targetPrice: priceMLNum,
        idempotencyKey: `price_ml:${itemId}:${vid || 'item'}`, // coalescing: el último precio gana
      });
      if (!mlPriceTaskId) {
        return res.status(502).json({
          error: 'No se pudo encolar la actualización del precio en Mercado Libre. Verificá que la base de datos (DATABASE_URL) esté configurada en el backend.'
        });
      }
    }
    if (priceTNNum > 0) {
      tnPriceOk = applyTnToAllVariants
        ? await tn.updateVariantPriceAllVariants(
            tokens.tiendanube.access_token,
            tokens.tiendanube.store_id,
            Number(productId),
            priceTNNum
          )
        : await tn.updateVariantPrice(
            tokens.tiendanube.access_token,
            tokens.tiendanube.store_id,
            Number(productId),
            Number(variantId),
            priceTNNum
          );
      if (tnPriceOk) await patchTnPrice(Number(productId), Number(variantId), priceTNNum, !!applyTnToAllVariants);
    }
    // El stock en ML se encola (igual que el precio y el SKU): antes se aplicaba inline con
    // fetchWith429Retry y, si los reintentos ante 429 se agotaban, la función devolvía `false`
    // sin lanzar — la ruta igual respondía `ok:true` y el front daba el stock por sincronizado
    // aunque ML nunca lo hubiera recibido. Encolarlo hace que el worker lo reintente en segundo
    // plano (ver mlTaskQueue.js, kind `stock_ml_set`) y el front haga polling del resultado real.
    if (stockMLNum !== undefined && stockMLNum >= 0) {
      const vid = variationId != null && variationId !== '' ? String(variationId) : null;
      mlStockTaskId = await enqueueMlTask({
        kind: 'stock_ml_set',
        itemId,
        variationId: vid,
        targetQty: stockMLNum,
        idempotencyKey: `stock_ml_set:${itemId}:${vid || 'item'}`, // coalescing: el último valor gana
      });
      if (!mlStockTaskId) {
        return res.status(502).json({
          error: 'No se pudo encolar la actualización de stock en Mercado Libre. Verificá que la base de datos (DATABASE_URL) esté configurada en el backend.'
        });
      }
    }
    if (stockTNNum !== undefined && stockTNNum >= 0) {
      const flooredTn = Math.max(0, Math.floor(stockTNNum));
      tnStockOk = await tn.updateVariantStock(
        tokens.tiendanube.access_token,
        tokens.tiendanube.store_id,
        Number(productId),
        Number(variantId),
        flooredTn
      );
      if (tnStockOk) {
        // El parche del snapshot devuelve el stock previo: con eso registramos el cambio manual
        // en el historial. Solo si se movió — poner el valor que ya estaba no es un cambio.
        const before = await patchTnStock(Number(productId), Number(variantId), flooredTn);
        if (before && before.stockBefore !== flooredTn) {
          await insertAuditLog({
            source: 'manual',
            sku: before.sku || '',
            productLabel: 'Cambio manual',
            updatedChannel: 'tiendanube',
            stockBefore: before.stockBefore,
            stockAfter: flooredTn,
          }).catch(e => console.error('[Conflicts] insertAuditLog:', e.message));
        }
      }
    }

    const triedTn = priceTNNum > 0 || (stockTNNum !== undefined && stockTNNum >= 0);
    const tnOk = tnPriceOk || tnStockOk;
    if (triedTn && !tnOk) {
      return res.status(502).json({
        error: 'Tienda Nube no pudo actualizar. Probá de nuevo.'
      });
    }

    // El snapshot ya quedó parchado in-place con los cambios TN sincrónicos. El precio y el stock
    // en ML los aplica y parcha el worker al completar la tarea encolada (ver mlTaskQueue.js).
    // Nunca se re-baja el catálogo entero.
    return res.json({
      ok: true,
      mlTaskId: mlPriceTaskId ?? undefined,
      mlStockTaskId: mlStockTaskId ?? undefined,
      ml: !!(mlPriceTaskId || mlStockTaskId),
      tn: tnOk
    });
  } catch (e) {
    const status = e?.mlStatus >= 400 && e?.mlStatus < 500 ? 422 : 502;
    return res.status(status).json({ error: e.message || 'Error al actualizar' });
  } finally {
    release();
  }
});

/** GET estado de una tarea de ML (para polling desde el front). */
conflictsRoutes.get('/task/:taskId', async (req, res) => {
  const taskId = parseInt(req.params.taskId, 10);
  if (!taskId || isNaN(taskId)) return res.status(400).json({ error: 'taskId inválido' });
  const task = await getMlTaskStatus(taskId);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
  return res.json(task);
});
