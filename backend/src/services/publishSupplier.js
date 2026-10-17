/**
 * Proveedor, config de descuento y costo elegidos en "Crear producto" (sección "Precios y
 * ganancia"). Viaja en el payload del job (`payload.supplier`) y lo aplica el publish worker cuando
 * el job termina con AL MENOS una unidad publicada, igual que la alerta (publishAlert.js) — y
 * después de ella, porque la alerta puede crear el pack al que se asigna el proveedor.
 *
 * Forma de `payload.supplier`:
 *   { skus: string[], supplierKey: string|null, profileId: number|null, label?: string,
 *     suppliers?: [{ supplierKey, profileId }],   // todos a los que se le compra (supplierKey = vigente)
 *     cost: null | { mode: 'bulk'|'unit', bulkPrice, bulkQty, unitCost, marginPct } }
 * Un borrador viejo trae solo `supplierKey` (un proveedor): se aplica como antes.
 *
 * Idempotente (todo upsert en setProductSupplier): reintentar el job lo vuelve a aplicar igual.
 */
import { setProductSupplier } from './pricingService.js';

/** Normaliza lo que viene del front; `null` si no hay nada que guardar. */
export function normalizePublishSupplier(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const skus = [...new Set((Array.isArray(raw.skus) ? raw.skus : []).map((s) => String(s ?? '').trim()).filter(Boolean))];
  if (!skus.length) return null;
  const supplierKey = raw.supplierKey ? String(raw.supplierKey) : null;
  const profileId = raw.profileId != null && Number.isInteger(Number(raw.profileId)) ? Number(raw.profileId) : null;
  const c = raw.cost;
  const cost = c && typeof c === 'object'
    ? { mode: c.mode === 'unit' ? 'unit' : 'bulk', bulkPrice: c.bulkPrice ?? null, bulkQty: c.bulkQty ?? null, unitCost: c.unitCost ?? null, marginPct: c.marginPct ?? null }
    : null;
  if (!supplierKey && !cost) return null;
  const out = { skus, supplierKey, profileId, cost, label: raw.label ? String(raw.label).trim() : null };
  if (Array.isArray(raw.suppliers)) {
    out.suppliers = raw.suppliers
      .filter((x) => x && x.supplierKey)
      .map((x) => ({
        supplierKey: String(x.supplierKey),
        profileId: x.profileId != null && Number.isInteger(Number(x.profileId)) ? Number(x.profileId) : null,
      }));
  }
  return out;
}

/** No tira: un fallo acá no puede cambiar el resultado de una publicación que ya se hizo. */
export async function applyPublishSupplier(raw, { packId = null } = {}) {
  const input = normalizePublishSupplier(raw);
  if (!input) return { applied: false };
  try {
    const res = await setProductSupplier({ ...input, packId });
    return { applied: true, targets: res.targets, changedSkus: res.changedSkus };
  } catch (e) {
    console.error('[PublishSupplier] No se pudo guardar el proveedor:', e.message);
    return { applied: false, error: e.message };
  }
}
