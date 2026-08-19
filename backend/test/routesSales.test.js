/**
 * Tests de routes/sales.js (dashboard de ventas por provincia): validación de fechas, forma del
 * CSV exportado, y que POST /sync no bloquee la respuesta. La lógica de negocio está cubierta en
 * salesService.test.js — acá mockeamos ese servicio y solo se verifica el HTTP.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mock } from 'node:test';

const serviceState = {
  report: {
    kpis: { facturadoTotal: 1000, facturadoDeltaPct: 5, ventas: 2, ventasDeltaPct: 0, unidades: 3, unidadesDeltaPct: 0, ticketPromedio: 500, ticketPromedioDeltaPct: 0 },
    provinces: [{ name: 'CABA', ventas: 2, unidades: 3, facturado: 1000, pctOfTotal: 100, deltaPct: 5 }],
    excluded: { total: 2, facturadas: 2, canceladas: 0, devueltas: 0 },
    topProducts: [],
    daily: [],
  },
  syncState: { status: 'idle', lastSyncAt: null, processed: 0, total: 0, phase: null },
  reportCalls: [],
  triggerSyncCalls: 0,
  triggerSyncDelayMs: 0,
};

let app, server, baseUrl;

before(async () => {
  mock.module('../src/services/salesService.js', {
    exports: {
      getSalesReport: async (from, to) => {
        serviceState.reportCalls.push([from, to]);
        return serviceState.report;
      },
      getSyncState: async () => serviceState.syncState,
      triggerSync: async () => {
        serviceState.triggerSyncCalls++;
        if (serviceState.triggerSyncDelayMs > 0) await new Promise((r) => setTimeout(r, serviceState.triggerSyncDelayMs));
      },
    },
  });

  const { salesRoutes } = await import('../src/routes/sales.js');
  app = express();
  app.use(express.json());
  app.use('/api/sales', salesRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/sales`;
});

after(() => { server.close(); });

beforeEach(() => {
  serviceState.reportCalls = [];
  serviceState.triggerSyncCalls = 0;
  serviceState.triggerSyncDelayMs = 0;
  serviceState.syncState = { status: 'idle', lastSyncAt: null, processed: 0, total: 0, phase: null };
});

// ─── GET /report ────────────────────────────────────────────────────────────

test('GET /report: from/to válidos devuelve el informe', async () => {
  const res = await fetch(`${baseUrl}/report?from=2026-07-01&to=2026-07-31`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.kpis.facturadoTotal, 1000);
  assert.equal(serviceState.reportCalls.length, 1);
  // Offset -03:00, no Z — ver comentario en parseDateParam.
  assert.equal(serviceState.reportCalls[0][0], '2026-07-01T00:00:00.000-03:00');
  assert.equal(serviceState.reportCalls[0][1], '2026-07-31T23:59:59.999-03:00');
});

test('GET /report: sin from/to → 400', async () => {
  const res = await fetch(`${baseUrl}/report`);
  assert.equal(res.status, 400);
});

test('GET /report: formato de fecha inválido → 400', async () => {
  const res = await fetch(`${baseUrl}/report?from=01-07-2026&to=2026-07-31`);
  assert.equal(res.status, 400);
});

test('GET /report: from posterior a to → 400', async () => {
  const res = await fetch(`${baseUrl}/report?from=2026-08-01&to=2026-07-31`);
  assert.equal(res.status, 400);
  assert.equal(serviceState.reportCalls.length, 0, 'no debería haber llegado a pedir el informe');
});

test('GET /report: from == to (un solo día) es válido', async () => {
  const res = await fetch(`${baseUrl}/report?from=2026-07-15&to=2026-07-15`);
  assert.equal(res.status, 200);
});

// ─── GET /sync-state ────────────────────────────────────────────────────────

test('GET /sync-state: devuelve el estado tal cual lo da el servicio', async () => {
  serviceState.syncState = { status: 'running', lastSyncAt: '2026-07-01T00:00:00.000Z', processed: 42, total: 100, phase: 'guardando ventas' };
  const res = await fetch(`${baseUrl}/sync-state`);
  const body = await res.json();
  assert.equal(body.status, 'running');
  assert.equal(body.processed, 42);
});

// ─── POST /sync ─────────────────────────────────────────────────────────────

test('POST /sync: responde ok=true sin esperar a que termine la sync', async () => {
  serviceState.triggerSyncDelayMs = 300;
  const start = Date.now();
  const res = await fetch(`${baseUrl}/sync`, { method: 'POST' });
  const elapsed = Date.now() - start;
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(elapsed < 250, `la respuesta no debería esperar los ${serviceState.triggerSyncDelayMs}ms de la sync (tardó ${elapsed}ms)`);
});

// ─── GET /export ────────────────────────────────────────────────────────────

test('GET /export: devuelve CSV con separador ; y coma decimal', async () => {
  const res = await fetch(`${baseUrl}/export?from=2026-07-01&to=2026-07-31`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/csv/);
  const text = await res.text();
  const lines = text.trim().split('\r\n');
  assert.equal(lines[0], 'Provincia;Ventas;Productos;Facturado');
  assert.match(lines[1], /^CABA;2;3;1000,00$/);
  assert.match(lines[lines.length - 1], /^Total;2;3;1000,00$/);
});

test('GET /export: from/to inválidos → 400, igual que /report', async () => {
  const res = await fetch(`${baseUrl}/export?from=nope&to=2026-07-31`);
  assert.equal(res.status, 400);
});
