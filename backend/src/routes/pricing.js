/**
 * Rutas de la sección de Precios (fase 2). Ver docs/PLAN-PRECIOS.md §9.
 * La lógica vive en services/pricingService.js; acá va solo el HTTP.
 */
import { Router } from 'express';
import * as pricing from '../services/pricingService.js';
import { getMlItemBySku, getTnVariantBySku } from '../store.js';

export const pricingRoutes = Router();

/** Valores fijos + tramos de comisión. */
pricingRoutes.get('/config', async (_req, res) => {
  try {
    res.json(await pricing.getConfig());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Editar valores fijos y/o tramos (solo pisa lo que venga en el body). */
pricingRoutes.put('/config', async (req, res) => {
  try {
    res.json(await pricing.saveConfig(req.body || {}));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Trae las comisiones reales de la API de ML. Sin body, o `{ apply: false }`: solo devuelve lo que
 * ML dice vs. lo cargado (no toca nada). Con `{ apply: true }`: además lo guarda en Ajustes.
 * Acepta `listingTypeId`, `categoryId`, `extraParams` (billable_weight, logistic_type, …).
 */
pricingRoutes.post('/ml-fees/sync', async (req, res) => {
  try {
    res.json(await pricing.syncMlFees(req.body || {}));
  } catch (e) {
    // La API puede fallar (sin token, WAF, 403): se reporta sin romper: lo cargado a mano sigue.
    res.status(502).json({ error: e.message });
  }
});

/** Preview: todos los costos cargados, calculados, con el estado de mapeo por canal. */
pricingRoutes.get('/preview', async (_req, res) => {
  try {
    const rows = await pricing.getPreview();
    // Anota si el SKU está mapeado en cada canal (para que la UI sepa qué se puede aplicar).
    const annotated = rows.map((r) => ({
      ...r,
      mappedMl: !!getMlItemBySku(r.sku),
      mappedTn: !!getTnVariantBySku(r.sku),
    }));
    res.json({ rows: annotated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Alta/edición del costo de un SKU (carga manual: bulto o unidad). */
pricingRoutes.put('/cost/:sku', async (req, res) => {
  const sku = (req.params.sku || '').trim();
  if (!sku) return res.status(400).json({ error: 'sku requerido' });
  try {
    const saved = await pricing.saveCost(sku, req.body || {});
    res.json({ ok: true, cost: saved });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Borrar el costo de un SKU. */
pricingRoutes.delete('/cost/:sku', async (req, res) => {
  const sku = (req.params.sku || '').trim();
  if (!sku) return res.status(400).json({ error: 'sku requerido' });
  try {
    await pricing.removeCost(sku);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Preview de una importación: parsea el texto y devuelve filas + marcadas + sugerencias de mapeo.
 * NO guarda nada. Body: { text, format?: 'pdf'|'csv' }.
 */
pricingRoutes.post('/lists/preview', async (req, res) => {
  const text = req.body?.text;
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text requerido' });
  try {
    res.json(await pricing.previewImport(text, { format: req.body?.format }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Confirma la importación: guarda lista + ítems + códigos, aplica los mapeos automáticos y
 * actualiza los costos de los SKUs mapeados.
 */
pricingRoutes.post('/lists', async (req, res) => {
  const { label, sourceFilename, discount1, discount2, rows, format } = req.body || {};
  if (!label) return res.status(400).json({ error: 'label requerido' });
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'rows requerido' });
  try {
    res.json(await pricing.confirmImport({ label, sourceFilename, discount1, discount2, rows, format }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Listas importadas. */
pricingRoutes.get('/lists', async (_req, res) => {
  try {
    res.json({ lists: await pricing.listImportedLists() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Estado del mapeo: SKUs sin código, códigos sin SKU, y lo ya confirmado. */
pricingRoutes.get('/mapping', async (_req, res) => {
  try {
    res.json(await pricing.getMappingState());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Confirma (o corrige) el mapeo de un SKU. Se hace una vez y no se vuelve a preguntar. */
pricingRoutes.put('/mapping/:sku', async (req, res) => {
  const sku = (req.params.sku || '').trim();
  const code = (req.body?.code || '').trim();
  if (!sku || !code) return res.status(400).json({ error: 'sku y code requeridos' });
  try {
    await pricing.confirmMapping(sku, code, req.body?.matchSource || 'manual');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Borra el mapeo de un SKU (para rehacerlo). */
pricingRoutes.delete('/mapping/:sku', async (req, res) => {
  const sku = (req.params.sku || '').trim();
  if (!sku) return res.status(400).json({ error: 'sku requerido' });
  try {
    await pricing.removeMapping(sku);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Historial de precios de un producto (ambos canales). Lo consume el modal de historial. */
pricingRoutes.get('/history/:sku', async (req, res) => {
  const sku = (req.params.sku || '').trim();
  if (!sku) return res.status(400).json({ error: 'sku requerido' });
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  try {
    res.json(await pricing.getPriceHistory(sku, limit, offset));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Aplicación masiva. Body: { skus: string[], channels?: { ml, tn } }. Encola los cambios (no
 * aplica de una): sobrevive 429 y reinicios vía la cola durable. Nunca aplica sin lista explícita.
 */
pricingRoutes.post('/apply', async (req, res) => {
  const skus = Array.isArray(req.body?.skus) ? req.body.skus.filter(Boolean) : [];
  if (skus.length === 0) return res.status(400).json({ error: 'skus requerido (lista no vacía)' });
  try {
    const result = await pricing.enqueueApply(skus, req.body?.channels || { ml: true, tn: true });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
