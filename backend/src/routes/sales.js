/**
 * Dashboard de ventas de ML por provincia. La lógica vive en services/salesService.js; acá solo
 * HTTP. `/report` y `/export` leen únicamente la base local — nunca le pegan a ML (ver CLAUDE.md,
 * sección "Cómo se mantiene actualizado").
 */
import { Router } from 'express';
import { getSalesReport, getSyncState, triggerSync } from '../services/salesService.js';

export const salesRoutes = Router();

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normaliza un `YYYY-MM-DD` de query string al borde del día en ISO, o null si es inválido.
 * Offset fijo -03:00 (Argentina no tiene horario de verano): así el "1° de julio" que eligió la
 * usuaria es medianoche en Argentina, no UTC — con Z el rango se corría 3 horas y dejaba fuera (o
 * sumaba de más) órdenes cercanas a la medianoche.
 */
function parseDateParam(value, edge) {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return null;
  const iso = edge === 'end' ? `${value}T23:59:59.999-03:00` : `${value}T00:00:00.000-03:00`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : iso;
}

function parseRange(req, res) {
  const from = parseDateParam(req.query.from, 'start');
  const to = parseDateParam(req.query.to, 'end');
  if (!from || !to) {
    res.status(400).json({ error: 'from/to requeridos, formato YYYY-MM-DD' });
    return null;
  }
  if (from > to) {
    res.status(400).json({ error: 'from no puede ser posterior a to' });
    return null;
  }
  return { from, to };
}

/** El informe completo del rango: KPIs, provincias, top productos, evolución diaria, excluidas. */
salesRoutes.get('/report', async (req, res) => {
  const range = parseRange(req, res);
  if (!range) return;
  try {
    res.json(await getSalesReport(range.from, range.to));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Estado de la sync, para el botón "Actualizar" y su barra de progreso. */
salesRoutes.get('/sync-state', async (_req, res) => {
  try {
    res.json(await getSyncState());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Dispara el barrido (o el backfill inicial si nunca corrió) en background. No espera a que termine. */
salesRoutes.post('/sync', async (_req, res) => {
  triggerSync().catch((e) => console.error('[Ventas] triggerSync:', e.message));
  res.json({ ok: true });
});

function csvEscape(value) {
  const s = String(value ?? '');
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function formatMoneyCsv(n) {
  // Coma decimal, sin miles — Excel es-AR lo interpreta bien con el separador `;`.
  return (Number(n) || 0).toFixed(2).replace('.', ',');
}

/** CSV por provincia del rango, para mandarle al contador. */
salesRoutes.get('/export', async (req, res) => {
  const range = parseRange(req, res);
  if (!range) return;
  try {
    const report = await getSalesReport(range.from, range.to);
    const lines = ['Provincia;Ventas;Productos;Facturado'];
    for (const p of report.provinces) {
      lines.push([csvEscape(p.name), p.ventas, p.unidades, formatMoneyCsv(p.facturado)].join(';'));
    }
    lines.push(['Total', report.kpis.ventas, report.kpis.unidades, formatMoneyCsv(report.kpis.facturadoTotal)].join(';'));
    const csv = '﻿' + lines.join('\r\n') + '\r\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ventas_${req.query.from}_${req.query.to}.csv"`);
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
