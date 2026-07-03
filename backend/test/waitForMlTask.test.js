/**
 * Tests de waitForMlTask (db.js).
 *
 * Las escrituras a ML (stock_ml) las aplica el worker en segundo plano (mlTaskQueue.js), no la
 * request que las encola. Reintentar/revertir esperan a que la tarea termine (waitForMlTask) antes
 * de responder, para que el historial ya muestre el resultado cuando el frontend recarga la lista.
 *
 * Mockeamos `pg` para no necesitar una base real: getMlTaskStatus hace un SELECT simple sobre
 * ml_pending_tasks, así que alcanza con una Pool falsa que devuelve filas armadas a mano.
 */
import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const state = { statuses: [] };

class MockPool {
  async query(_sql, _params) {
    // Cada llamada consume el próximo estado simulado de la cola (o repite el último).
    const row = state.statuses.length > 1 ? state.statuses.shift() : state.statuses[0];
    return { rows: row ? [row] : [] };
  }
}

let db;
before(async () => {
  mock.module('pg', { exports: { default: { Pool: MockPool } } });
  process.env.DATABASE_URL = 'postgres://test/db';
  db = await import('../src/db.js');
});
beforeEach(() => {
  state.statuses = [];
});

test('taskId nulo: no consulta la base y devuelve null enseguida', async () => {
  const result = await db.waitForMlTask(null, 100, 5);
  assert.equal(result, null);
});

test('tarea ya "done" en el primer poll: devuelve el estado sin reintentar', async () => {
  state.statuses = [{ id: 1, status: 'done' }];
  const result = await db.waitForMlTask(1, 1000, 5);
  assert.equal(result.status, 'done');
});

test('tarea "failed": devuelve el estado con el error para poder mostrarlo', async () => {
  state.statuses = [{ id: 2, status: 'failed', lastError: 'ML rechazó el precio' }];
  const result = await db.waitForMlTask(2, 1000, 5);
  assert.equal(result.status, 'failed');
  assert.equal(result.lastError, 'ML rechazó el precio');
});

test('sigue en pending/processing por un rato y termina en done: hace polling hasta el resultado final', async () => {
  state.statuses = [
    { id: 3, status: 'pending' },
    { id: 3, status: 'processing' },
    { id: 3, status: 'done' },
  ];
  const result = await db.waitForMlTask(3, 1000, 5);
  assert.equal(result.status, 'done');
});

test('si nunca termina, corta por timeout y devuelve null (la tarea sigue en cola, el worker la termina igual)', async () => {
  state.statuses = [{ id: 4, status: 'pending' }];
  const start = Date.now();
  const result = await db.waitForMlTask(4, 30, 10);
  assert.equal(result, null);
  assert.ok(Date.now() - start >= 30, 'debe respetar el timeout como mínimo');
});
