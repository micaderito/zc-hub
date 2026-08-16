import { Router } from 'express';
import { getResolvedMappings } from '../store.js';
import { persistSkuToChannels } from '../services/syncService.js';
import { getAnalysis } from '../services/conflictsService.js';

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

/** SKU→{nombre,foto} únicos, en orden de aparición (matched antes que "solo en este canal"). */
function catalogOptionsFromRows(rows, labelKey) {
  const options = new Map();
  for (const row of rows) {
    if (row.sku && !options.has(row.sku)) {
      options.set(row.sku, { label: row[labelKey], thumbnail: row.thumbnail || null });
    }
  }
  return [...options.entries()].map(([sku, { label, thumbnail }]) => ({ sku, label, thumbnail }));
}

/** Catálogo de SKUs de ML para autocomplete (ej. Depósito Marañón). Sirve del snapshot cacheado
 *  del análisis (mismo que Precio y stock/Conflictos), así trae el catálogo COMPLETO y no solo
 *  una primera tanda — a diferencia de una búsqueda en vivo, no hace falta paginar acá. */
mappingRoutes.get('/sources/mercadolibre', async (_, res) => {
  try {
    const analysis = await getAnalysis();
    if (!analysis.mlConnected) return res.status(401).json({ error: 'No conectado a Mercado Libre' });
    const rows = [...analysis.matched.map(m => m.ml), ...analysis.onlyML];
    res.json(catalogOptionsFromRows(rows, 'title'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Catálogo de SKUs de TN para autocomplete (ej. Depósito Marañón). Misma fuente que arriba. */
mappingRoutes.get('/sources/tiendanube', async (_, res) => {
  try {
    const analysis = await getAnalysis();
    if (!analysis.tnConnected) return res.status(401).json({ error: 'No conectado a Tienda Nube' });
    const rows = [...analysis.matched.map(m => m.tn), ...analysis.onlyTN];
    res.json(catalogOptionsFromRows(rows, 'productName'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
