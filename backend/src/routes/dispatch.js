/**
 * "Para despachar": paquetes de ML y TN pendientes de envío. La lectura vive en
 * services/dispatchService.js; acá solo HTTP + las marcas del hub (preparado / cancelado visto).
 */
import { Router } from 'express';
import { getDispatchList } from '../services/dispatchService.js';
import * as db from '../db.js';

export const dispatchRoutes = Router();

const CHANNELS = new Set(['ml', 'tn']);
const SALE_ID_RE = /^[0-9A-Za-z_-]{1,64}$/;

function parseTarget(req, res) {
  const { channel, saleId } = req.params;
  if (!CHANNELS.has(channel) || !SALE_ID_RE.test(saleId)) {
    res.status(400).json({ error: 'canal o venta inválidos' });
    return null;
  }
  return { channel, saleId };
}

/** La lista completa. `?refresh=1` saltea la caché de 60 s (botón "Actualizar"). */
dispatchRoutes.get('/', async (req, res) => {
  try {
    res.json(await getDispatchList({ refresh: req.query.refresh === '1' }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Tilda un paquete como preparado. */
dispatchRoutes.put('/:channel/:saleId/prepared', async (req, res) => {
  const t = parseTarget(req, res);
  if (!t) return;
  const ok = await db.setDispatchPrepared(t.channel, t.saleId, true, req.user?.username ?? null);
  if (!ok) return res.status(500).json({ error: 'No se pudo guardar' });
  res.json({ ok: true });
});

/** Destilda un paquete. */
dispatchRoutes.delete('/:channel/:saleId/prepared', async (req, res) => {
  const t = parseTarget(req, res);
  if (!t) return;
  const ok = await db.setDispatchPrepared(t.channel, t.saleId, false);
  if (!ok) return res.status(500).json({ error: 'No se pudo guardar' });
  res.json({ ok: true });
});

/** "Entendido" sobre un cancelado: deja de avisarse. */
dispatchRoutes.put('/:channel/:saleId/cancel-seen', async (req, res) => {
  const t = parseTarget(req, res);
  if (!t) return;
  const ok = await db.setDispatchCancelSeen(t.channel, t.saleId);
  if (!ok) return res.status(500).json({ error: 'No se pudo guardar' });
  res.json({ ok: true });
});
