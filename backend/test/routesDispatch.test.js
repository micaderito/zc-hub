/**
 * Tests de routes/dispatch.js: lista + marcas del hub (preparado / cancelado visto). Mockea el
 * servicio y db.js — acá solo se verifica el HTTP.
 */
import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const state = { listArgs: null, prepared: [], seen: [], dbOk: true };

let server, baseUrl;
before(async () => {
  mock.module('../src/services/dispatchService.js', {
    exports: {
      getDispatchList: async (args) => {
        state.listArgs = args;
        return { packages: [], errors: {} };
      },
    },
  });
  mock.module('../src/db.js', {
    exports: {
      setDispatchPrepared: async (...args) => { state.prepared.push(args); return state.dbOk; },
      setDispatchCancelSeen: async (...args) => { state.seen.push(args); return state.dbOk; },
    },
  });
  const { dispatchRoutes } = await import('../src/routes/dispatch.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'mica' }; next(); });
  app.use('/api/dispatch', dispatchRoutes);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/dispatch`;
});

after(() => server.close());
beforeEach(() => { state.listArgs = null; state.prepared = []; state.seen = []; state.dbOk = true; });

test('GET / pasa refresh solo con ?refresh=1', async () => {
  let r = await fetch(baseUrl);
  assert.equal(r.status, 200);
  assert.equal(state.listArgs.refresh, false);
  r = await fetch(`${baseUrl}?refresh=1`);
  assert.equal(state.listArgs.refresh, true);
});

test('PUT/DELETE prepared tilda y destilda con el usuario logueado', async () => {
  let r = await fetch(`${baseUrl}/ml/2000123/prepared`, { method: 'PUT' });
  assert.equal(r.status, 200);
  r = await fetch(`${baseUrl}/tn/55/prepared`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  assert.deepEqual(state.prepared, [['ml', '2000123', true, 'mica'], ['tn', '55', false]]);
});

test('PUT cancel-seen marca el cancelado como visto', async () => {
  const r = await fetch(`${baseUrl}/ml/77/cancel-seen`, { method: 'PUT' });
  assert.equal(r.status, 200);
  assert.deepEqual(state.seen, [['ml', '77']]);
});

test('canal inválido → 400; falla de base → 500', async () => {
  let r = await fetch(`${baseUrl}/xx/1/prepared`, { method: 'PUT' });
  assert.equal(r.status, 400);
  state.dbOk = false;
  r = await fetch(`${baseUrl}/ml/1/prepared`, { method: 'PUT' });
  assert.equal(r.status, 500);
});
