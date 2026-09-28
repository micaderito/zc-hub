/**
 * Alta de la alerta de stock configurada en "Crear producto" (sección "Alerta de stock").
 *
 * Viaja en el payload del job (`payload.alert`) y la aplica el publish worker cuando el job
 * termina con AL MENOS una unidad publicada: si no se creó nada en ningún canal, el SKU no existe y
 * la regla quedaría vigilando la nada. Es idempotente —`upsertStockAlert` pisa el umbral, el pack
 * nuevo se busca por nombre antes de crearlo y `setSkuPack` es un upsert—, así que un reintento del
 * mismo job o de un solo canal no duplica nada.
 *
 * Forma de `payload.alert`:
 *   { threshold: number,
 *     skus: [{ sku, label }],
 *     pack: null | { id: number } | { name, unitCount, mode, sku } }
 */
import { upsertStockAlert, listPacks, upsertPack, setSkuPack } from '../db.js';
import { evaluateStockAlertsNow } from './alertsService.js';

/** Normaliza lo que viene del front; `null` si no hay alerta que dar de alta. */
export function normalizePublishAlert(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const threshold = Number(raw.threshold);
  if (!Number.isFinite(threshold) || threshold < 0) return null;
  const seen = new Set();
  const skus = (Array.isArray(raw.skus) ? raw.skus : [])
    .map((s) => ({ sku: String(s?.sku ?? '').trim(), label: s?.label ? String(s.label).trim() : null }))
    .filter((s) => s.sku && !seen.has(s.sku) && seen.add(s.sku));
  if (!skus.length) return null;

  let pack = null;
  const p = raw.pack;
  if (p && Number.isFinite(Number(p.id)) && Number(p.id) > 0) {
    pack = { id: Number(p.id) };
  } else if (p && String(p.name ?? '').trim()) {
    pack = {
      name: String(p.name).trim(),
      unitCount: Math.max(1, Math.floor(Number(p.unitCount)) || 1),
      mode: p.mode === 'single' ? 'single' : 'assorted',
      sku: p.sku && String(p.sku).trim() ? String(p.sku).trim() : null,
    };
  }
  return { threshold: Math.floor(threshold), skus, pack };
}

/**
 * Resuelve el id del pack: el existente elegido, o uno nuevo. El nuevo se busca primero por nombre
 * (sin distinguir mayúsculas) para que reintentar el job no cree un pack duplicado.
 */
async function resolvePackId(pack) {
  if (!pack) return null;
  if (pack.id) return pack.id;
  const existing = (await listPacks()).find((x) => x.name.trim().toLowerCase() === pack.name.toLowerCase());
  if (existing) return existing.id;
  return upsertPack(pack);
}

/**
 * Da de alta la regla (y el pack, si se pidió) para cada SKU. Devuelve un resumen para el log.
 * No tira: un fallo acá no puede cambiar el resultado de una publicación que ya se hizo.
 */
export async function applyPublishAlert(rawAlert) {
  const alert = normalizePublishAlert(rawAlert);
  if (!alert) return { applied: false };
  try {
    const packId = await resolvePackId(alert.pack);
    let rules = 0;
    for (const { sku, label } of alert.skus) {
      if (packId) await setSkuPack(sku, packId);
      if (await upsertStockAlert(sku, { threshold: alert.threshold, productLabel: label })) rules++;
    }
    // Igual que el PUT de Alertas: si ya arranca bajo el umbral, que dispare en la primera pasada.
    await evaluateStockAlertsNow().catch((e) => console.error('[PublishAlert] evaluateStockAlertsNow:', e.message));
    return { applied: true, rules, packId };
  } catch (e) {
    console.error('[PublishAlert] No se pudo dar de alta la alerta:', e.message);
    return { applied: false, error: e.message };
  }
}
