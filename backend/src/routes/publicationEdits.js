/**
 * Ediciones de publicaciones existentes (Publicaciones → Editar publicación). Ver
 * services/publicationImport.js (importar), services/publicationDiff.js (qué cambió) y
 * docs/plans/2026-10-12-publicaciones-mapeo-edicion-design.md.
 *
 * Una edición guarda el borrador a medio terminar para retomarlo después; no es una copia de las
 * publicaciones: se importa en vivo al abrirla y se descarta (o se cierra) al terminar.
 */
import { Router } from 'express';
import crypto from 'crypto';
import {
  getActivePublicationEdit,
  getPublicationEdit,
  createPublicationEdit,
  updatePublicationEditDraft,
  setPublicationEditStatus,
  createPublishJob,
  getPublishJob,
} from '../db.js';
import { importHubProduct, checkRemoteChanges } from '../services/publicationImport.js';
import { planPublicationUpdate, summarizeOps } from '../services/publicationDiff.js';

export const publicationEditsRoutes = Router();

/** Lo que ve el front de una edición (sin el baseline, que solo usa el backend para comparar). */
function toResponse(edit) {
  const { baseline, refs, ...rest } = edit;
  const { locks = {}, notes = [], ...publicRefs } = refs || {};
  return { ...rest, refs: publicRefs, locks, notes };
}

/** Las operaciones de un job de guardado, sin los payloads (para mostrar el progreso al retomar). */
const opsForDisplay = (ops) => (ops || []).map(({ key, channel, target, targetLabel, kind, label, warn }) => ({ key, channel, target, targetLabel, kind, label, warn }));

/** La edición + el job que la está guardando (si hay), para retomar el progreso al volver a la pantalla. */
async function withJob(edit) {
  const out = toResponse(edit);
  if (!edit.jobId) return out;
  const job = await getPublishJob(edit.jobId);
  if (!job) return out;
  let ops = [];
  try { ops = opsForDisplay(JSON.parse(job.payloadJson).ops); } catch { /* payload ilegible: sin detalle */ }
  return { ...out, job: { id: job.id, status: job.status, lastError: job.lastError }, jobOps: ops };
}

/**
 * Abre la edición de un producto del hub. Body: { groupKey }. Si ya hay una abierta la devuelve
 * (`resumed: true`) para retomarla; si no, importa en vivo de ML/TN y la crea.
 */
publicationEditsRoutes.post('/', async (req, res) => {
  const groupKey = String(req.body?.groupKey || '').trim();
  if (!groupKey) return res.status(400).json({ error: 'Falta el producto (groupKey)' });
  try {
    const existing = await getActivePublicationEdit(groupKey);
    if (existing) return res.json({ ...(await withJob(existing)), resumed: true });

    const imported = await importHubProduct(groupKey);
    const edit = await createPublicationEdit({
      id: crypto.randomBytes(12).toString('hex'),
      groupKey,
      name: imported.draft.common.baseName,
      draft: imported.draft,
      baseline: imported.baseline,
      refs: { ...imported.refs, locks: imported.locks, notes: imported.notes },
      createdBy: req.user?.username,
    });
    if (!edit) return res.status(500).json({ error: 'No se pudo guardar la edición. Revisá la conexión con la base de datos.' });
    res.status(201).json({ ...toResponse(edit), resumed: false });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

publicationEditsRoutes.get('/:id', async (req, res) => {
  const edit = await getPublicationEdit(req.params.id);
  if (!edit) return res.status(404).json({ error: 'Edición no encontrada' });
  res.json(await withJob(edit));
});

/**
 * Guardar: aplica los cambios en ML y TN en segundo plano (job `kind: 'update'` del publish
 * worker, ver publicationUpdate.js). Body: { draft?, force? }. Con `draft` primero guarda lo que
 * está en pantalla. Sin `force`, si alguien cambió la publicación en el canal desde que se abrió la
 * edición responde 409 `remote_changed` con la lista, para que la usuaria decida.
 */
publicationEditsRoutes.post('/:id/apply', async (req, res) => {
  const edit = await getPublicationEdit(req.params.id);
  if (!edit) return res.status(404).json({ error: 'Edición no encontrada' });
  if (edit.status !== 'editing') return res.status(409).json({ error: 'Esta edición ya se está guardando o se cerró.' });
  let draft = edit.draft;
  if (req.body?.draft && typeof req.body.draft === 'object') {
    draft = req.body.draft;
    await updatePublicationEditDraft(edit.id, draft);
  }
  const ops = planPublicationUpdate(edit.baseline, draft, edit.refs);
  if (!ops.length) return res.status(400).json({ error: 'No hay cambios para guardar.' });
  if (!req.body?.force) {
    const changed = await checkRemoteChanges(edit.refs).catch(() => []);
    if (changed.length) {
      return res.status(409).json({ code: 'remote_changed', changed, error: 'La publicación cambió en el canal desde que empezaste a editar.' });
    }
  }
  const jobId = crypto.randomBytes(12).toString('hex');
  const channels = [...new Set(ops.map((o) => o.channel))].join(',');
  const created = await createPublishJob({
    id: jobId,
    channels,
    kind: 'update',
    editId: edit.id,
    productName: draft?.common?.baseName || edit.name,
    payloadJson: JSON.stringify({ kind: 'update', editId: edit.id, ops, draft, refs: edit.refs }),
  });
  if (!created) return res.status(500).json({ error: 'No se pudo encolar el guardado. Revisá la conexión con la base de datos.' });
  await setPublicationEditStatus(edit.id, 'saving', { jobId });
  res.status(202).json({ jobId, ops: opsForDisplay(ops) });
});

/**
 * Cierra una edición que ya se guardó (con o sin errores): la próxima vez que se abra el producto
 * se vuelve a importar de ML/TN. 409 si el guardado todavía está corriendo.
 */
publicationEditsRoutes.post('/:id/close', async (req, res) => {
  const edit = await getPublicationEdit(req.params.id);
  if (!edit) return res.status(404).json({ error: 'Edición no encontrada' });
  if (edit.jobId) {
    const job = await getPublishJob(edit.jobId);
    if (job && (job.status === 'pending' || job.status === 'processing')) {
      return res.status(409).json({ error: 'Todavía se están guardando los cambios: esperá a que termine.' });
    }
  }
  await setPublicationEditStatus(edit.id, 'done');
  res.json({ ok: true });
});

/** Autoguardado. Body: { draft }. 409 si la edición ya se está guardando o se cerró. */
publicationEditsRoutes.put('/:id', async (req, res) => {
  const draft = req.body?.draft;
  if (!draft || typeof draft !== 'object') return res.status(400).json({ error: 'Falta "draft"' });
  const ok = await updatePublicationEditDraft(req.params.id, draft);
  if (ok) return res.json({ ok: true });
  const edit = await getPublicationEdit(req.params.id);
  if (!edit) return res.status(404).json({ error: 'Edición no encontrada' });
  res.status(409).json({ error: 'Esta edición ya se está guardando o se cerró: no se puede seguir editando.' });
});

/** Descarta la edición: no toca nada en ML ni TN. */
publicationEditsRoutes.delete('/:id', async (req, res) => {
  const edit = await getPublicationEdit(req.params.id);
  if (!edit) return res.status(404).json({ error: 'Edición no encontrada' });
  if (edit.status === 'saving') return res.status(409).json({ error: 'Esta edición se está guardando: esperá a que termine.' });
  await setPublicationEditStatus(req.params.id, 'discarded');
  res.json({ ok: true });
});

/**
 * Qué se mandaría a cada canal si se guardara ahora. Body opcional: { draft } (el borrador que está
 * en pantalla, aunque el autoguardado todavía no lo haya persistido); sin body usa el guardado.
 */
publicationEditsRoutes.post('/:id/plan', async (req, res) => {
  const edit = await getPublicationEdit(req.params.id);
  if (!edit) return res.status(404).json({ error: 'Edición no encontrada' });
  const draft = req.body?.draft && typeof req.body.draft === 'object' ? req.body.draft : edit.draft;
  try {
    const ops = planPublicationUpdate(edit.baseline, draft, edit.refs);
    res.json({ ops, summary: summarizeOps(ops) });
  } catch (e) {
    res.status(400).json({ error: `No se pudo calcular qué cambió: ${e.message}` });
  }
});

/** ¿Alguien cambió las publicaciones en ML/TN desde que se abrió la edición? */
publicationEditsRoutes.get('/:id/remote-check', async (req, res) => {
  const edit = await getPublicationEdit(req.params.id);
  if (!edit) return res.status(404).json({ error: 'Edición no encontrada' });
  try {
    res.json({ changed: await checkRemoteChanges(edit.refs) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});
