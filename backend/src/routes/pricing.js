/**
 * Rutas de la sección de Precios (fase 2). Ver docs/PLAN-PRECIOS.md §9.
 * La lógica vive en services/pricingService.js; acá va solo el HTTP.
 */
import { Router } from 'express';
import * as pricing from '../services/pricingService.js';
import { getMlItemBySku, getTnVariantBySku } from '../store.js';

export const pricingRoutes = Router();

/** Proveedor de la request (`?supplier=` o `body.supplierKey`); vacío = el de siempre. */
const supplierOf = (req) => String(req.query?.supplier || req.body?.supplierKey || '').trim() || pricing.DEFAULT_SUPPLIER;

/** Responde un error del servicio con su status (400/404/409), o 500. */
function sendError(res, e) {
  res.status(e.status || 500).json({ error: e.message });
}

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
 * Ajuste manual del precio publicado de un SKU en un canal ('ml' o 'tn'). Body: { channel, value }.
 * `value: null` (o ausente) saca el ajuste y el precio vuelve a ser el calculado.
 */
pricingRoutes.put('/override/:sku', async (req, res) => {
  const sku = (req.params.sku || '').trim();
  const channel = req.body?.channel;
  if (!sku || (channel !== 'ml' && channel !== 'tn')) {
    return res.status(400).json({ error: "sku y channel ('ml'|'tn') requeridos" });
  }
  try {
    await pricing.saveOverride(sku, channel, req.body?.value ?? null);
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
    res.json(await pricing.previewImport(text, { format: req.body?.format, supplierKey: supplierOf(req) }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Confirma la importación: guarda lista + ítems + códigos, aplica los mapeos automáticos y
 * actualiza los costos de los SKUs mapeados.
 */
pricingRoutes.post('/lists', async (req, res) => {
  const { label, sourceFilename, profileId, rows, format } = req.body || {};
  if (!label) return res.status(400).json({ error: 'label requerido' });
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'rows requerido' });
  try {
    const result = await pricing.confirmImport({
      label, sourceFilename, rows, format, supplierKey: supplierOf(req), profileId: profileId == null ? null : Number(profileId),
    });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
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

/**
 * Borra una lista importada (sus ítems y los códigos que ya no estén en ninguna lista ni mapeo).
 * Los costos que ya volcó quedan como están.
 */
pricingRoutes.delete('/lists/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  try {
    const ok = await pricing.removeImportedList(id);
    if (!ok) return res.status(404).json({ error: 'La lista no existe' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Estado del mapeo: cada producto/pack de la tienda con su código (o sin), y los códigos del
 * proveedor. `?supplier=` = de ese proveedor; sin él, la vista "Todos" (solo lectura).
 */
pricingRoutes.get('/mapping', async (req, res) => {
  try {
    res.json(await pricing.getMappingState(String(req.query?.supplier || '').trim() || null));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Confirma (o corrige) el mapeo de un SKU. Se hace una vez y no se vuelve a preguntar. Toma el precio en el momento. */
pricingRoutes.put('/mapping/:sku', async (req, res) => {
  const sku = (req.params.sku || '').trim();
  const code = (req.body?.code || '').trim();
  if (!sku || !code) return res.status(400).json({ error: 'sku y code requeridos' });
  try {
    // Además del mapeo, vuelca el precio del código en la lista más reciente que lo trae.
    const result = await pricing.confirmMapping(sku, code, req.body?.matchSource || 'manual', supplierOf(req));
    if (!result.ok) return res.status(500).json({ error: 'No se pudo guardar el mapeo' });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Saca el código de un SKU (queda marcado para que el mapeo automático no lo vuelva a poner). */
pricingRoutes.delete('/mapping/:sku', async (req, res) => {
  const sku = (req.params.sku || '').trim();
  if (!sku) return res.status(400).json({ error: 'sku requerido' });
  try {
    await pricing.removeMapping(sku, supplierOf(req));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Confirma (o corrige) el mapeo de un pack: el costo se aplica a TODOS sus SKUs miembro. */
pricingRoutes.put('/mapping/pack/:packId', async (req, res) => {
  const packId = Number(req.params.packId);
  const code = (req.body?.code || '').trim();
  if (!packId || !code) return res.status(400).json({ error: 'packId y code requeridos' });
  try {
    const result = await pricing.confirmPackMapping(packId, code, req.body?.matchSource || 'manual', supplierOf(req));
    if (!result.ok) return res.status(500).json({ error: 'No se pudo guardar el mapeo' });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Saca el código de un pack (ídem). */
pricingRoutes.delete('/mapping/pack/:packId', async (req, res) => {
  const packId = Number(req.params.packId);
  if (!packId) return res.status(400).json({ error: 'packId requerido' });
  try {
    await pricing.removePackMapping(packId, supplierOf(req));
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

// ── Proveedores y configuraciones de descuento ────────────────────────────────

/** Proveedores con sus configs (y cuántos productos usa cada una). También vienen en GET /config. */
pricingRoutes.get('/suppliers', async (_req, res) => {
  try {
    res.json({ suppliers: (await pricing.getConfig()).suppliers });
  } catch (e) {
    sendError(res, e);
  }
});

/** Alta: { name, discount1?, discount2?, profileName? } → la config default del proveedor. */
pricingRoutes.post('/suppliers', async (req, res) => {
  try {
    res.json(await pricing.addSupplier(req.body || {}));
  } catch (e) {
    sendError(res, e);
  }
});

pricingRoutes.put('/suppliers/:key', async (req, res) => {
  try {
    res.json(await pricing.editSupplier(req.params.key, req.body || {}));
  } catch (e) {
    sendError(res, e);
  }
});

/** 409 si tiene listas o es el proveedor vigente de algún producto. */
pricingRoutes.delete('/suppliers/:key', async (req, res) => {
  try {
    res.json(await pricing.removeSupplier(req.params.key));
  } catch (e) {
    sendError(res, e);
  }
});

pricingRoutes.post('/suppliers/:key/profiles', async (req, res) => {
  try {
    res.json(await pricing.addDiscountProfile(req.params.key, req.body || {}));
  } catch (e) {
    sendError(res, e);
  }
});

/** { name?, discount1?, discount2?, isDefault?: true }. */
pricingRoutes.put('/profiles/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  try {
    res.json(await pricing.editDiscountProfile(id, req.body || {}));
  } catch (e) {
    sendError(res, e);
  }
});

pricingRoutes.delete('/profiles/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  try {
    res.json(await pricing.removeDiscountProfile(id));
  } catch (e) {
    sendError(res, e);
  }
});

/**
 * Asignación masiva de config: { supplierKey, targets: [{ type: 'sku'|'pack', id }], profileId|null }.
 * También da de alta los productos en ese proveedor.
 */
pricingRoutes.put('/assignments', async (req, res) => {
  try {
    res.json(await pricing.assignDiscount(req.body || {}));
  } catch (e) {
    sendError(res, e);
  }
});

/** Saca packs/productos de un proveedor: { supplierKey, targets }. */
pricingRoutes.post('/assignments/remove', async (req, res) => {
  try {
    res.json(await pricing.unassignSupplier(req.body || {}));
  } catch (e) {
    sendError(res, e);
  }
});

/** Cambia el proveedor vigente (el que manda el costo): { supplierKey, targets }. */
pricingRoutes.put('/vigente', async (req, res) => {
  try {
    res.json(await pricing.setVigenteSupplier(req.body || {}));
  } catch (e) {
    sendError(res, e);
  }
});
