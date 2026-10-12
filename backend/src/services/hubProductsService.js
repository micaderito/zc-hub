/**
 * "Productos del hub": agrupa las publicaciones de ML y TN que son el mismo producto, para la
 * página Publicaciones. Ver docs/plans/2026-10-12-publicaciones-mapeo-edicion-design.md.
 *
 * El mapeo NO se guarda: se calcula en cada lectura a partir de las filas del snapshot del catálogo
 * (`getCatalogRows`, una fila por variante de cada canal). Es un grafo cuyos nodos son las
 * publicaciones (`ml:<itemId>`, `tn:<productId>`) y cuyas aristas son:
 *   - un SKU que aparece en las dos puntas (el SKU es la unidad que une ML ↔ TN, ver CLAUDE.md);
 *   - dos ítems de ML de la misma ficha de User Products (mismo `family_name` + dominio): ML crea
 *     un ítem por variante, pero para la usuaria es una sola publicación.
 * Cada componente conexa es un producto. Así sale solo el caso "1 publi de ML con 4 colores ↔ 4
 * productos de TN" (y el inverso, y N ↔ M) sin que nadie lo cargue a mano.
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
function buildVariantRows(mlRows, tnRows) {
  const out = [];
  const tnBySku = new Map();
  for (const r of tnRows) {
    if (!r.sku) continue;
    if (!tnBySku.has(r.sku)) tnBySku.set(r.sku, []);
    tnBySku.get(r.sku).push(r);
  }
  const mlCountBySku = new Map();
  for (const r of mlRows) if (r.sku) mlCountBySku.set(r.sku, (mlCountBySku.get(r.sku) || 0) + 1);
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
  if (!tnPubs.length) return 'only_ml';
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
 * @param {{ mlRows?: object[], tnRows?: object[] }} catalog
 * @returns {object[]} grupos ordenados por estado (lo que necesita atención primero) y nombre.
 */
export function buildHubProducts({ mlRows = [], tnRows = [] } = {}) {
  const uf = makeUnionFind();
  for (const r of mlRows) uf.find(mlNode(r));
  for (const r of tnRows) uf.find(tnNode(r));

  // Aristas por SKU: todas las publicaciones (de cualquiera de los dos canales) que comparten un SKU.
  const nodesBySku = new Map();
  const addSku = (sku, node) => {
    if (!sku) return;
    if (!nodesBySku.has(sku)) nodesBySku.set(sku, new Set());
    nodesBySku.get(sku).add(node);
  };
  for (const r of mlRows) addSku(r.sku, mlNode(r));
  for (const r of tnRows) addSku(r.sku, tnNode(r));
  for (const nodes of nodesBySku.values()) {
    const [first, ...rest] = [...nodes];
    for (const n of rest) uf.union(first, n);
  }

  // Aristas por ficha de User Products.
  const firstByFamily = new Map();
  for (const r of mlRows) {
    const fk = familyKey(r);
    if (!fk) continue;
    if (firstByFamily.has(fk)) uf.union(firstByFamily.get(fk), mlNode(r));
    else firstByFamily.set(fk, mlNode(r));
  }

  const groups = new Map();
  const groupOf = (node) => {
    const key = uf.find(node);
    if (!groups.has(key)) groups.set(key, { key, mlRows: [], tnRows: [] });
    return groups.get(key);
  };
  for (const r of mlRows) groupOf(mlNode(r)).mlRows.push(r);
  for (const r of tnRows) groupOf(tnNode(r)).tnRows.push(r);

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
    const tnByProduct = new Map();
    for (const r of g.tnRows) {
      if (!tnByProduct.has(r.productId)) {
        const pub = { productId: r.productId, name: r.productName, thumbnail: r.thumbnail || null, variantCount: 0 };
        tnByProduct.set(r.productId, pub);
        tnPubs.push(pub);
      }
      tnByProduct.get(r.productId).variantCount++;
    }

    const rows = buildVariantRows(g.mlRows, g.tnRows);
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
