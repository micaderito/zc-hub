/**
 * Tests de services/hubProductsService.js: cómo se agrupan las publicaciones de ML y TN en
 * productos del hub (por SKU y por ficha de User Products), el estado de cada grupo y la lista.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHubProducts, queryHubProducts, linkCandidates } from '../src/services/hubProductsService.js';

const ml = (itemId, variationId, sku, extra = {}) => ({
  type: 'ml', itemId, variationId, variationName: variationId ? `Var ${variationId}` : null,
  title: `Título ${itemId}`, sku, hasSku: !!sku, price: 100, stock: 5, thumbnail: null,
  format: variationId ? 'legacy' : 'simple', soldQuantity: 0, status: 'active', ...extra,
});
const tn = (productId, variantId, sku, extra = {}) => ({
  type: 'tn', productId, variantId, variantName: null, productName: `Producto ${productId}`,
  sku, hasSku: !!sku, price: 90, stock: 5, thumbnail: null, ...extra,
});

test('1 publicación ML con 4 variaciones ↔ 4 productos TN = un solo producto del hub', () => {
  const mlRows = ['ROJ', 'AZU', 'VER', 'NEG'].map((c, i) => ml('MLA1', String(100 + i), `RIV-${c}`));
  const tnRows = ['ROJ', 'AZU', 'VER', 'NEG'].map((c, i) => tn(200 + i, 300 + i, `RIV-${c}`));
  const groups = buildHubProducts({ mlRows, tnRows });
  assert.equal(groups.length, 1);
  const [g] = groups;
  assert.equal(g.ml.length, 1);
  assert.equal(g.tn.length, 4);
  assert.equal(g.rows.length, 4);
  assert.ok(g.rows.every((r) => r.ml && r.tn && r.ml.sku === r.tn.sku));
  assert.equal(g.status, 'linked');
  assert.equal(g.name, 'Título MLA1', 'con una sola publi de ML, el nombre es el de esa publi');
});

test('3 ítems ML de la misma ficha (User Products) ↔ 1 producto TN = un producto, aunque un ítem no tenga par por SKU', () => {
  const up = (id, sku) => ml(id, null, sku, { format: 'up', familyName: 'Agenda 2027 Mooving', domainId: 'MLA-AGENDAS' });
  const mlRows = [up('MLA1', 'LIL'), up('MLA2', 'CEL'), up('MLA3', 'COR')];
  const tnRows = [tn(10, 1, 'LIL'), tn(10, 2, 'CEL')];
  const groups = buildHubProducts({ mlRows, tnRows });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].ml.length, 3);
  assert.equal(groups[0].tn.length, 1);
  assert.equal(groups[0].status, 'orphan', 'COR no tiene par en TN');
  assert.equal(groups[0].name, 'Producto 10');
});

test('fichas con el mismo family_name pero distinto dominio no se mezclan', () => {
  const mlRows = [
    ml('MLA1', null, 'A', { format: 'up', familyName: 'Set', domainId: 'D1' }),
    ml('MLA2', null, 'B', { format: 'up', familyName: 'Set', domainId: 'D2' }),
  ];
  assert.equal(buildHubProducts({ mlRows, tnRows: [] }).length, 2);
});

test('estados: solo ML, solo TN, stock distinto, variante sin SKU y SKU repetido', () => {
  const groups = buildHubProducts({
    mlRows: [
      ml('MLA1', null, 'SOLO-ML'),
      ml('MLA2', null, 'DESYNC', { stock: 3 }),
      ml('MLA3', '1', 'LED-RAY'), ml('MLA3', '2', null),
      ml('MLA4', null, 'DUP'), ml('MLA5', null, 'DUP'),
    ],
    tnRows: [
      tn(1, 1, 'SOLO-TN'),
      tn(2, 2, 'DESYNC', { stock: 5 }),
      tn(3, 3, 'LED-RAY'),
      tn(4, 4, 'DUP'),
    ],
  });
  const byMl = (id) => groups.find((g) => g.ml.some((p) => p.itemId === id));
  assert.equal(byMl('MLA1').status, 'only_ml');
  assert.equal(groups.find((g) => g.tn.some((p) => p.productId === 1)).status, 'only_tn');
  assert.equal(byMl('MLA2').status, 'desync');
  assert.equal(byMl('MLA3').status, 'orphan');
  assert.equal(byMl('MLA3').rows.find((r) => !r.sku).ml.variationId, '2');
  const dup = byMl('MLA4');
  assert.equal(dup, byMl('MLA5'), 'el SKU repetido junta las dos publis de ML');
  assert.equal(dup.status, 'duplicate');
  assert.equal(dup.rows.filter((r) => r.duplicate).length, 2);
  // lo que necesita atención va primero
  assert.equal(groups[0].status, 'orphan');
});

test('el id del grupo no depende del orden de las filas', () => {
  const a = [ml('MLA9', '1', 'X'), ml('MLA1', '1', 'Y')];
  const t = [tn(5, 1, 'X'), tn(5, 2, 'Y')];
  const k1 = buildHubProducts({ mlRows: a, tnRows: t })[0].key;
  const k2 = buildHubProducts({ mlRows: [...a].reverse(), tnRows: [...t].reverse() })[0].key;
  assert.equal(k1, k2);
  assert.equal(k1, 'ml:MLA1');
});

test('snapshot viejo sin `format`: con variación se toma como legacy', () => {
  const row = ml('MLA1', '7', 'S');
  delete row.format;
  const [g] = buildHubProducts({ mlRows: [row], tnRows: [] });
  assert.equal(g.ml[0].format, 'legacy');
});

test('queryHubProducts busca sin acentos, cuenta por estado sobre la búsqueda y pagina', () => {
  const groups = buildHubProducts({
    mlRows: [ml('MLA1', null, 'A', { title: 'Cuaderno Éxito N3' }), ml('MLA2', null, 'B', { title: 'Lapicera Bic' })],
    tnRows: [tn(1, 1, 'A')],
  });
  const r = queryHubProducts(groups, { search: 'exito' });
  assert.equal(r.total, 1);
  assert.equal(r.rows[0].name, 'Cuaderno Éxito N3');
  assert.equal(r.counts.all, 1);
  assert.equal(r.counts.linked, 1);
  assert.equal(r.counts.only_ml, 0);

  const all = queryHubProducts(groups, { status: 'only_ml' });
  assert.equal(all.total, 1);
  assert.equal(all.counts.all, 2, 'los chips cuentan sin el filtro de estado');
  assert.equal(queryHubProducts(groups, { limit: 1, offset: 1 }).rows.length, 1);
  assert.equal(queryHubProducts(groups, { search: 'B' }).total, 1, 'busca por SKU');
});

test('linkCandidates ofrece las variantes del canal pedido que no tienen par en el otro', () => {
  const catalog = {
    mlRows: [ml('MLA1', '1', 'A'), ml('MLA1', '2', null), ml('MLA2', null, 'SOLO')],
    tnRows: [tn(1, 1, 'A'), tn(1, 2, 'CUAD'), tn(2, 1, null, { productName: 'Monoblock' })],
  };
  const tnC = linkCandidates(catalog, 'tn');
  assert.deepEqual(tnC.map((c) => `${c.productId}/${c.variantId}`), ['1/2', '2/1']);
  const mlC = linkCandidates(catalog, 'ml');
  assert.deepEqual(mlC.map((c) => `${c.itemId}/${c.variationId}`), ['MLA1/2', 'MLA2/null']);
  assert.equal(linkCandidates(catalog, 'tn', 'monob').length, 1);
});
