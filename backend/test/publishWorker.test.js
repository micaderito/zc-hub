/**
 * Tests de publishWorker.js: orquesta un job de publicación (ambos canales en paralelo, como el
 * publish síncrono), pero registrando cada unidad apenas se confirma y SALTEANDO las que ya están
 * 'ok' de un intento anterior — es la pieza que evita que reintentar duplique lo ya creado.
 *
 * Mockeamos '../db.js', './productPublish.js' y '../store.js' (rutas resueltas desde
 * src/services/publishWorker.js), mismo patrón que mlTaskQueue.test.js.
 */
import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const dbState = {
  claimedJob: null,
  existingUnits: [],
  upserts: [],
  seeded: [],
  finished: null,
  heartbeats: [],
  recomputed: null,
  hasDb: true,
  cancelledAfter: null // si es N, isPublishJobCancelled devuelve true a partir de la llamada N (1-based)
};
const publishState = {
  mlUnits: [{ unitKey: 'CUA-N', body: { a: 1 } }],
  tnUnits: [{ unitKey: 'CUA-N', body: { b: 1 }, uploadIds: [], forVariants: [] }],
  mlThrows: null,
  tnThrows: null,
  planMlThrows: null,
  planTnThrows: null,
  mlCallCount: 0,
  mlFailOnCall: null // si se setea, publishMlUnit tira en esa llamada N (1-based)
};
const storeState = { mlToken: 'ml-tok', tokens: { tiendanube: { access_token: 'tn-tok', store_id: '9' } } };

let publishWorker;
before(async () => {
  mock.module('../src/db.js', {
    exports: {
      claimNextPublishJob: async () => dbState.claimedJob,
      touchPublishJobLock: async () => {
        dbState.heartbeats.push(Date.now());
        return true;
      },
      finishPublishJob: async (jobId, status, error) => {
        dbState.finished = { jobId, status, error };
        return true;
      },
      seedPublishUnits: async (jobId, channel, unitKeys) => {
        dbState.seeded.push({ jobId, channel, unitKeys });
        return true;
      },
      isPublishJobCancelled: async () => {
        dbState.cancelCheckCalls = (dbState.cancelCheckCalls || 0) + 1;
        return dbState.cancelledAfter != null && dbState.cancelCheckCalls >= dbState.cancelledAfter;
      },
      upsertPublishUnit: async (u) => {
        dbState.upserts.push(u);
        return true;
      },
      getPublishUnits: async () => dbState.existingUnits,
      recomputeDraftStatus: async (draftId) => {
        dbState.recomputed = draftId;
        return 'done';
      },
      hasDatabase: () => dbState.hasDb,
      PUBLISH_JOB_HEARTBEAT_MS: 30_000
    }
  });
  mock.module('../src/services/productPublish.js', {
    exports: {
      planMlUnits: async () => {
        if (publishState.planMlThrows) throw publishState.planMlThrows;
        return publishState.mlUnits;
      },
      planTnUnits: () => {
        if (publishState.planTnThrows) throw publishState.planTnThrows;
        return publishState.tnUnits;
      },
      publishMlUnit: async (body) => {
        publishState.mlCallCount++;
        if (publishState.mlFailOnCall === publishState.mlCallCount) throw new Error('ML rechazó la 2ª unidad');
        if (publishState.mlThrows) throw publishState.mlThrows;
        return { externalId: `MLA${publishState.mlCallCount}`, detail: `Publicación MLA${publishState.mlCallCount} creada` };
      },
      publishTnUnit: async () => {
        if (publishState.tnThrows) throw publishState.tnThrows;
        return { externalId: 501, detail: 'Producto #501 creado' };
      }
    }
  });
  mock.module('../src/store.js', {
    exports: {
      getMlToken: async () => storeState.mlToken,
      tokens: storeState.tokens
    }
  });
  publishWorker = await import('../src/services/publishWorker.js');
});

beforeEach(() => {
  dbState.claimedJob = null;
  dbState.existingUnits = [];
  dbState.upserts = [];
  dbState.seeded = [];
  dbState.cancelledAfter = null;
  dbState.cancelCheckCalls = 0;
  dbState.finished = null;
  dbState.heartbeats = [];
  dbState.recomputed = null;
  dbState.hasDb = true;
  publishState.mlUnits = [{ unitKey: 'CUA-N', body: { a: 1 } }];
  publishState.tnUnits = [{ unitKey: 'CUA-N', body: { b: 1 }, uploadIds: [], forVariants: [] }];
  publishState.mlThrows = null;
  publishState.tnThrows = null;
  publishState.planMlThrows = null;
  publishState.planTnThrows = null;
  publishState.mlCallCount = 0;
  publishState.mlFailOnCall = null;
  storeState.mlToken = 'ml-tok';
  storeState.tokens.tiendanube = { access_token: 'tn-tok', store_id: '9' };
});

const baseJob = { id: 'j1', draftId: 'd1', channels: 'ml,tn', payloadJson: '{}' };

test('tick(): sin job encolado, no hace nada', async () => {
  dbState.claimedJob = null;
  await publishWorker.tick();
  assert.equal(dbState.finished, null);
});

test('processJob: ambos canales ok → registra cada unidad, termina el job "done" y recalcula el status del draft', async () => {
  await publishWorker.processJob(baseJob);
  assert.equal(dbState.upserts.length, 2);
  assert.ok(dbState.upserts.every((u) => u.status === 'ok'));
  const ml = dbState.upserts.find((u) => u.channel === 'ml');
  assert.equal(ml.externalId, 'MLA1');
  const tn = dbState.upserts.find((u) => u.channel === 'tn');
  assert.equal(tn.externalId, '501');
  assert.equal(dbState.finished.status, 'done');
  assert.equal(dbState.recomputed, 'd1');
});

test('processJob: siembra TODAS las unidades planificadas como "pending" antes de publicarlas (para el "X de Y" del front)', async () => {
  publishState.mlUnits = [
    { unitKey: 'CUA-N', body: { a: 1 } },
    { unitKey: 'CUA-R', body: { a: 2 } }
  ];
  publishState.tnUnits = [{ unitKey: '', body: { b: 1 }, uploadIds: [], forVariants: [] }];
  await publishWorker.processJob(baseJob);
  const mlSeed = dbState.seeded.find((s) => s.channel === 'ml');
  const tnSeed = dbState.seeded.find((s) => s.channel === 'tn');
  assert.deepEqual(mlSeed, { jobId: 'j1', channel: 'ml', unitKeys: ['CUA-N', 'CUA-R'] });
  assert.deepEqual(tnSeed, { jobId: 'j1', channel: 'tn', unitKeys: [''] });
});

test('processJob: si falla armando las unidades (planMlUnits) NO se siembra nada de ese canal', async () => {
  publishState.planMlThrows = new Error('categoría no es hoja');
  await publishWorker.processJob(baseJob);
  assert.equal(dbState.seeded.find((s) => s.channel === 'ml'), undefined);
});

test('processJob: si el job se cancela, el worker corta el fan-out entre unidad y unidad (lo ya creado queda)', async () => {
  publishState.mlUnits = [
    { unitKey: 'CUA-1', body: { a: 1 } },
    { unitKey: 'CUA-2', body: { a: 2 } },
    { unitKey: 'CUA-3', body: { a: 3 } }
  ];
  dbState.cancelledAfter = 2; // 1ª unidad pasa el chequeo, la 2ª lo encuentra cancelado
  await publishWorker.processJob({ ...baseJob, channels: 'ml' });
  const mlUpserts = dbState.upserts.filter((u) => u.channel === 'ml' && u.status === 'ok');
  assert.equal(mlUpserts.length, 1); // solo CUA-1 alcanzó a publicarse
  assert.equal(mlUpserts[0].unitKey, 'CUA-1');
});

test('processJob: job cancelado desde el arranque → no publica ninguna unidad', async () => {
  publishState.mlUnits = [{ unitKey: 'CUA-1', body: { a: 1 } }];
  dbState.cancelledAfter = 1;
  await publishWorker.processJob({ ...baseJob, channels: 'ml' });
  assert.equal(dbState.upserts.filter((u) => u.channel === 'ml').length, 0);
  assert.equal(publishState.mlCallCount, 0); // publishMlUnit nunca se llamó
});

test('processJob: channels=["tn"] NO toca ML (reintento de un solo canal)', async () => {
  await publishWorker.processJob({ ...baseJob, channels: 'tn' });
  assert.equal(dbState.upserts.length, 1);
  assert.equal(dbState.upserts[0].channel, 'tn');
});

test('processJob: SALTEA las unidades que ya están "ok" de un intento anterior (no las duplica)', async () => {
  dbState.existingUnits = [{ channel: 'ml', unitKey: 'CUA-N', status: 'ok', externalId: 'MLA1' }];
  publishState.mlUnits = [
    { unitKey: 'CUA-N', body: { a: 1 } }, // ya publicada
    { unitKey: 'CUA-R', body: { a: 2 } } // pendiente
  ];
  await publishWorker.processJob(baseJob);
  const mlUpserts = dbState.upserts.filter((u) => u.channel === 'ml');
  // Solo se registra (upsert) la unidad NUEVA — la ya-ok no se vuelve a crear ni a upsertear.
  assert.equal(mlUpserts.length, 1);
  assert.equal(mlUpserts[0].unitKey, 'CUA-R');
});

test('processJob: falla en la unidad 2 de 2 → la 1ª queda "ok" (con su external_id), la 2ª "error", el job termina "error"', async () => {
  publishState.mlUnits = [
    { unitKey: 'CUA-N', body: { a: 1 } },
    { unitKey: 'CUA-R', body: { a: 2 } }
  ];
  publishState.mlFailOnCall = 2;
  await publishWorker.processJob({ ...baseJob, channels: 'ml' });
  const mlUpserts = dbState.upserts.filter((u) => u.channel === 'ml').sort((a, b) => a.seq - b.seq);
  assert.equal(mlUpserts.length, 2);
  assert.equal(mlUpserts[0].status, 'ok');
  assert.equal(mlUpserts[0].externalId, 'MLA1');
  assert.equal(mlUpserts[1].status, 'error');
  assert.match(mlUpserts[1].detail, /rechazó la 2ª unidad/);
  assert.equal(dbState.finished.status, 'error');
});

test('reintento tras una falla parcial: la unidad ya "ok" NO se vuelve a publicar (no duplica)', async () => {
  // Simula el estado que dejó el test anterior: la 1ª unidad (CUA-N) ya quedó 'ok' en la DB.
  dbState.existingUnits = [{ channel: 'ml', unitKey: 'CUA-N', status: 'ok', externalId: 'MLA1' }];
  publishState.mlUnits = [
    { unitKey: 'CUA-N', body: { a: 1 } },
    { unitKey: 'CUA-R', body: { a: 2 } }
  ];
  await publishWorker.processJob({ ...baseJob, channels: 'ml' });
  const mlUpserts = dbState.upserts.filter((u) => u.channel === 'ml');
  assert.equal(mlUpserts.length, 1); // solo la pendiente (CUA-R) se publica de nuevo
  assert.equal(mlUpserts[0].unitKey, 'CUA-R');
  assert.equal(publishState.mlCallCount, 1); // publishMlUnit NUNCA se llamó para CUA-N
  assert.equal(dbState.finished.status, 'done');
});

test('processJob: ML sin token → una unidad de error con detalle explícito, no revienta el job', async () => {
  storeState.mlToken = null;
  await publishWorker.processJob(baseJob);
  const ml = dbState.upserts.find((u) => u.channel === 'ml');
  assert.equal(ml.status, 'error');
  assert.match(ml.detail, /No conectado a Mercado Libre/);
  assert.equal(dbState.finished.status, 'error');
  assert.match(dbState.finished.error, /ml:/);
});

test('processJob: TN sin token/store → error explícito, ML sigue publicando igual', async () => {
  storeState.tokens.tiendanube = null;
  await publishWorker.processJob(baseJob);
  const ml = dbState.upserts.find((u) => u.channel === 'ml');
  const tn = dbState.upserts.find((u) => u.channel === 'tn');
  assert.equal(ml.status, 'ok');
  assert.equal(tn.status, 'error');
  assert.match(tn.detail, /No conectado a Tienda Nube/);
  assert.equal(dbState.finished.status, 'error'); // falla parcial: el job general no es "done"
});

test('processJob: falla armando las unidades de ML (planMlUnits) → error registrado, TN no se ve afectado', async () => {
  publishState.planMlThrows = new Error('categoría inválida');
  await publishWorker.processJob(baseJob);
  const ml = dbState.upserts.find((u) => u.channel === 'ml');
  assert.equal(ml.status, 'error');
  assert.match(ml.detail, /categoría inválida/);
  const tn = dbState.upserts.find((u) => u.channel === 'tn');
  assert.equal(tn.status, 'ok');
});

test('processJob: si falla la unidad de ML, se registra el error y el job termina "error" (no revienta el worker)', async () => {
  publishState.mlThrows = new Error('ML rechazó el ítem');
  await publishWorker.processJob(baseJob);
  const ml = dbState.upserts.find((u) => u.channel === 'ml');
  assert.equal(ml.status, 'error');
  assert.match(ml.detail, /ML rechazó el ítem/);
  assert.equal(dbState.finished.status, 'error');
});

test('processJob: arma y limpia el latido sin dejar un interval colgado (no revienta con jobs rápidos)', async () => {
  await publishWorker.processJob(baseJob);
  await publishWorker.processJob(baseJob); // si el interval anterior no se limpió, esto lo revelaría
  assert.equal(dbState.finished.status, 'done');
});

test('startPublishWorker: sin base de datos, no arranca (no revienta)', () => {
  dbState.hasDb = false;
  publishWorker.startPublishWorker();
  publishWorker.stopPublishWorker();
});
