/**
 * Productos del hub (página Publicaciones): cada uno junta sus publicaciones de ML y de TN. Todo se
 * lee del snapshot del catálogo — navegar acá no le pega a ML/TN. Ver services/hubProductsService.js.
 */
import { Router } from 'express';
import { getCatalogRows, refreshAnalysis, patchTnSku } from '../services/conflictsService.js';
import { persistSkuToChannels } from '../services/syncService.js';
import { buildHubProducts, queryHubProducts, linkCandidates } from '../services/hubProductsService.js';
import { listActivePublicationEdits } from '../db.js';

export const hubProductsRoutes = Router();

/**
 * Lista paginada. Query: search, status, limit, offset, refresh=1 (crawl completo a ML/TN, mismo
 * "Actualizar" que Conflictos). Devuelve { rows, total, counts, mlConnected, tnConnected, at }.
 */
hubProductsRoutes.get('/', async (req, res) => {
  try {
    if (req.query.refresh === '1') await refreshAnalysis();
    const catalog = await getCatalogRows();
    const groups = buildHubProducts(catalog);
    const result = queryHubProducts(groups, {
      search: String(req.query.search || ''),
      status: String(req.query.status || ''),
      limit: req.query.limit,
      offset: req.query.offset,
    });
    // Chip "Edición sin guardar": los productos con una edición abierta (Publicaciones → Editar).
    const edits = await listActivePublicationEdits();
    const rows = result.rows.map((r) => (edits[r.key] ? { ...r, edit: edits[r.key] } : r));
    res.json({ ...result, rows, mlConnected: !!catalog.mlConnected, tnConnected: !!catalog.tnConnected, at: catalog.at ?? null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Variantes sin par del canal pedido, para el picker de "Vincular". Query: channel=ml|tn, search. */
hubProductsRoutes.get('/link-candidates', async (req, res) => {
  const channel = req.query.channel;
  if (channel !== 'ml' && channel !== 'tn') return res.status(400).json({ error: 'channel tiene que ser ml o tn' });
  try {
    const catalog = await getCatalogRows();
    res.json(linkCandidates(catalog, channel, String(req.query.search || '')).slice(0, 50));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Detalle de un producto del hub: sus publicaciones y una fila por variante (SKU). */
hubProductsRoutes.get('/:key', async (req, res) => {
  try {
    const catalog = await getCatalogRows();
    const group = buildHubProducts(catalog).find((g) => g.key === req.params.key);
    if (!group) return res.status(404).json({ error: 'No encontramos ese producto. Puede que haya cambiado al vincular una variante: volvé a la lista.' });
    const edit = (await listActivePublicationEdits())[group.key] || null;
    res.json({ ...group, edit });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Vincula una variante de ML con una de TN poniéndoles el mismo SKU en los dos canales (el mapeo
 * es el SKU, no se guarda nada aparte). Body: { sku, ml: { itemId, variationId? }, tn: { productId, variantId } }.
 * Solo escribe el canal cuyo SKU es distinto del elegido: si una punta ya lo tiene, no la toca.
 */
hubProductsRoutes.post('/link', async (req, res) => {
  const { ml, tn } = req.body || {};
  const sku = String(req.body?.sku || '').trim();
  if (!sku) return res.status(400).json({ error: 'Falta el SKU' });
  if (!ml?.itemId || tn?.productId == null || tn?.variantId == null) {
    return res.status(400).json({ error: 'Hay que elegir una variante de ML y una de TN' });
  }
  try {
    const catalog = await getCatalogRows();
    const mlRow = catalog.mlRows.find((r) => r.itemId === ml.itemId && String(r.variationId || '') === String(ml.variationId || ''));
    const tnRow = catalog.tnRows.find((r) => String(r.productId) === String(tn.productId) && String(r.variantId) === String(tn.variantId));
    if (!mlRow || !tnRow) return res.status(404).json({ error: 'No encontramos alguna de las dos variantes. Actualizá la lista y probá de nuevo.' });

    const usedElsewhere = (rows, self) => rows.some((r) => r !== self && r.sku === sku);
    if (usedElsewhere(catalog.mlRows, mlRow) || usedElsewhere(catalog.tnRows, tnRow)) {
      return res.status(409).json({ error: `El SKU ${sku} ya lo usa otra variante. Elegí otro para no mezclar productos.` });
    }

    const entry = { sku };
    if (mlRow.sku !== sku) entry.mercadolibre = { itemId: ml.itemId, variationId: ml.variationId || undefined };
    if (tnRow.sku !== sku) entry.tiendanube = { productId: Number(tn.productId), variantId: Number(tn.variantId) };
    const persisted = await persistSkuToChannels(entry);
    if (entry.mercadolibre && !persisted.ml) {
      return res.status(502).json({ error: 'No se pudo encolar el cambio de SKU en Mercado Libre.' });
    }
    if (entry.tiendanube && !persisted.tn) {
      return res.status(502).json({ error: 'Tienda Nube no aceptó el cambio de SKU. Probá de nuevo en un rato.' });
    }
    // El de ML lo parchea la cola al terminar (sku_ml); el de TN se escribió recién, así que la foto
    // se actualiza ya y la lista lo muestra vinculado sin esperar el webhook.
    if (entry.tiendanube) await patchTnSku(Number(tn.productId), Number(tn.variantId), sku).catch(() => {});
    res.json({ ok: true, sku, pendingMl: !!entry.mercadolibre });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
