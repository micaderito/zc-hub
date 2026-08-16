/**
 * Rutas de Depósito Marañón: stock físico guardado en el depósito, aparte de lo publicado en
 * ML/TN (productos ya cargados + insumos de embalaje sin canal). CRUD simple sobre deposito_stock;
 * la lógica vive directo en db.js, no amerita un service aparte.
 */
import { Router } from 'express';
import {
  getDepositoItems, createDepositoItem, updateDepositoItem,
  adjustDepositoQuantity, deleteDepositoItem,
} from '../db.js';

export const depositoRoutes = Router();

function validateBody(body) {
  const label = (body?.label || '').trim();
  if (!label) return 'label es requerido';
  const itemType = body?.itemType === 'embalaje' ? 'embalaje' : 'producto';
  const sku = (body?.sku || '').trim() || null;
  if (itemType === 'producto' && !sku) return 'sku es requerido para un producto (elegilo del catálogo)';
  if (itemType === 'embalaje' && sku) return 'un ítem de embalaje no puede tener sku';
  return null;
}

/** Todo el stock de depósito. */
depositoRoutes.get('/', async (_req, res) => {
  try {
    res.json({ items: await getDepositoItems() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Alta de una fila (producto vinculado a un SKU o insumo de embalaje). */
depositoRoutes.post('/', async (req, res) => {
  const error = validateBody(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const item = await createDepositoItem({
      sku: (req.body.sku || '').trim() || null,
      label: req.body.label.trim(),
      itemType: req.body.itemType === 'embalaje' ? 'embalaje' : 'producto',
      quantity: req.body.quantity,
      unit: (req.body.unit || '').trim() || 'unidades',
      notes: req.body.notes,
    });
    if (!item) return res.status(500).json({ error: 'No se pudo guardar' });
    res.json({ ok: true, item });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Edición completa de una fila. */
depositoRoutes.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
  const error = validateBody(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const item = await updateDepositoItem(id, {
      sku: (req.body.sku || '').trim() || null,
      label: req.body.label.trim(),
      itemType: req.body.itemType === 'embalaje' ? 'embalaje' : 'producto',
      quantity: req.body.quantity,
      unit: (req.body.unit || '').trim() || 'unidades',
      notes: req.body.notes,
    });
    if (!item) return res.status(404).json({ error: 'No se encontró la fila' });
    res.json({ ok: true, item });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Ajuste rápido de cantidad (+1/-1 desde la tabla). Body: { delta }. */
depositoRoutes.patch('/:id/ajustar', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
  const delta = Number(req.body?.delta);
  if (!Number.isFinite(delta) || delta === 0) return res.status(400).json({ error: 'delta requerido' });
  try {
    const item = await adjustDepositoQuantity(id, delta);
    if (!item) return res.status(404).json({ error: 'No se encontró la fila' });
    res.json({ ok: true, item });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Borra una fila de depósito. */
depositoRoutes.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
  try {
    const ok = await deleteDepositoItem(id);
    if (!ok) return res.status(404).json({ error: 'No se encontró la fila' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
