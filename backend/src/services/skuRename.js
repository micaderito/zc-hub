/**
 * Detección de cambios de SKU a partir de la foto del catálogo.
 *
 * El SKU es lo que une todo en el hub (costo, código del proveedor, alerta, pack, depósito,
 * historial…). Cuando se le cambia el SKU a una variante, todo eso tiene que pasar al SKU nuevo o
 * queda huérfano. En vez de acordarse de hacerlo en cada ruta que cambia un SKU (Vincular SKUs,
 * Publicaciones, Editar publicación, la Cola ML, el panel de ML/TN), se detecta en el único lugar
 * por donde pasan todos: cuando se guarda la foto (`storeSnapshot` en conflictsService.js).
 *
 * Regla: la misma fila (misma variación de ML / variante de TN) pasa de A a B, y A ya no la usa
 * NINGUNA fila de ningún canal. Si TN sigue con A porque solo se cambió ML, todavía no se mueve
 * nada (A sigue en uso, no es huérfano): se mueve cuando cambie la otra punta.
 */

const norm = (s) => {
  const t = typeof s === 'string' ? s.trim() : '';
  return t || null;
};

/** Clave estable de una fila de la foto, independiente del SKU. */
export function mlRowKey(r) {
  return `ml:${r.itemId}:${r.variationId ?? ''}`;
}
export function tnRowKey(r) {
  return `tn:${r.productId}:${r.variantId ?? ''}`;
}

/** Clave de fila → SKU de cada fila de la foto. */
export function skuIndex(data) {
  const idx = new Map();
  if (!data) return idx;
  for (const r of data.mlRows || []) idx.set(mlRowKey(r), norm(r.sku));
  for (const r of data.tnRows || []) idx.set(tnRowKey(r), norm(r.sku));
  return idx;
}

/**
 * Renombres a aplicar entre la foto anterior (`prevIndex`, de `skuIndex`) y la nueva.
 *
 * @returns {{ renames: { from: string, to: string }[], skipped: { from: string, reason: string, to?: string[] }[] }}
 *   `skipped` es solo para loguear: A sigue en uso (`in_use`) o se partió en varios SKUs (`ambiguous`).
 */
export function detectSkuRenames(prevIndex, nextData) {
  const renames = [];
  const skipped = [];
  if (!prevIndex || !prevIndex.size || !nextData) return { renames, skipped };

  const nextIdx = skuIndex(nextData);
  const inUse = new Set([...nextIdx.values()].filter(Boolean));
  /** A → Set de B */
  const candidates = new Map();
  for (const [key, next] of nextIdx) {
    if (!prevIndex.has(key)) continue; // fila nueva: no es un renombre
    const prev = prevIndex.get(key);
    if (!prev || !next || prev === next) continue; // sin SKU antes, vaciado, o igual
    if (!candidates.has(prev)) candidates.set(prev, new Set());
    candidates.get(prev).add(next);
  }

  for (const [from, tos] of candidates) {
    if (inUse.has(from)) {
      skipped.push({ from, reason: 'in_use', to: [...tos] });
      continue;
    }
    if (tos.size > 1) {
      skipped.push({ from, reason: 'ambiguous', to: [...tos] });
      continue;
    }
    renames.push({ from, to: [...tos][0] });
  }
  return { renames, skipped };
}
