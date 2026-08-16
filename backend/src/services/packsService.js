/**
 * Packs: la unidad de compra al proveedor (fase 5, ver CLAUDE.md). Un pack agrupa SKUs que se
 * compran juntos -surtido (la mezcla la arma el proveedor) o de un modelo por pack- y vive en
 * Productos → Packs, no en Alertas: es una propiedad del catálogo. La alerta sigue siendo siempre
 * por producto; acá solo se cruza el pack con el stock de hoy para mostrarlo.
 */

import { listPacks, upsertPack, deletePack, setSkuPack, getAnalysisSnapshot } from '../db.js';
import { buildStockBySku, effectiveStock } from './alertsService.js';

/** Map<sku, {label, thumbnail}> a partir de las filas crudas del snapshot (título ML o TN). */
function buildSkuInfoIndex(snapshotData) {
  const map = new Map();
  const setIfAbsent = (sku, info) => { if (sku && !map.has(sku)) map.set(sku, info); };
  for (const r of snapshotData?.mlRows || []) {
    setIfAbsent(r.sku, { label: r.variationName ? `${r.title} (${r.variationName})` : r.title, thumbnail: r.thumbnail || null });
  }
  for (const r of snapshotData?.tnRows || []) {
    setIfAbsent(r.sku, { label: r.variantName ? `${r.productName} (${r.variantName})` : r.productName, thumbnail: r.thumbnail || null });
  }
  return map;
}

/** Todos los packs con sus productos: título, stock ML/TN y stock efectivo de cada SKU. */
export async function listPacksWithStock() {
  const [packs, snap] = await Promise.all([listPacks(), getAnalysisSnapshot()]);
  const stockBySku = buildStockBySku(snap?.data);
  const infoBySku = buildSkuInfoIndex(snap?.data);
  return packs.map((pack) => ({
    id: pack.id,
    name: pack.name,
    sku: pack.sku ?? null,
    unitCount: pack.unitCount,
    mode: pack.mode,
    products: pack.skus.map((sku) => {
      const entry = stockBySku.get(sku);
      const info = infoBySku.get(sku);
      return {
        sku,
        label: info?.label || sku,
        thumbnail: info?.thumbnail || null,
        stockMl: entry?.ml ?? null,
        stockTn: entry?.tn ?? null,
        stockEffective: effectiveStock(entry),
      };
    }),
  }));
}

export async function savePack(data) {
  return upsertPack(data);
}

export async function removePack(id) {
  return deletePack(id);
}

export async function assignSkuPack(sku, packId) {
  return setSkuPack(sku, packId);
}
