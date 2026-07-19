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
