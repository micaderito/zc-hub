/**
 * Rutas de Pedidos al proveedor. La lógica vive en services/ordersService.js; acá va solo el HTTP.
 * Ver CLAUDE.md → "Pedidos al proveedor".
 */
import { Router } from 'express';
import {
  getCatalog, listOrders, getOrder, createOrder, saveDraft, placeOrder, receiveOrder,
  duplicateOrder, deleteDraft, getSettings, saveSettings, sanitizeOrderInput,
} from '../services/ordersService.js';

export const ordersRoutes = Router();

const parseId = (req) => {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
};

/** Pedidos (más nuevos primero) con sus totales. ?status=borrador|pendiente|recibido */
ordersRoutes.get('/', async (req, res) => {
  try {
    res.json({ orders: await listOrders({ status: req.query.status }) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Unidades de compra para agregar a un pedido (packs + SKUs sueltos), con stock, alerta, precio y código. */
ordersRoutes.get('/catalog', async (_req, res) => {
  try {
    res.json({ units: await getCatalog() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Descuentos por defecto de un pedido nuevo. */
ordersRoutes.get('/settings', async (_req, res) => {
  try {
    res.json(await getSettings());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

ordersRoutes.put('/settings', async (req, res) => {
  try {
    const r = await saveSettings(req.body);
    if (r.error) return res.status(400).json({ error: r.error });
    res.json(r.value);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Crea un borrador vacío. Body opcional: { name }. */
ordersRoutes.post('/', async (req, res) => {
  try {
    const order = await createOrder({ name: req.body?.name });
    if (!order) return res.status(500).json({ error: 'No se pudo crear el pedido' });
    res.status(201).json({ order });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

ordersRoutes.get('/:id', async (req, res) => {
  const id = parseId(req);
  if (!id) return res.status(400).json({ error: 'id inválido' });
  try {
    const order = await getOrder(id);
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
    res.json({ order });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Guarda un borrador entero: { name, note, discount1, discount2, lines[] }. 409 si ya no es borrador. */
ordersRoutes.put('/:id', async (req, res) => {
  const id = parseId(req);
  if (!id) return res.status(400).json({ error: 'id inválido' });
  const { value, error } = sanitizeOrderInput(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const r = await saveDraft(id, value);
    if (r === 'not_found') return res.status(404).json({ error: 'Pedido no encontrado' });
    if (r === 'not_draft') return res.status(409).json({ error: 'El pedido ya se mandó: no se puede editar' });
    if (!r) return res.status(500).json({ error: 'No se pudo guardar el pedido' });
    res.json({ order: r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Borrador → pendiente ("Marcar como pedido"). */
ordersRoutes.post('/:id/place', async (req, res) => {
  const id = parseId(req);
  if (!id) return res.status(400).json({ error: 'id inválido' });
  try {
    if (!(await placeOrder(id))) return res.status(409).json({ error: 'Solo se puede marcar como pedido un borrador' });
    res.json({ order: await getOrder(id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Recepción: body { received: { [lineId]: qty|null }, close?: boolean }. Sin `close` solo guarda
 * lo anotado; con `close` el pedido pasa a recibido (incompleto si alguna línea llegó corta).
 */
ordersRoutes.put('/:id/receive', async (req, res) => {
  const id = parseId(req);
  if (!id) return res.status(400).json({ error: 'id inválido' });
  const received = {};
  for (const [lineId, raw] of Object.entries(req.body?.received ?? {})) {
    if (raw === null || raw === '') { received[lineId] = null; continue; }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) return res.status(400).json({ error: 'Cantidad recibida inválida' });
    received[lineId] = n;
  }
  try {
    const r = await receiveOrder(id, received, { close: !!req.body?.close });
    if (r === 'not_found') return res.status(404).json({ error: 'Pedido no encontrado' });
    if (r === 'not_pending') return res.status(409).json({ error: 'Solo se registra la recepción de un pedido pendiente' });
    if (!r) return res.status(500).json({ error: 'No se pudo guardar la recepción' });
    res.json({ order: r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Pedido nuevo a partir de otro: { mode: 'all'|'missing', status: 'borrador'|'pendiente' }. */
ordersRoutes.post('/:id/duplicate', async (req, res) => {
  const id = parseId(req);
  if (!id) return res.status(400).json({ error: 'id inválido' });
  const mode = req.body?.mode === 'missing' ? 'missing' : 'all';
  const status = req.body?.status === 'pendiente' ? 'pendiente' : 'borrador';
  try {
    const order = await duplicateOrder(id, { mode, status });
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
    res.status(201).json({ order });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Borra un borrador (un pedido mandado es historial: 409). */
ordersRoutes.delete('/:id', async (req, res) => {
  const id = parseId(req);
  if (!id) return res.status(400).json({ error: 'id inválido' });
  try {
    if (!(await deleteDraft(id))) return res.status(409).json({ error: 'Solo se puede borrar un borrador' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
