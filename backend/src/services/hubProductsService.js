/**
 * "Productos del hub": agrupa las publicaciones de ML y TN que son el mismo producto, para la
 * página Publicaciones. Ver docs/plans/2026-10-12-publicaciones-mapeo-edicion-design.md.
 *
 * El mapeo NO se guarda: se calcula en cada lectura a partir de las filas del snapshot del catálogo
 * (`getCatalogRows`, una fila por variante de cada canal). Manda la publicación de ML: cada ítem (o
 * cada ficha de User Products, mismo `family_name` + dominio, que ML crea como un ítem por variante
 * pero para la usuaria es una sola publicación) es un producto, y las variantes de TN se le suman
 * por SKU (el SKU es la unidad que une ML ↔ TN, ver CLAUDE.md). Así sale solo el caso "1 publi de
 * ML con 4 colores ↔ 4 productos de TN" sin que nadie lo cargue a mano. Dos publicaciones de ML
 * distintas nunca se juntan (ver `buildHubProducts`).
 *
 * Todo lo de este archivo es puro (sin I/O): recibe filas, devuelve grupos.
 */

/** Estados de un producto del hub, del más urgente al más tranquilo (también es el orden de la lista). */
export const HUB_STATUSES = ['orphan', 'duplicate', 'desync', 'only_ml', 'only_tn', 'linked'];

const mlNode = (row) => `ml:${row.itemId}`;
const tnNode = (row) => `tn:${row.productId}`;

/** Union-find mínimo sobre strings. */
function makeUnionFind() {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    // compresión de camino
    while (parent.get(x) !== r) {
      const next = parent.get(x);
      parent.set(x, r);
      x = next;
    }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    // la raíz es la menor: así el id del grupo no depende del orden de las filas
    if (ra < rb) parent.set(rb, ra); else parent.set(ra, rb);
  };
  return { find, union };
}

/** Clave de familia de User Products, o null si el ítem no es de una ficha agrupada. */
function familyKey(row) {
  if (row.format !== 'up' || !row.familyName) return null;
  return `${row.domainId || ''}|${String(row.familyName).trim().toLowerCase()}`;
}

/**
 * Formato de la publicación de ML. Las filas de un snapshot anterior a este cambio no traen
 * `format`: una fila con variación es legacy, sin variación no se puede saber (queda 'simple').
 */
function mlFormat(row) {
  return row.format || (row.variationId ? 'legacy' : 'simple');
}

/**
 * Arma las filas de variantes de un grupo: una por SKU, con la punta de ML y la de TN. Un SKU que
 * se repite dentro del mismo canal genera filas extra marcadas `duplicate` (no se puede saber cuál
 * es el par de cuál). Las filas sin SKU van sueltas.
 */
function buildVariantRows(mlRows, tnRows, globalMlCountBySku = null) {
  const out = [];
  const tnBySku = new Map();
  for (const r of tnRows) {
    if (!r.sku) continue;
    if (!tnBySku.has(r.sku)) tnBySku.set(r.sku, []);
    tnBySku.get(r.sku).push(r);
  }
  const mlCountBySku = new Map();
  for (const r of mlRows) if (r.sku) mlCountBySku.set(r.sku, (mlCountBySku.get(r.sku) || 0) + 1);
  // Un SKU repetido en otra publicación de ML (que va en su propio grupo) también es duplicado.
  if (globalMlCountBySku) for (const [sku, n] of globalMlCountBySku) mlCountBySku.set(sku, n);
  const usedTn = new Set();

  for (const r of mlRows) {
    if (!r.sku) {
      out.push({ sku: null, ml: r, tn: null, duplicate: false });
      continue;
    }
    const candidates = (tnBySku.get(r.sku) || []).filter((t) => !usedTn.has(t));
    const pair = candidates[0] || null;
    if (pair) usedTn.add(pair);
    const duplicate = (mlCountBySku.get(r.sku) || 0) > 1 || (tnBySku.get(r.sku) || []).length > 1;
    out.push({ sku: r.sku, ml: r, tn: pair, duplicate });
  }
  for (const t of tnRows) {
    if (usedTn.has(t)) continue;
    const duplicate = !!t.sku && ((tnBySku.get(t.sku) || []).length > 1 || (mlCountBySku.get(t.sku) || 0) > 1);
    out.push({ sku: t.sku || null, ml: null, tn: t, duplicate });
  }
  return out;
}

function groupStatus(mlPubs, tnPubs, rows) {
  // un SKU repetido en otra publicación de ML se avisa aunque esta no tenga nada en TN
  if (!tnPubs.length) return rows.some((r) => r.duplicate) ? 'duplicate' : 'only_ml';
  if (!mlPubs.length) return 'only_tn';
  if (rows.some((r) => !r.ml || !r.tn)) return rows.some((r) => r.duplicate) ? 'duplicate' : 'orphan';
  if (rows.some((r) => r.duplicate)) return 'duplicate';
  if (rows.some((r) => Number(r.ml.stock) !== Number(r.tn.stock))) return 'desync';
  return 'linked';
}

/** Nombre a mostrar: el de la única publicación de un canal si la hay (es el "producto entero"). */
function groupName(mlPubs, tnPubs) {
  if (mlPubs.length === 1) return mlPubs[0].title;
  if (tnPubs.length === 1) return tnPubs[0].name;
  if (mlPubs[0]?.familyName) return mlPubs[0].familyName;
  return mlPubs[0]?.title || tnPubs[0]?.name || '';
}

/**
 * Agrupa las filas del catálogo en productos del hub.
 *
 * Cada publicación de ML (un ítem, o todos los ítems de una ficha de User Products) es un producto
 * propio, y nunca se junta con otra publicación de ML. Las variantes de TN se reparten por SKU entre
 * esas publicaciones: un producto de TN que trae variantes de dos publicaciones de ML distintas (caso
 * real: "Mármol rosa" con la variante rayada `39000` y la cuadriculada `C39000`, que en ML son dos
 * publicaciones) aparece en los dos productos, cada uno con sus variantes (`shared`). Antes ese
 * producto de TN unía las dos publicaciones de ML en una sola.
 *
 * Un SKU repetido en dos publicaciones de ML tampoco las junta: las dos quedan `duplicate`.
 * Lo que no tiene ninguna publicación de ML se agrupa entre sí por SKU, como antes.
 *
 * @param {{ mlRows?: object[], tnRows?: object[] }} catalog
 * @returns {object[]} grupos ordenados por estado (lo que necesita atención primero) y nombre.
 */
export function buildHubProducts({ mlRows = [], tnRows = [] } = {}) {
  // 1. Publicaciones de ML: un ítem, o los ítems de una misma ficha de User Products.
  const mlUf = makeUnionFind();
  const firstByFamily = new Map();
  for (const r of mlRows) {
    mlUf.find(mlNode(r));
    const fk = familyKey(r);
    if (!fk) continue;
    if (firstByFamily.has(fk)) mlUf.union(firstByFamily.get(fk), mlNode(r));
    else firstByFamily.set(fk, mlNode(r));
  }
  const unitOf = (r) => mlUf.find(mlNode(r));

  // SKU → publicaciones de ML que lo tienen (la menor primero, para que el reparto sea estable).
  const unitsBySku = new Map();
  const mlCountBySku = new Map();
  for (const r of mlRows) {
    if (!r.sku) continue;
    mlCountBySku.set(r.sku, (mlCountBySku.get(r.sku) || 0) + 1);
    if (!unitsBySku.has(r.sku)) unitsBySku.set(r.sku, new Set());
    unitsBySku.get(r.sku).add(unitOf(r));
  }
  const firstUnit = (sku) => (sku && unitsBySku.has(sku) ? [...unitsBySku.get(sku)].sort()[0] : null);

  // 2. Cada producto de TN tiene una "casa": la publicación de ML con la que comparte más variantes.
  //    Es adonde van sus variantes que no tienen par por SKU.
  const tnByProduct = new Map();
  for (const r of tnRows) {
    const pid = String(r.productId);
    if (!tnByProduct.has(pid)) tnByProduct.set(pid, []);
    tnByProduct.get(pid).push(r);
  }
  const home = new Map();
  for (const [pid, rows] of tnByProduct) {
    const votes = new Map();
    for (const r of rows) {
      const u = firstUnit(r.sku);
      if (u) votes.set(u, (votes.get(u) || 0) + 1);
    }
    if (!votes.size) continue;
    const [best] = [...votes].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    home.set(pid, best[0]);
  }
  // Un producto de TN sin ningún SKU en ML pero con un SKU repetido en otro producto de TN que sí
  // tiene casa (SKU duplicado en TN) va con ese.
  const tnHomesBySku = new Map();
  for (const [pid, rows] of tnByProduct) {
    if (!home.has(pid)) continue;
    for (const r of rows) if (r.sku && !tnHomesBySku.has(r.sku)) tnHomesBySku.set(r.sku, home.get(pid));
  }
  for (const [pid, rows] of tnByProduct) {
    if (home.has(pid)) continue;
    const viaTn = rows.map((r) => tnHomesBySku.get(r.sku)).filter(Boolean).sort()[0];
    if (viaTn) home.set(pid, viaTn);
  }

  // 3. Lo de TN que no tiene ninguna publicación de ML se agrupa entre sí por SKU.
  const tnUf = makeUnionFind();
  const tnOnlyBySku = new Map();
  for (const [pid, rows] of tnByProduct) {
    if (home.has(pid)) continue;
    const node = tnNode(rows[0]);
    tnUf.find(node);
    for (const r of rows) {
      if (!r.sku) continue;
      if (tnOnlyBySku.has(r.sku)) tnUf.union(tnOnlyBySku.get(r.sku), node);
      else tnOnlyBySku.set(r.sku, node);
    }
  }

  const groups = new Map();
  const groupAt = (key) => {
    if (!groups.has(key)) groups.set(key, { key, mlRows: [], tnRows: [] });
    return groups.get(key);
  };
  for (const r of mlRows) groupAt(unitOf(r)).mlRows.push(r);
  for (const r of tnRows) {
    const pid = String(r.productId);
    const key = home.has(pid) ? firstUnit(r.sku) || home.get(pid) : tnUf.find(tnNode(r));
    groupAt(key).tnRows.push(r);
  }
  const tnTotalVariants = (pid) => tnByProduct.get(String(pid))?.length || 0;

  const out = [];
  for (const g of groups.values()) {
    const mlPubs = [];
    const mlByItem = new Map();
    for (const r of g.mlRows) {
      if (!mlByItem.has(r.itemId)) {
        const pub = {
          itemId: r.itemId,
          title: r.title,
          format: mlFormat(r),
          familyName: r.familyName || null,
          soldQuantity: r.soldQuantity ?? null,
          status: r.status || null,
          thumbnail: r.thumbnail || null,
          variantCount: 0
        };
        mlByItem.set(r.itemId, pub);
        mlPubs.push(pub);
      }
      if (r.variationId) mlByItem.get(r.itemId).variantCount++;
    }
    const tnPubs = [];
    const pubByProduct = new Map();
    for (const r of g.tnRows) {
      if (!pubByProduct.has(r.productId)) {
        const pub = { productId: r.productId, name: r.productName, thumbnail: r.thumbnail || null, variantCount: 0, variantIds: [] };
        pubByProduct.set(r.productId, pub);
        tnPubs.push(pub);
      }
      pubByProduct.get(r.productId).variantCount++;
      if (r.variantId != null) pubByProduct.get(r.productId).variantIds.push(r.variantId);
    }
    // `shared`: el producto de TN tiene variantes de otra publicación de ML (va en los dos grupos).
    for (const pub of tnPubs) {
      pub.totalVariants = tnTotalVariants(pub.productId);
      pub.shared = pub.variantCount < pub.totalVariants;
    }

    const rows = buildVariantRows(g.mlRows, g.tnRows, mlCountBySku);
    const status = groupStatus(mlPubs, tnPubs, rows);
    const sum = (list) => list.reduce((a, r) => a + (Number(r.stock) || 0), 0);
    out.push({
      key: g.key,
      name: groupName(mlPubs, tnPubs),
      thumbnail: mlPubs[0]?.thumbnail || tnPubs[0]?.thumbnail || null,
      status,
      ml: mlPubs,
      tn: tnPubs,
      rows,
      variantCount: rows.length,
      mlStock: sum(g.mlRows),
      tnStock: sum(g.tnRows),
      skus: [...new Set(rows.map((r) => r.sku).filter(Boolean))]
    });
  }

  const rank = new Map(HUB_STATUSES.map((s, i) => [s, i]));
  out.sort((a, b) => (rank.get(a.status) - rank.get(b.status)) || a.name.localeCompare(b.name, 'es'));
  return out;
}

/** Fila resumida para la lista (sin las variantes). */
export function summarizeHubProduct(g) {
  return {
    key: g.key,
    name: g.name,
    thumbnail: g.thumbnail,
    status: g.status,
    mlCount: g.ml.length,
    tnCount: g.tn.length,
    variantCount: g.variantCount,
    mlStock: g.mlStock,
    tnStock: g.tnStock
  };
}

const normalize = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Filtra y pagina los grupos para la lista. `counts` cuenta por estado SOBRE la búsqueda (no sobre
 * el filtro de estado), así los chips muestran cuántos hay de cada uno para lo que se buscó.
 */
export function queryHubProducts(groups, { search = '', status = '', limit = 30, offset = 0 } = {}) {
  const q = normalize(search).trim();
  const matches = q
    ? groups.filter((g) =>
        normalize(g.name).includes(q) ||
        g.skus.some((s) => normalize(s).includes(q)) ||
        g.ml.some((p) => normalize(p.itemId).includes(q) || normalize(p.title).includes(q)) ||
        g.tn.some((p) => normalize(p.name).includes(q) || String(p.productId) === q))
    : groups;
  const counts = { all: matches.length };
  for (const s of HUB_STATUSES) counts[s] = 0;
  for (const g of matches) counts[g.status]++;
  const filtered = status && HUB_STATUSES.includes(status) ? matches.filter((g) => g.status === status) : matches;
  const lim = Math.min(Math.max(Number(limit) || 30, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);
  return { rows: filtered.slice(off, off + lim).map(summarizeHubProduct), total: filtered.length, counts };
}

/**
 * Variantes de un canal que no tienen par en el otro (para el picker "Vincular"): sin SKU, o con un
 * SKU que el otro canal no tiene. `channel` es el canal de las variantes que se ofrecen.
 */
export function linkCandidates({ mlRows = [], tnRows = [] } = {}, channel, search = '') {
  const own = channel === 'ml' ? mlRows : tnRows;
  const other = new Set((channel === 'ml' ? tnRows : mlRows).map((r) => r.sku).filter(Boolean));
  const q = normalize(search).trim();
  return own
    .filter((r) => !r.sku || !other.has(r.sku))
    .map((r) => channel === 'ml'
      ? { channel, itemId: r.itemId, variationId: r.variationId || null, name: r.title, variant: r.variationName || null, sku: r.sku || null, stock: r.stock, thumbnail: r.thumbnail || null }
      : { channel, productId: r.productId, variantId: r.variantId, name: r.productName, variant: r.variantName || null, sku: r.sku || null, stock: r.stock, thumbnail: r.thumbnail || null })
    .filter((c) => !q || normalize(`${c.name} ${c.variant || ''} ${c.sku || ''}`).includes(q));
}
