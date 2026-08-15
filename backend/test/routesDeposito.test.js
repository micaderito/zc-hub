/**
 * Tests de routes/deposito.js: CRUD del stock de Depósito Marañón (aparte de ML/TN). Mockea
 * db.js — la persistencia real está cubierta por db.test.js si hiciera falta; acá solo se
 * verifica el HTTP (validación, status codes, forma de la respuesta).
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mock } from 'node:test';

const dbState = {
  items: [],
  createResult: undefined,
  updateResult: undefined,
  adjustResult: undefined,
  deleteResult: true,
  lastCreateArgs: null,
  lastUpdateArgs: null,
};

let app, server, baseUrl;

before(async () => {
  mock.module('../src/db.js', {
    exports: {
      getDepositoItems: async () => dbState.items,
      createDepositoItem: async (data) => {
        dbState.lastCreateArgs = data;
        return dbState.createResult;
      },
      updateDepositoItem: async (id, data) => {
        dbState.lastUpdateArgs = { id, data };
        return dbState.updateResult;
      },
      adjustDepositoQuantity: async () => dbState.adjustResult,
      deleteDepositoItem: async () => dbState.deleteResult,
    },
  });

  const { depositoRoutes } = await import('../src/routes/deposito.js');
  app = express();
  app.use(express.json());
  app.use('/api/deposito', depositoRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/deposito`;
});

after(() => { server.close(); });

beforeEach(() => {
  dbState.items = [];
  dbState.createResult = { id: 1, sku: null, label: 'Rollo de burbupack', itemType: 'embalaje', quantity: 0, unit: 'rollos', notes: null };
  dbState.updateResult = { id: 1, sku: 'SKU1', label: 'Cuaderno A4', itemType: 'producto', quantity: 10, unit: 'unidades', notes: null };
  dbState.adjustResult = { id: 1, sku: null, label: 'Rollo de burbupack', itemType: 'embalaje', quantity: 5, unit: 'rollos', notes: null };
  dbState.deleteResult = true;
  dbState.lastCreateArgs = null;
  dbState.lastUpdateArgs = null;
});

test('GET /: lista el stock de depósito', async () => {
  dbState.items = [{ id: 1, label: 'X', itemType: 'embalaje', quantity: 0, unit: 'rollos' }];
  const res = await fetch(`${baseUrl}/`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.items.length, 1);
});

test('POST /: sin label → 400', async () => {
  const res = await fetch(`${baseUrl}/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemType: 'embalaje' }),
  });
  assert.equal(res.status, 400);
});

test('POST /: tipo producto sin sku → 400', async () => {
  const res = await fetch(`${baseUrl}/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'Cuaderno', itemType: 'producto' }),
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.match(body.error, /sku/);
});

test('POST /: tipo embalaje con sku → 400', async () => {
  const res = await fetch(`${baseUrl}/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'Rollo', itemType: 'embalaje', sku: 'X' }),
  });
  assert.equal(res.status, 400);
});

test('POST /: embalaje sin sku → 200', async () => {
  const res = await fetch(`${baseUrl}/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'Rollo de burbupack', itemType: 'embalaje', unit: 'rollos', quantity: 3 }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(dbState.lastCreateArgs.sku, null);
  assert.equal(dbState.lastCreateArgs.quantity, 3);
});

test('POST /: producto con sku → 200', async () => {
  const res = await fetch(`${baseUrl}/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'Cuaderno A4', itemType: 'producto', sku: 'SKU1', quantity: 10 }),
  });
  assert.equal(res.status, 200);
  assert.equal(dbState.lastCreateArgs.sku, 'SKU1');
});

test('POST /: si createDepositoItem devuelve null → 500', async () => {
  dbState.createResult = null;
  const res = await fetch(`${baseUrl}/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'X', itemType: 'embalaje' }),
  });
  assert.equal(res.status, 500);
});

test('PUT /:id: id inválido → 400', async () => {
  const res = await fetch(`${baseUrl}/abc`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'X', itemType: 'embalaje' }),
  });
  assert.equal(res.status, 400);
});

test('PUT /:id: edita con éxito', async () => {
  const res = await fetch(`${baseUrl}/1`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'Cuaderno A4', itemType: 'producto', sku: 'SKU1', quantity: 10 }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.item.quantity, 10);
  assert.equal(dbState.lastUpdateArgs.id, 1);
});

test('PUT /:id: fila inexistente → 404', async () => {
  dbState.updateResult = null;
  const res = await fetch(`${baseUrl}/99`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'X', itemType: 'embalaje' }),
  });
  assert.equal(res.status, 404);
});

test('PATCH /:id/ajustar: sin delta → 400', async () => {
  const res = await fetch(`${baseUrl}/1/ajustar`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test('PATCH /:id/ajustar: suma con éxito', async () => {
  const res = await fetch(`${baseUrl}/1/ajustar`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delta: 1 }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.item.quantity, 5);
});

test('PATCH /:id/ajustar: fila inexistente → 404', async () => {
  dbState.adjustResult = null;
  const res = await fetch(`${baseUrl}/99/ajustar`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delta: -1 }),
  });
  assert.equal(res.status, 404);
});

test('DELETE /:id: borra con éxito', async () => {
  const res = await fetch(`${baseUrl}/1`, { method: 'DELETE' });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
});

test('DELETE /:id: fila inexistente → 404', async () => {
  dbState.deleteResult = false;
  const res = await fetch(`${baseUrl}/99`, { method: 'DELETE' });
  assert.equal(res.status, 404);
});
