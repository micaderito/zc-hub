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
  seedPublishUnits,
  upsertPublishUnit,
  getPublishUnits,
  isPublishJobCancelled,
  recomputeDraftStatus,
  hasDatabase,
  PUBLISH_JOB_HEARTBEAT_MS
} from '../db.js';
import { planMlUnits, planTnUnits, publishMlUnit, publishTnUnit } from './productPublish.js';
import { reconcileStalePublishJobs } from '../db.js';
import { getMlToken, tokens } from '../store.js';

const POLL_INTERVAL_MS = 500;
/**
 * Techo de tiempo real que puede correr un job. Pasado esto, el latido deja de refrescar `locked_at`
 * para que `claimNextPublishJob` pueda recuperarlo por lock vencido en vez de quedar clavado en
 * `processing` para siempre (ej. un request a ML/TN colgado — que igual ya tiene timeout de red).
 */
const PUBLISH_JOB_MAX_RUNTIME_MS = 15 * 60 * 1000;
/** Cada cuántos ticks se corre el barrido de jobs trabados (500ms * 20 = 10 s). */
const STALE_SWEEP_EVERY_TICKS = 20;
/** Reintentos del `finishPublishJob` final: sin esto, un hipo de la base deja el job abierto. */
const FINISH_RETRIES = 2;
const FINISH_RETRY_DELAY_MS = 1000;
let workerTimer = null;
let tickCount = 0;

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
    // La usuaria puede cancelar el job desde la UI mientras el fan-out corre: cortamos entre unidad
    // y unidad (no se puede interrumpir un POST a mitad). Lo ya creado queda; el resto no se toca.
    if (await isPublishJobCancelled(job.id)) {
      return { channel, status: 'cancelled', detail: `cancelado (${created.length} creadas antes)` };
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
  await seedPublishUnits(job.id, 'ml', units.map((u) => u.unitKey));
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
  await seedPublishUnits(job.id, 'tn', units.map((u) => u.unitKey));
  return runChannel('tn', job, payload, units, doneKeys, (unit) => publishTnUnit(tnToken, storeId, unit));
}

/**
 * Cierra el job reintentando si el UPDATE no tocó ninguna fila. Ese `false` es ESPERADO cuando la
 * usuaria canceló (`finishPublishJob` no revive un job `cancelled`) — ahí no se reintenta. En
 * cualquier otro caso significa que la escritura falló, y sin reintento el job se quedaba en
 * `processing` con todas sus unidades ya publicadas: el panel girando hasta que venciera el lock.
 */
async function finishWithRetry(jobId, status, errorMsg) {
  for (let attempt = 0; attempt <= FINISH_RETRIES; attempt++) {
    if (await finishPublishJob(jobId, status, errorMsg)) return true;
    if (await isPublishJobCancelled(jobId)) return false; // cancelado: no hay nada que cerrar
    if (attempt < FINISH_RETRIES) {
      console.warn(`[PublishQueue] finishPublishJob ${jobId} no actualizó nada — reintento ${attempt + 1}/${FINISH_RETRIES}.`);
      await new Promise((r) => setTimeout(r, FINISH_RETRY_DELAY_MS));
    }
  }
  return false;
}

/** Procesa un job completo: ambos canales en paralelo (igual que publishProduct), con latido. */
export async function processJob(job) {
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    // Techo: pasado el máximo dejamos de refrescar el lock, así un job realmente colgado vuelve a
    // ser reclamable en vez de quedar en `processing` para siempre.
    if (Date.now() - startedAt > PUBLISH_JOB_MAX_RUNTIME_MS) {
      console.warn(`[PublishQueue] Job ${job.id} superó el máximo de runtime — dejo de refrescar el lock.`);
      return;
    }
    touchPublishJobLock(job.id).catch((e) => console.error('[PublishQueue] touchPublishJobLock:', e.message));
  }, PUBLISH_JOB_HEARTBEAT_MS);
  heartbeat.unref?.();

  console.log(`[PublishQueue] Job ${job.id} arrancó (draft ${job.draftId}, canales ${job.channels}).`);
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
    const finalStatus = allOk ? 'done' : 'error';
    const finished = await finishWithRetry(job.id, finalStatus, allOk ? null : errorSummary);
    console.log(
      `[PublishQueue] Job ${job.id} → ${finalStatus} en ${Math.round((Date.now() - startedAt) / 1000)}s ` +
        `(${attempted.map((r) => `${r.channel}:${r.status}`).join(' ')})${finished ? '' : ' — ⚠️ finishPublishJob no actualizó la fila'}`
    );
    await recomputeDraftStatus(job.draftId);
  } catch (e) {
    console.error(`[PublishQueue] Job ${job.id} falló inesperadamente:`, e.message);
    await finishWithRetry(job.id, 'error', e.message);
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
  // Red de seguridad periódica: cierra jobs cuyas unidades ya están todas en estado terminal pero
  // el job quedó en processing (worker que se cortó justo en el finish), y saca de la cola los
  // zombis (processing con attempts >= 5). Va FUERA del try de arriba a propósito: si
  // `claimNextPublishJob` tira, el barrido igual tiene que correr — es justo el que destraba.
  if (++tickCount % STALE_SWEEP_EVERY_TICKS === 0) {
    const fixed = await reconcileStalePublishJobs().catch((e) => {
      console.error('[PublishQueue] reconcileStalePublishJobs:', e.message);
      return 0;
    });
    if (fixed) console.log(`[PublishQueue] Barrido de trabados: ${fixed} job(s) cerrados.`);
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
