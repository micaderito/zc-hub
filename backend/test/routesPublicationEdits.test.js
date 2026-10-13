/**
 * Tests de routes/publicationEdits.js: abrir (o retomar) una edición, autoguardar, descartar,
 * calcular qué cambió y avisar si la publicación cambió afuera. Mockea db, importación y remoto.
 */
import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const state = { edits: new Map(), importCalls: 0, importError: null, changed: [], jobs: new Map(), createJobOk: true };
let server, baseUrl;

const imported = () => ({
  draft: { common: { baseName: 'Cuaderno' }, ml: { description: { inherited: false, value: 'A' } } },
  baseline: { common: { baseName: 'Cuaderno' }, ml: { description: { inherited: false, value: 'A' } } },
  refs: { channels: { ml: true, tn: false }, ml: { items: [{ itemId: 'MLA1' }] } },
  locks: { mlTitle: 'con ventas' },
  notes: ['nota'],
});

before(async () => {
  mock.module('../src/db.js', {
    exports: {
      getActivePublicationEdit: async (key) => [...state.edits.values()].find((e) => e.groupKey === key && ['editing', 'saving'].includes(e.status)) || null,
      getPublicationEdit: async (id) => state.edits.get(id) || null,
      createPublicationEdit: async ({ id, groupKey, name, draft, baseline, refs, createdBy }) => {
        const e = { id, groupKey, name, draft, baseline, refs, createdBy, status: 'editing' };
        state.edits.set(id, e);
        return e;
      },
      updatePublicationEditDraft: async (id, draft) => {
        const e = state.edits.get(id);
        if (!e || e.status !== 'editing') return false;
        e.draft = draft;
        return true;
      },
      setPublicationEditStatus: async (id, status, { jobId } = {}) => {
        const e = state.edits.get(id);
        if (e) { e.status = status; if (jobId) e.jobId = jobId; }
        return !!e;
      },
      createPublishJob: async (job) => {
        if (!state.createJobOk) return null;
        state.jobs.set(job.id, { ...job, status: 'pending' });
        return job.id;
      },
      getPublishJob: async (id) => {
        const j = state.jobs.get(id);
        return j ? { id: j.id, status: j.status, lastError: null, payloadJson: j.payloadJson } : null;
      },
    },
  });
  mock.module('../src/services/publicationImport.js', {
    exports: {
      importHubProduct: async () => {
        state.importCalls++;
        if (state.importError) throw state.importError;
        return imported();
      },
      checkRemoteChanges: async () => state.changed,
    },
  });
  mock.module('../src/services/publicationDiff.js', {
    exports: {
      planPublicationUpdate: (baseline, draft) =>
        draft.ml.description.value !== baseline.ml.description.value
          ? [{ key: 'ml:MLA1:description', channel: 'ml', kind: 'description', label: 'Cambiar la descripción' }]
          : [],
      summarizeOps: (ops) => ({ total: ops.length, ml: ops.length, tn: 0 }),
    },
  });
  const { publicationEditsRoutes } = await import('../src/routes/publicationEdits.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'mica' }; next(); });
  app.use('/api/publication-edits', publicationEditsRoutes);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/publication-edits`;
});

after(() => server.close());

beforeEach(() => {
  state.edits = new Map();
  state.importCalls = 0;
  state.importError = null;
  state.changed = [];
  state.jobs = new Map();
  state.createJobOk = true;
});

const json = (method, path, body) =>
  fetch(baseUrl + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

test('POST / importa y crea la edición; la segunda vez retoma la misma sin volver a importar', async () => {
  const r1 = await json('POST', '/', { groupKey: 'ml:MLA1' });
  assert.equal(r1.status, 201);
  const e1 = await r1.json();
  assert.equal(e1.resumed, false);
  assert.deepEqual(e1.locks, { mlTitle: 'con ventas' });
  assert.deepEqual(e1.notes, ['nota']);
  assert.equal(e1.baseline, undefined, 'el baseline no viaja al front');
  assert.equal(e1.refs.locks, undefined);
  assert.equal(state.edits.get(e1.id).createdBy, 'mica');

  const r2 = await json('POST', '/', { groupKey: 'ml:MLA1' });
  const e2 = await r2.json();
  assert.equal(e2.resumed, true);
  assert.equal(e2.id, e1.id);
  assert.equal(state.importCalls, 1);
});

test('POST / sin groupKey → 400; error de importación se devuelve con su status', async () => {
  assert.equal((await json('POST', '/', {})).status, 400);
  state.importError = Object.assign(new Error('Mercado Libre no contestó'), { status: 502 });
  const r = await json('POST', '/', { groupKey: 'ml:X' });
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /no contestó/);
});

test('PUT /:id autoguarda; 409 si ya no está en edición; 404 si no existe', async () => {
  const { id } = await (await json('POST', '/', { groupKey: 'ml:MLA1' })).json();
  const draft = { common: { baseName: 'Otro' }, ml: { description: { inherited: false, value: 'B' } } };
  assert.equal((await json('PUT', `/${id}`, { draft })).status, 200);
  assert.equal(state.edits.get(id).draft.common.baseName, 'Otro');
  assert.equal((await json('PUT', `/${id}`, {})).status, 400);
  state.edits.get(id).status = 'saving';
  assert.equal((await json('PUT', `/${id}`, { draft })).status, 409);
  assert.equal((await json('PUT', '/nope', { draft })).status, 404);
});

test('POST /:id/plan calcula con el borrador en pantalla o con el guardado', async () => {
  const { id } = await (await json('POST', '/', { groupKey: 'ml:MLA1' })).json();
  const none = await (await json('POST', `/${id}/plan`)).json();
  assert.equal(none.summary.total, 0);
  const draft = { common: { baseName: 'Cuaderno' }, ml: { description: { inherited: false, value: 'Nueva' } } };
  const plan = await (await json('POST', `/${id}/plan`, { draft })).json();
  assert.equal(plan.ops[0].kind, 'description');
  assert.equal(plan.summary.total, 1);
});

test('DELETE /:id descarta (y después se puede abrir una nueva); 409 mientras se guarda', async () => {
  const { id } = await (await json('POST', '/', { groupKey: 'ml:MLA1' })).json();
  assert.equal((await json('DELETE', `/${id}`)).status, 200);
  assert.equal(state.edits.get(id).status, 'discarded');
  const again = await (await json('POST', '/', { groupKey: 'ml:MLA1' })).json();
  assert.notEqual(again.id, id);
  state.edits.get(again.id).status = 'saving';
  assert.equal((await json('DELETE', `/${again.id}`)).status, 409);
});

test('GET /:id/remote-check devuelve lo que cambió afuera', async () => {
  const { id } = await (await json('POST', '/', { groupKey: 'ml:MLA1' })).json();
  state.changed = [{ channel: 'ml', id: 'MLA1', name: 'Cuaderno' }];
  const r = await (await fetch(`${baseUrl}/${id}/remote-check`)).json();
  assert.deepEqual(r.changed, state.changed);
});

const changedDraft = { common: { baseName: 'Cuaderno' }, ml: { description: { inherited: false, value: 'Nueva' } } };

test('POST /:id/apply guarda lo de pantalla, encola un job de edición y pasa la edición a "guardando"', async () => {
  const { id } = await (await json('POST', '/', { groupKey: 'ml:MLA1' })).json();
  const r = await json('POST', `/${id}/apply`, { draft: changedDraft });
  assert.equal(r.status, 202);
  const body = await r.json();
  assert.equal(body.ops[0].kind, 'description');
  assert.equal(body.ops[0].payload, undefined, 'el front no recibe los payloads');
  const job = state.jobs.get(body.jobId);
  assert.equal(job.kind, 'update');
  assert.equal(job.editId, id);
  assert.equal(job.channels, 'ml');
  const payload = JSON.parse(job.payloadJson);
  assert.equal(payload.kind, 'update');
  assert.equal(payload.ops.length, 1);
  assert.deepEqual(payload.draft, changedDraft);
  assert.equal(state.edits.get(id).status, 'saving');
  assert.equal(state.edits.get(id).jobId, body.jobId);

  // Retomar la edición mientras se guarda trae el job y sus operaciones para mostrar el progreso.
  const again = await (await fetch(`${baseUrl}/${id}`)).json();
  assert.equal(again.job.id, body.jobId);
  assert.equal(again.jobOps[0].label, 'Cambiar la descripción');
  // Ya no se puede volver a guardar ni autoguardar.
  assert.equal((await json('POST', `/${id}/apply`, { draft: changedDraft })).status, 409);
});

test('POST /:id/apply sin cambios → 400; con cambios afuera → 409 remote_changed salvo con force', async () => {
  const { id } = await (await json('POST', '/', { groupKey: 'ml:MLA1' })).json();
  assert.equal((await json('POST', `/${id}/apply`, {})).status, 400);
  state.changed = [{ channel: 'ml', id: 'MLA1', name: 'Cuaderno' }];
  const r = await json('POST', `/${id}/apply`, { draft: changedDraft });
  assert.equal(r.status, 409);
  const b = await r.json();
  assert.equal(b.code, 'remote_changed');
  assert.deepEqual(b.changed, state.changed);
  assert.equal(state.jobs.size, 0);
  const forced = await json('POST', `/${id}/apply`, { draft: changedDraft, force: true });
  assert.equal(forced.status, 202);
});

test('POST /:id/close cierra la edición cuando el guardado terminó; 409 mientras corre', async () => {
  const { id } = await (await json('POST', '/', { groupKey: 'ml:MLA1' })).json();
  const { jobId } = await (await json('POST', `/${id}/apply`, { draft: changedDraft })).json();
  assert.equal((await json('POST', `/${id}/close`)).status, 409);
  state.jobs.get(jobId).status = 'error';
  assert.equal((await json('POST', `/${id}/close`)).status, 200);
  assert.equal(state.edits.get(id).status, 'done');
});
