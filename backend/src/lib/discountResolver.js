/**
 * Qué descuento se aplica a cada SKU y a qué proveedores pertenece — PURO (sin DB), testeable.
 *
 * Cada proveedor tiene sus configuraciones de descuento (una default). La que vale para un SKU se
 * busca para su proveedor VIGENTE (`product_costs.supplier_key`), en este orden:
 *
 *   1. la config propia del SKU            (product_suppliers, target 'sku')
 *   2. la config del pack al que pertenece (product_suppliers, target 'pack')
 *   3. la default del proveedor
 *   4. sin proveedor vigente: sin descuento
 *
 * Se resuelve en vivo al calcular, no se copia al costo: editar una config mueve los precios de
 * todo lo que la usa (y la planilla lo marca "pendiente de aplicar").
 */

const NONE = Object.freeze({ profileId: null, name: null, discount1: 0, discount2: 0, level: 'none' });

/**
 * @param {object} data
 * @param {Array<{ key, name, profiles: Array<{ id, name, discount1, discount2, isDefault }> }>} data.suppliers
 * @param {Array<{ type: 'sku'|'pack', id: string, supplierKey: string, profileId: number|null }>} data.assignments
 * @param {Array<{ id: number, skus: string[] }>} data.packs
 * @param {Array<{ sku, supplier }>} [data.skuCodeMap] mapeos SKU→código de todos los proveedores
 * @param {Array<{ packId, supplier }>} [data.packCodeMap]
 * @param {Array<{ sku, supplierKey }>} [data.costs]
 */
export function buildDiscountContext({ suppliers = [], assignments = [], packs = [], skuCodeMap = [], packCodeMap = [], costs = [] } = {}) {
  const profilesById = new Map();
  const defaultBySupplier = new Map();
  const supplierNames = new Map();
  for (const s of suppliers) {
    supplierNames.set(s.key, s.name);
    for (const pr of s.profiles || []) {
      profilesById.set(pr.id, { ...pr, supplierKey: s.key });
      if (pr.isDefault) defaultBySupplier.set(s.key, pr.id);
    }
  }
  const packIdBySku = new Map();
  const skusByPack = new Map();
  for (const pk of packs) {
    skusByPack.set(String(pk.id), pk.skus || []);
    for (const sku of pk.skus || []) packIdBySku.set(sku, String(pk.id));
  }
  const skuProfile = new Map();
  const packProfile = new Map();
  const suppliersBySku = new Map();
  const addSupplier = (sku, key) => {
    if (!sku || !key) return;
    if (!suppliersBySku.has(sku)) suppliersBySku.set(sku, new Set());
    suppliersBySku.get(sku).add(key);
  };
  const addToPack = (packId, key) => { for (const sku of skusByPack.get(String(packId)) || []) addSupplier(sku, key); };

  for (const a of assignments) {
    const k = `${a.supplierKey}|${a.id}`;
    if (a.type === 'pack') {
      if (a.profileId != null) packProfile.set(k, a.profileId);
      addToPack(a.id, a.supplierKey);
    } else {
      if (a.profileId != null) skuProfile.set(k, a.profileId);
      addSupplier(a.id, a.supplierKey);
    }
  }
  for (const m of skuCodeMap) addSupplier(m.sku, m.supplier);
  for (const m of packCodeMap) addToPack(m.packId, m.supplier);
  const vigenteBySku = new Map();
  for (const c of costs) {
    if (c.supplierKey) { vigenteBySku.set(c.sku, c.supplierKey); addSupplier(c.sku, c.supplierKey); }
  }

  return { profilesById, defaultBySupplier, supplierNames, packIdBySku, skuProfile, packProfile, suppliersBySku, vigenteBySku };
}

function described(profile, level) {
  return {
    profileId: profile.id,
    name: profile.name,
    discount1: Number(profile.discount1) || 0,
    discount2: Number(profile.discount2) || 0,
    level,
  };
}

/**
 * Descuento de un SKU para un proveedor (por default, su vigente).
 * @returns {{ profileId, name, discount1, discount2, level: 'sku'|'pack'|'default'|'none' }}
 */
export function resolveDiscount(sku, ctx, supplierKey = ctx?.vigenteBySku.get(sku) ?? null) {
  if (!ctx || !supplierKey) return { ...NONE };
  const own = ctx.profilesById.get(ctx.skuProfile.get(`${supplierKey}|${sku}`));
  if (own) return described(own, 'sku');
  const packId = ctx.packIdBySku.get(sku);
  const pack = packId != null ? ctx.profilesById.get(ctx.packProfile.get(`${supplierKey}|${packId}`)) : null;
  if (pack) return described(pack, 'pack');
  const def = ctx.profilesById.get(ctx.defaultBySupplier.get(supplierKey));
  if (def) return described(def, 'default');
  return { ...NONE };
}

/** Proveedores de un SKU (claves), el vigente primero. */
export function suppliersOf(sku, ctx) {
  const all = [...(ctx?.suppliersBySku.get(sku) || [])];
  const vigente = ctx?.vigenteBySku.get(sku);
  return vigente ? [vigente, ...all.filter((k) => k !== vigente)] : all;
}

/** Slug estable para la clave de un proveedor nuevo ("Bic Argentina" → "bic_argentina"). */
export function supplierKeyFromName(name) {
  return String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    .slice(0, 60);
}
