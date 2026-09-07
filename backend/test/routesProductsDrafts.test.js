/**
 * Tests HTTP de los endpoints nuevos de routes/products.js: borradores + publicación en
 * background (product_drafts / product_publish_jobs / product_publish_units).
 *
 * Mockeamos '../db.js' con un almacenamiento en memoria (Maps) que imita el comportamiento real
 * lo suficiente para probar el contrato HTTP (status codes, forma de la respuesta, que borrar un
 * borrador limpie sus imágenes) sin necesitar Postgres.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mock } from 'node:test';

const db = {
  drafts: new Map(),
  jobs: new Map()
};

function seedDb() {
  db.drafts.clear();
  db.jobs.clear();
}

let app, server, baseUrl;
const removedImages = [];

before(async () => {
  // db.js tiene ~100 exports y routes/products.js arrastra otros servicios (packsService.js →
  // alertsService.js) que hacen imports NOMBRADOS de un montón de ellos — un mock.module con solo
  // los que usamos acá rompería esa cadena en cuanto faltara uno (los imports nombrados fallan al
  // cargar el módulo, no al llamarlos). Por eso partimos del módulo REAL (sin DATABASE_URL, sus
  // funciones ya devuelven null/false/[] solas) y solo pisamos las que este archivo necesita con
  // estado real.
  const realDb = await import('../src/db.js');
  mock.module('../src/db.js', {
    exports: {
      ...realDb,
      createProductDraft: async ({ id, name, sku, draftJson }) => {
        db.drafts.set(id, { id, name, sku, draftJson, status: 'draft', createdAt: new Date(), updatedAt: new Date() });
        return id;
      },
      updateProductDraft: async (id, { name, sku, draftJson }) => {
        const d = db.drafts.get(id);
        if (!d) return false;
        Object.assign(d, { name, sku, draftJson, updatedAt: new Date() });
        return true;
      },
      setProductDraftStatus: async (id, status) => {
        const d = db.drafts.get(id);
        if (!d) return false;
        d.status = status;
        return true;
      },
      getProductDraft: async (id) => {
        const d = db.drafts.get(id);
        return d ? { ...d, draft: JSON.parse(d.draftJson) } : null;
      },
      listProductDrafts: async () => [...db.drafts.values()].map(({ draftJson, ...rest }) => rest),
      deleteProductDraft: async (id) => db.drafts.delete(id),
      createPublishJob: async ({ id, draftId, channels, payloadJson }) => {
        db.jobs.set(id, { id, draftId, channels, payloadJson, status: 'pending', units: [] });
        return id;
      },
      getPublishJob: async (id) => {
        const j = db.jobs.get(id);
        return j ? { id: j.id, draftId: j.draftId, channels: j.channels, status: j.status } : null;
      },
      listPublishJobsForDraft: async (draftId) => [...db.jobs.values()].filter((j) => j.draftId === draftId).map((j) => ({ id: j.id, status: j.status })),
      deletePublishJob: async (id) => db.jobs.delete(id),
      retryPublishJob: async (id) => {
        const j = db.jobs.get(id);
        if (!j || j.status !== 'error') return false;
        j.status = 'pending';
        return true;
      },
      cancelPublishJob: async (id) => {
        const j = db.jobs.get(id);
        if (!j || !['pending', 'processing', 'error'].includes(j.status)) return false;
        j.status = 'cancelled';
        return true;
      },
      getPublishUnits: async (id) => db.jobs.get(id)?.units ?? []
    }
  });
  mock.module('../src/services/imageStore.js', {
    exports: {
      saveImage: () => ({}),
      saveImageBuffer: () => ({}),
      saveThumbBuffer: () => ({}),
      getImage: () => null,
      getImageUrl: async () => null,
      getThumb: () => null,
      removeImage: async (id) => { removedImages.push(id); }
    }
  });
  mock.module('../src/middleware/requireAuth.js', {
    exports: {
      requireAuth: (req, res, next) => {
        if (req.headers.authorization === 'Bearer ok') return next();
        return res.status(401).json({ error: 'Sesión inválida o vencida' });
      },
      invalidateAuthUserCache: () => {}
    }
  });
  mock.module('../src/store.js', { exports: { tokens: {}, getMlToken: async () => null } });
  mock.module('../src/lib/mercadolibre.js', { exports: { getCategory: async () => null, getCategoryAttributes: async () => null, getMe: async () => ({ tags: [] }) } });

  const { productRoutes } = await import('../src/routes/products.js');
  app = express();
  app.use(express.json());
  app.use('/api/products', productRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/products`;
});

after(() => server.close());
beforeEach(() => {
  seedDb();
  removedImages.length = 0;
});

const AUTH = { Authorization: 'Bearer ok', 'Content-Type': 'application/json' };
const sampleDraft = { common: { sku: 'CUA-1' }, ml: {}, tn: {} };

test('POST /drafts crea un borrador y devuelve su id; GET /drafts lo lista', async () => {
  const created = await fetch(`${baseUrl}/drafts`, { method: 'POST', headers: AUTH, body: JSON.stringify({ name: 'Cuaderno', sku: 'CUA-1', draft: sampleDraft }) });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  assert.ok(id);

  const list = await fetch(`${baseUrl}/drafts`, { headers: AUTH });
  const body = await list.json();
  assert.equal(body.length, 1);
  assert.equal(body[0].id, id);
  assert.equal(body[0].draftJson, undefined); // la lista NO trae el draft completo
});

test('POST /drafts sin "draft" → 400', async () => {
  const res = await fetch(`${baseUrl}/drafts`, { method: 'POST', headers: AUTH, body: JSON.stringify({ name: 'x' }) });
  assert.equal(res.status, 400);
});

test('GET /drafts/:id devuelve el draft parseado + su historial de jobs; 404 si no existe', async () => {
  const created = await fetch(`${baseUrl}/drafts`, { method: 'POST', headers: AUTH, body: JSON.stringify({ draft: sampleDraft }) });
  const { id } = await created.json();

  const res = await fetch(`${baseUrl}/drafts/${id}`, { headers: AUTH });
  const body = await res.json();
  assert.deepEqual(body.draft, sampleDraft);
  assert.deepEqual(body.jobs, []);

  const missing = await fetch(`${baseUrl}/drafts/no-existe`, { headers: AUTH });
  assert.equal(missing.status, 404);
});

test('PUT /drafts/:id actualiza (autosave); 404 si el borrador no existe', async () => {
  const created = await fetch(`${baseUrl}/drafts`, { method: 'POST', headers: AUTH, body: JSON.stringify({ draft: sampleDraft }) });
  const { id } = await created.json();

  const updated = { ...sampleDraft, common: { sku: 'CUA-2' } };
  const res = await fetch(`${baseUrl}/drafts/${id}`, { method: 'PUT', headers: AUTH, body: JSON.stringify({ draft: updated }) });
  assert.equal(res.status, 200);

  const got = await (await fetch(`${baseUrl}/drafts/${id}`, { headers: AUTH })).json();
  assert.deepEqual(got.draft, updated);

  const missing = await fetch(`${baseUrl}/drafts/no-existe`, { method: 'PUT', headers: AUTH, body: JSON.stringify({ draft: updated }) });
  assert.equal(missing.status, 404);
});

test('DELETE /drafts/:id borra el borrador Y las imágenes que tenía referenciadas', async () => {
  const imgId = 'a'.repeat(32); // 32 hex, como un id real de imageStore
  const draftWithImage = { ml: { images: [{ id: imgId }] }, tn: {} };
  const created = await fetch(`${baseUrl}/drafts`, { method: 'POST', headers: AUTH, body: JSON.stringify({ draft: draftWithImage }) });
  const { id } = await created.json();

  const res = await fetch(`${baseUrl}/drafts/${id}`, { method: 'DELETE', headers: AUTH });
  assert.equal(res.status, 200);
  assert.ok(removedImages.includes(imgId));

  const missing = await fetch(`${baseUrl}/drafts/${id}`, { headers: AUTH });
  assert.equal(missing.status, 404);
});

test('DELETE /drafts/:id de un id inexistente → 404, no borra imágenes de nadie', async () => {
  const res = await fetch(`${baseUrl}/drafts/no-existe`, { method: 'DELETE', headers: AUTH });
  assert.equal(res.status, 404);
  assert.equal(removedImages.length, 0);
});

test('POST /drafts/:id/publish encola un job y devuelve 202 + jobId; deja el borrador "publishing"', async () => {
  const created = await fetch(`${baseUrl}/drafts`, { method: 'POST', headers: AUTH, body: JSON.stringify({ draft: sampleDraft }) });
  const { id } = await created.json();

  const res = await fetch(`${baseUrl}/drafts/${id}/publish`, { method: 'POST', headers: AUTH, body: JSON.stringify({ payload: { ml: {}, tn: {} } }) });
  assert.equal(res.status, 202);
  const { jobId } = await res.json();
  assert.ok(jobId);
  assert.equal(db.drafts.get(id).status, 'publishing');
  assert.equal(db.jobs.get(jobId).channels, 'ml,tn');
});

test('POST /drafts/:id/publish con channels=["ml"] encola solo ese canal', async () => {
  const created = await fetch(`${baseUrl}/drafts`, { method: 'POST', headers: AUTH, body: JSON.stringify({ draft: sampleDraft }) });
  const { id } = await created.json();
  const res = await fetch(`${baseUrl}/drafts/${id}/publish`, { method: 'POST', headers: AUTH, body: JSON.stringify({ payload: { ml: {}, tn: {} }, channels: ['ml'] }) });
  const { jobId } = await res.json();
  assert.equal(db.jobs.get(jobId).channels, 'ml');
});

test('POST /drafts/:id/publish: payload inválido → 400; borrador inexistente → 404', async () => {
  const created = await fetch(`${baseUrl}/drafts`, { method: 'POST', headers: AUTH, body: JSON.stringify({ draft: sampleDraft }) });
  const { id } = await created.json();

  const badPayload = await fetch(`${baseUrl}/drafts/${id}/publish`, { method: 'POST', headers: AUTH, body: JSON.stringify({ payload: { ml: {} } }) });
  assert.equal(badPayload.status, 400);

  const noDraft = await fetch(`${baseUrl}/drafts/no-existe/publish`, { method: 'POST', headers: AUTH, body: JSON.stringify({ payload: { ml: {}, tn: {} } }) });
  assert.equal(noDraft.status, 404);
});

test('GET /jobs/:id devuelve el job + sus unidades; 404 si no existe', async () => {
  const created = await fetch(`${baseUrl}/drafts`, { method: 'POST', headers: AUTH, body: JSON.stringify({ draft: sampleDraft }) });
  const { id } = await created.json();
  const pub = await fetch(`${baseUrl}/drafts/${id}/publish`, { method: 'POST', headers: AUTH, body: JSON.stringify({ payload: { ml: {}, tn: {} } }) });
  const { jobId } = await pub.json();

  const res = await fetch(`${baseUrl}/jobs/${jobId}`, { headers: AUTH });
  const body = await res.json();
  assert.equal(body.job.id, jobId);
  assert.deepEqual(body.units, []);

  const missing = await fetch(`${baseUrl}/jobs/no-existe`, { headers: AUTH });
  assert.equal(missing.status, 404);
});

test('POST /jobs/:id/retry: 200 si el job estaba en error; 409 si no es reintentable', async () => {
  db.jobs.set('j-error', { id: 'j-error', draftId: 'd1', channels: 'ml', status: 'error', units: [] });
  db.jobs.set('j-vivo', { id: 'j-vivo', draftId: 'd1', channels: 'ml', status: 'processing', units: [] });

  const ok = await fetch(`${baseUrl}/jobs/j-error/retry`, { method: 'POST', headers: AUTH });
  assert.equal(ok.status, 200);
  assert.equal(db.jobs.get('j-error').status, 'pending');

  const notRetryable = await fetch(`${baseUrl}/jobs/j-vivo/retry`, { method: 'POST', headers: AUTH });
  assert.equal(notRetryable.status, 409);
});

test('POST /jobs/:id/cancel: 200 si estaba pending/processing/error; 409 si ya terminó', async () => {
  db.jobs.set('j-run', { id: 'j-run', draftId: 'd1', channels: 'ml,tn', status: 'processing', units: [] });
  db.jobs.set('j-fin', { id: 'j-fin', draftId: 'd1', channels: 'ml,tn', status: 'done', units: [] });

  const ok = await fetch(`${baseUrl}/jobs/j-run/cancel`, { method: 'POST', headers: AUTH });
  assert.equal(ok.status, 200);
  assert.equal(db.jobs.get('j-run').status, 'cancelled');

  const done = await fetch(`${baseUrl}/jobs/j-fin/cancel`, { method: 'POST', headers: AUTH });
  assert.equal(done.status, 409);
});

test('DELETE /jobs/:id borra la entrada del historial; 404 si no existe', async () => {
  db.jobs.set('j1', { id: 'j1', draftId: 'd1', channels: 'ml', status: 'done', units: [] });
  const res = await fetch(`${baseUrl}/jobs/j1`, { method: 'DELETE', headers: AUTH });
  assert.equal(res.status, 200);
  assert.equal(db.jobs.has('j1'), false);

  const missing = await fetch(`${baseUrl}/jobs/no-existe`, { method: 'DELETE', headers: AUTH });
  assert.equal(missing.status, 404);
});

test('todos los endpoints de drafts/jobs exigen sesión', async () => {
  const created = await fetch(`${baseUrl}/drafts`, { method: 'POST', headers: AUTH, body: JSON.stringify({ draft: sampleDraft }) });
  const { id } = await created.json();

  for (const [method, path] of [
    ['GET', '/drafts'],
    ['POST', '/drafts'],
    ['GET', `/drafts/${id}`],
    ['PUT', `/drafts/${id}`],
    ['DELETE', `/drafts/${id}`],
    ['POST', `/drafts/${id}/publish`],
    ['POST', '/jobs/x/cancel'],
    ['GET', '/jobs/x'],
    ['POST', '/jobs/x/retry'],
    ['DELETE', '/jobs/x']
  ]) {
    const res = await fetch(`${baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' || method === 'DELETE' ? undefined : '{}' });
    assert.equal(res.status, 401, `${method} ${path} debería exigir sesión`);
  }
});
