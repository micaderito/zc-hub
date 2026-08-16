/**
 * Rutas de Alertas de stock (fase 5). La lógica de cruce con el snapshot vive en
 * services/alertsService.js; acá va solo el HTTP. Ver docs/prototype/alertas-prototipo.html y
 * CLAUDE.md para el diseño y las reglas de negocio.
 */
import { Router } from 'express';
import {
  upsertStockAlert, deleteStockAlert, muteStockAlert, markNotificationsRead,
} from '../db.js';
import {
  getRulesWithStock, getNotificationsInbox, getRestockList, closeRestockPeriod,
  evaluateStockAlertsNow, getUnwatchedProducts,
} from '../services/alertsService.js';

export const alertsRoutes = Router();

/** Reglas + stock de hoy + pack, para la tabla de la pestaña Reglas. */
alertsRoutes.get('/', async (_req, res) => {
  try {
    res.json({ rules: await getRulesWithStock() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Productos matcheados sin regla todavía, para la pestaña "Sin alertas". */
alertsRoutes.get('/unwatched', async (_req, res) => {
  try {
    res.json({ products: await getUnwatchedProducts() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Alta/edición de una regla. Body: { threshold, productLabel? }. Tras guardar, evalúa contra el
 * stock actual para que dispare en la primera pasada si el producto ya estaba bajo el umbral.
 */
alertsRoutes.put('/:sku', async (req, res) => {
  const sku = (req.params.sku || '').trim();
  const threshold = Number(req.body?.threshold);
  if (!sku) return res.status(400).json({ error: 'sku requerido' });
  if (!Number.isFinite(threshold) || threshold < 0) return res.status(400).json({ error: 'threshold inválido' });
  try {
    const saved = await upsertStockAlert(sku, { threshold, productLabel: req.body?.productLabel });
    if (!saved) return res.status(500).json({ error: 'No se pudo guardar la regla' });
    await evaluateStockAlertsNow();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Borra una regla (no toca el historial). */
alertsRoutes.delete('/:sku', async (req, res) => {
  const sku = (req.params.sku || '').trim();
  if (!sku) return res.status(400).json({ error: 'sku requerido' });
  try {
    await deleteStockAlert(sku);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Silenciar N días (default 7): no avisa aunque siga bajo el umbral hasta esa fecha. */
alertsRoutes.post('/:sku/mute', async (req, res) => {
  const sku = (req.params.sku || '').trim();
  if (!sku) return res.status(400).json({ error: 'sku requerido' });
  try {
    await muteStockAlert(sku, req.body?.days ?? 7);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Bandeja de notificaciones (pestaña Notificaciones + cajón lateral). ?unread=1&limit=&offset= */
alertsRoutes.get('/notifications', async (req, res) => {
  try {
    const inbox = await getNotificationsInbox({
      unreadOnly: req.query.unread === '1' || req.query.unread === 'true',
      limit: Math.min(Number(req.query.limit) || 50, 200),
      offset: Number(req.query.offset) || 0,
    });
    res.json(inbox);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Marca leídas: body { ids: number[] } o { all: true }. */
alertsRoutes.post('/notifications/read', async (req, res) => {
  try {
    await markNotificationsRead({ ids: req.body?.ids, all: !!req.body?.all });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Lista "Para reponer". ?period=last-order|30d|all (default last-order). */
alertsRoutes.get('/restock', async (req, res) => {
  const period = ['last-order', '30d', 'all'].includes(req.query.period) ? req.query.period : 'last-order';
  try {
    res.json(await getRestockList({ period }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** "Marcar pedido como hecho": cierra el período desde ahora. */
alertsRoutes.post('/restock/done', async (_req, res) => {
  try {
    await closeRestockPeriod();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
