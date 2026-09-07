/**
 * Worker de publicación de productos en background (product_publish_jobs / product_publish_units).
 *
 * Mismo patrón que backend/src/lib/mlTaskQueue.js (FOR UPDATE SKIP LOCKED + latido + lock que
 * vence — ver claimNextPublishJob en db.js), pero NO reusa esa cola: su `idempotency_key` hace
 * coalescing con `DO UPDATE`, que para una CREACIÓN significaría pisar una publicación encolada
 * con otra en vez de encolar las dos.
 *
 * Idempotencia del reintento: cada unidad publicada (un ítem ML, un producto TN) se registra en
 * `product_publish_units` apenas se confirma. Reintentar re-encola el MISMO job (mismo
 * `payload_json`, inmutable) y el worker SALTEA las unidades que ya están 'ok' — así fallar en la
 * unidad 3 de 5 y reintentar no vuelve a crear las 2 primeras (el bug de hoy: el reintento síncrono
 * no tenía memoria de lo ya creado).
 */
import {
  claimNextPublishJob,
  touchPublishJobLock,
  finishPublishJob,
  upsertPublishUnit,
  getPublishUnits,
  recomputeDraftStatus,
  hasDatabase,
  PUBLISH_JOB_HEARTBEAT_MS
} from '../db.js';
import { planMlUnits, planTnUnits, publishMlUnit, publishTnUnit } from './productPublish.js';
import { getMlToken, tokens } from '../store.js';

const POLL_INTERVAL_MS = 500;
let workerTimer = null;

/**
 * Publica las unidades pendientes de UN canal para un job, registrando cada una apenas se
 * confirma. Corta en el primer error (igual que el publish síncrono) — las unidades ya publicadas
 * antes de ese punto quedan 'ok' y no se repiten en el próximo reintento.
 */
async function runChannel(channel, job, payload, units, doneKeys, describe) {
  const created = [];
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    if (doneKeys.has(unit.unitKey)) {
      created.push(unit.unitKey); // ya estaba 'ok' de un intento anterior: se saltea, no se duplica
      continue;
    }
    try {
      const { externalId, detail } = await describe(unit);
      await upsertPublishUnit({
        jobId: job.id,
        channel,
        unitKey: unit.unitKey,
        seq: i,
        status: 'ok',
        externalId: externalId != null ? String(externalId) : null,
        detail
      });
      created.push(externalId);
    } catch (e) {
      await upsertPublishUnit({ jobId: job.id, channel, unitKey: unit.unitKey, seq: i, status: 'error', detail: e.message });
      const partial = created.length ? ` (se crearon ${created.length} antes del error)` : '';
      return { channel, status: 'error', detail: `${e.message}${partial}` };
    }
  }
  const label = created.length > 1 ? `${created.length} publicaciones creadas` : `Publicación ${created[0]} creada`;
  return { channel, status: 'ok', detail: label };
}

async function runMlChannel(job, payload, doneKeys) {
  const mlToken = await getMlToken();
  if (!mlToken) {
    await upsertPublishUnit({ jobId: job.id, channel: 'ml', unitKey: '', seq: 0, status: 'error', detail: 'No conectado a Mercado Libre' });
    return { channel: 'ml', status: 'error', detail: 'No conectado a Mercado Libre' };
  }
  let units;
  try {
    units = await planMlUnits(payload, mlToken);
  } catch (e) {
    await upsertPublishUnit({ jobId: job.id, channel: 'ml', unitKey: '', seq: 0, status: 'error', detail: e.message });
    return { channel: 'ml', status: 'error', detail: e.message };
  }
  const descriptionText = payload.ml?.description?.plain_text || '';
  return runChannel('ml', job, payload, units, doneKeys, (unit) => publishMlUnit(unit.body, mlToken, descriptionText));
}

async function runTnChannel(job, payload, doneKeys) {
  const tnToken = tokens.tiendanube?.access_token || null;
  const storeId = tokens.tiendanube?.store_id || null;
  if (!tnToken || !storeId) {
    await upsertPublishUnit({ jobId: job.id, channel: 'tn', unitKey: '', seq: 0, status: 'error', detail: 'No conectado a Tienda Nube' });
    return { channel: 'tn', status: 'error', detail: 'No conectado a Tienda Nube' };
  }
  let units;
  try {
    units = planTnUnits(payload);
  } catch (e) {
    await upsertPublishUnit({ jobId: job.id, channel: 'tn', unitKey: '', seq: 0, status: 'error', detail: e.message });
    return { channel: 'tn', status: 'error', detail: e.message };
  }
  return runChannel('tn', job, payload, units, doneKeys, (unit) => publishTnUnit(tnToken, storeId, unit));
}

/** Procesa un job completo: ambos canales en paralelo (igual que publishProduct), con latido. */
export async function processJob(job) {
  const heartbeat = setInterval(() => {
    touchPublishJobLock(job.id).catch((e) => console.error('[PublishQueue] touchPublishJobLock:', e.message));
  }, PUBLISH_JOB_HEARTBEAT_MS);
  heartbeat.unref?.();

  try {
    const payload = JSON.parse(job.payloadJson);
    const channels = String(job.channels).split(',').map((s) => s.trim());
    const existingUnits = await getPublishUnits(job.id);
    const doneKeysFor = (channel) => new Set(existingUnits.filter((u) => u.channel === channel && u.status === 'ok').map((u) => u.unitKey));

    const results = await Promise.all([
      channels.includes('ml') ? runMlChannel(job, payload, doneKeysFor('ml')) : null,
      channels.includes('tn') ? runTnChannel(job, payload, doneKeysFor('tn')) : null
    ]);
    const attempted = results.filter(Boolean);
    const allOk = attempted.every((r) => r.status === 'ok');
    const errorSummary = attempted
      .filter((r) => r.status === 'error')
      .map((r) => `${r.channel}: ${r.detail}`)
      .join(' · ');
    await finishPublishJob(job.id, allOk ? 'done' : 'error', allOk ? null : errorSummary);
    await recomputeDraftStatus(job.draftId);
  } catch (e) {
    console.error(`[PublishQueue] Job ${job.id} falló inesperadamente:`, e.message);
    await finishPublishJob(job.id, 'error', e.message);
    await recomputeDraftStatus(job.draftId).catch(() => {});
  } finally {
    clearInterval(heartbeat);
  }
}

export async function tick() {
  try {
    const job = await claimNextPublishJob();
    if (job) await processJob(job);
  } catch (e) {
    console.error('[PublishQueue] Error en tick:', e.message);
  }
}

export function startPublishWorker() {
  if (!hasDatabase()) {
    console.log('[PublishQueue] Sin base de datos — worker desactivado.');
    return;
  }
  if (workerTimer) return;
  workerTimer = setInterval(tick, POLL_INTERVAL_MS);
  console.log('[PublishQueue] Worker de publicación iniciado (polling cada 500ms).');
}

export function stopPublishWorker() {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
    console.log('[PublishQueue] Worker de publicación detenido.');
  }
}
