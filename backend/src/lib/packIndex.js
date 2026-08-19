/**
 * Índice SKU → pack, compartido entre alertsService.js (Para reponer) y pricingService.js
 * (agrupar la planilla de precios por pack). PURO: sin I/O, sin red — entra el resultado de
 * listPacks() y sale un Map listo para lookup por SKU.
 */

/** Map<sku, {packId, name, sku, unitCount, mode, modelCount}> a partir de listPacks(). `modelCount` es el total de modelos del pack (no solo un subconjunto). */
export function buildSkuPackIndex(packs) {
  const map = new Map();
  for (const pack of packs || []) {
    const modelCount = (pack.skus || []).length;
    for (const memberSku of pack.skus || []) {
      map.set(memberSku, { packId: pack.id, name: pack.name, sku: pack.sku ?? null, unitCount: pack.unitCount, mode: pack.mode, modelCount });
    }
  }
  return map;
}
