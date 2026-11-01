/**
 * Tests de services/publicationDiff.js: de "borrador editado vs. cómo estaba" a la lista de
 * operaciones por publicación. Lo central: lo que no se tocó no genera nada.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEditDraft } from '../src/services/publicationImport.js';
import { planPublicationUpdate, summarizeOps } from '../src/services/publicationDiff.js';

function fixture() {
  const item = {
    id: 'MLA1', title: 'Cuaderno Rivadavia A4', category_id: 'MLA1', listing_type_id: 'gold_special', condition: 'new', sold_quantity: 12,
    shipping: { mode: 'me2', free_shipping: false, local_pick_up: false },
    pictures: [{ id: 'P1', secure_url: 'https://ml/1.jpg' }, { id: 'P2', secure_url: 'https://ml/2.jpg' }],
    attributes: [{ id: 'BRAND', name: 'Marca', value_name: 'Rivadavia' }, { id: 'SHEET_TYPE', name: 'Tipo de hoja', value_name: 'Rayada' }],
    variations: [
      { id: 11, price: 8990, available_quantity: 3, sold_quantity: 12, picture_ids: ['P1'], attribute_combinations: [{ id: 'COLOR', name: 'Color', value_name: 'Rojo' }], attributes: [{ id: 'SELLER_SKU', value_name: 'ROJ' }] },
      { id: 12, price: 8990, available_quantity: 8, sold_quantity: 0, picture_ids: ['P2'], attribute_combinations: [{ id: 'COLOR', name: 'Color', value_name: 'Azul' }], attributes: [{ id: 'SELLER_SKU', value_name: 'AZU' }] },
    ],
  };
  const tnP = (id, color, sku) => ({
    id, name: { es: `Cuaderno Rivadavia A4 ${color}` }, description: { es: 'Desc TN' }, categories: [{ id: 5 }], images: [{ id: id * 10, src: 'https://tn/x.jpg' }],
    variants: [{ id: id + 100, sku, price: '7990', stock: color === 'Rojo' ? 3 : 8, values: [] }],
  });
  return buildEditDraft({ mlItems: [item], mlDescriptions: { MLA1: 'Desc ML' }, tnProducts: [tnP(1, 'Rojo', 'ROJ'), tnP(2, 'Azul', 'AZU')] });
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const kinds = (ops) => ops.map((o) => `${o.channel}:${o.targetLabel}:${o.kind}`);

test('sin cambios no hay operaciones', () => {
  const { draft, baseline, refs } = fixture();
  assert.deepEqual(planPublicationUpdate(baseline, clone(draft), refs), []);
});

test('descripción de ML y de TN: una operación por publicación de cada canal', () => {
  const { draft, baseline, refs } = fixture();
  const d = clone(draft);
  d.ml.description.value = 'Nueva';
  d.tn.description.value = 'Nueva TN';
  const ops = planPublicationUpdate(baseline, d, refs);
  assert.deepEqual(kinds(ops), ['ml:ML-1:description', 'tn:TN-1:product', 'tn:TN-2:product']);
  assert.equal(ops[0].payload.plain_text, 'Nueva');
  assert.ok(ops[1].payload.fields.includes('description'));
});

test('stock y precio por variante van a la publicación de esa variante; el precio en clásica avisa', () => {
  const { draft, baseline, refs } = fixture();
  const d = clone(draft);
  d.variants[1].stock = 10;
  d.variants[0].ml.price = 9500;
  const ops = planPublicationUpdate(baseline, d, refs);
  assert.deepEqual(kinds(ops), ['ml:ML-1:price:v1', 'ml:ML-1:stock:v2', 'tn:TN-2:stock:v2']);
  assert.match(ops[0].warn, /todas las variaciones/);
  assert.equal(ops[1].payload.variationId, '12');
  assert.equal(ops[2].payload.variantId, 102);
});

test('agregar una variante: variación nueva en la publi clásica y producto nuevo en TN (uno por variante)', () => {
  const { draft, baseline, refs } = fixture();
  const d = clone(draft);
  d.variants.push({ ...clone(d.variants[0]), id: 'vNew', sku: 'VIO', values: ['Violeta'], titles: { ml: { inherited: true, value: '' }, tn: { inherited: true, value: '' } } });
  const ops = planPublicationUpdate(baseline, d, refs);
  assert.deepEqual(kinds(ops), ['ml:ML-1:add_variation:vNew', 'tn:TN nuevo:create_product']);
  assert.equal(ops[1].label, 'Crear el producto "Cuaderno Rivadavia A4 - Violeta"');
  assert.equal(ops[0].key, 'ml:MLA1:add_variation:vNew', 'key estable para reintentar sin duplicar');
});

test('quitar una variante con ventas avisa; en TN uno-por-variante elimina el producto', () => {
  const { draft, baseline, refs } = fixture();
  const d = clone(draft);
  d.variants = d.variants.filter((v) => v.id !== 'v1');
  const ops = planPublicationUpdate(baseline, d, refs);
  assert.deepEqual(kinds(ops), ['ml:ML-1:delete_variation:v1', 'tn:TN-1:delete_product']);
  assert.match(ops[0].warn, /12 ventas/);
});

test('fotos, características, tipo de publicación y medidas', () => {
  const { draft, baseline, refs } = fixture();
  const d = clone(draft);
  d.ml.images.reverse();
  d.ml.attributes.find((a) => a.id === 'SHEET_TYPE').value = 'Cuadriculada';
  d.ml.listingType = 'gold_pro';
  d.common.lengthCm = 30;
  const ops = planPublicationUpdate(baseline, d, refs);
  const k = kinds(ops);
  assert.ok(k.includes('ml:ML-1:pictures'));
  assert.ok(k.includes('ml:ML-1:listing_type'));
  const attrs = ops.find((o) => o.kind === 'attributes');
  assert.match(attrs.label, /Tipo de hoja/);
  assert.match(attrs.label, /medidas del paquete/);
  assert.ok(k.includes('tn:TN-1:variants_common'), 'las medidas también van a TN');
});

test('un atributo que la categoría suma vacío al refrescar no cuenta como cambio', () => {
  const { draft, baseline, refs } = fixture();
  const d = clone(draft);
  d.ml.attributes.push({ id: 'YEAR', name: 'Año', value: '', required: false, inherited: false });
  const sheet = d.ml.attributes.find((a) => a.id === 'SHEET_TYPE');
  delete sheet.valueId; // el refresco puede descartar un value_id que la categoría ya no reconoce
  assert.deepEqual(planPublicationUpdate(baseline, d, refs), []);
});

test('nombre propio de un producto de TN en "uno por variante" y título con ventas no se manda en single', () => {
  const { draft, baseline, refs } = fixture();
  const d = clone(draft);
  d.variants[0].titles.tn.value = 'Cuaderno Rojo Pasión';
  const ops = planPublicationUpdate(baseline, d, refs);
  assert.deepEqual(kinds(ops), ['tn:TN-1:name:v1']);
  assert.deepEqual(ops[0].payload.name, { es: 'Cuaderno Rojo Pasión' });
});

test('producto simple: stock, precio y SKU van a la publicación de cada canal', () => {
  const r = buildEditDraft({
    mlItems: [{ id: 'MLA5', title: 'Bic', price: 100, available_quantity: 5, pictures: [], attributes: [{ id: 'SELLER_SKU', value_name: 'B' }] }],
    tnProducts: [{ id: 3, name: { es: 'Bic' }, images: [], variants: [{ id: 31, sku: 'B', price: '90', stock: 5, values: [] }] }],
  });
  const d = clone(r.draft);
  d.common.baseStock = 7;
  d.tn.basePrice = 95;
  const ops = planPublicationUpdate(r.baseline, d, r.refs);
  assert.deepEqual(kinds(ops), ['ml:ML-1:stock', 'tn:TN-1:stock', 'tn:TN-1:price']);
  assert.deepEqual(summarizeOps(ops), { total: 3, ml: 1, tn: 2 });
});

test('un canal donde el producto no está publicado no genera operaciones', () => {
  const r = buildEditDraft({ mlItems: [], tnProducts: [{ id: 3, name: { es: 'Bic' }, images: [], variants: [{ id: 31, sku: 'B', price: '90', stock: 5, values: [] }] }] });
  const d = clone(r.draft);
  d.ml.description.value = 'algo';
  d.ml.listingType = 'gold_pro';
  assert.deepEqual(planPublicationUpdate(r.baseline, d, r.refs), []);
});

test('ítems sueltos de ML (uno por variante): la galería es un banco, no se manda entera a cada ítem', () => {
  const item = (id, sku, pic) => ({
    id, title: `Repuesto A4 ${sku}`, price: 100, available_quantity: 5,
    pictures: [{ id: pic, secure_url: `https://ml/${pic}.jpg` }], attributes: [{ id: 'SELLER_SKU', value_name: sku }],
  });
  const product = {
    id: 4, name: { es: 'Repuesto A4' }, attributes: [{ es: 'Hoja' }], images: [],
    variants: [{ id: 41, sku: 'RAY', price: '90', stock: 5, values: [{ es: 'Rayada' }] }, { id: 42, sku: 'LIS', price: '90', stock: 5, values: [{ es: 'Lisa' }] }],
  };
  const r = buildEditDraft({ mlItems: [item('MLA1', 'RAY', 'P1'), item('MLA2', 'LIS', 'P2')], tnProducts: [product] });
  assert.equal(r.draft.ml.mappingMode, 'one_per_variant');
  const d = clone(r.draft);
  d.ml.images.push({ id: 'nueva' });
  d.variants[0].ml.pictureIds.push('nueva');
  const ops = planPublicationUpdate(r.baseline, d, r.refs);
  assert.deepEqual(kinds(ops), ['ml:ML-1:pictures:v1']);
  assert.deepEqual(ops[0].payload.image_ids, ['ml-P1', 'nueva']);
});

/** ML legacy de 4 colores ↔ dos productos de TN con 2 variantes cada uno (A4 y A5). */
function twoTnProducts() {
  const vars = [['ROJ', 'Rojo', 11], ['AZU', 'Azul', 12], ['VER', 'Verde', 13], ['NEG', 'Negro', 14]];
  const item = {
    id: 'MLA1', title: 'Cuaderno', category_id: 'MLA1', listing_type_id: 'gold_special', pictures: [], attributes: [],
    variations: vars.map(([sku, color, id]) => ({ id, price: 100, available_quantity: 1, attribute_combinations: [{ id: 'COLOR', name: 'Color', value_name: color }], attributes: [{ id: 'SELLER_SKU', value_name: sku }] })),
  };
  const tnP = (id, name, list, extra = {}) => ({
    id, name: { es: name }, description: { es: 'Desc' }, handle: { es: `cuaderno-${id}` }, categories: [{ id: 5 }], images: [{ id: id * 10 }], attributes: [{ es: 'Color' }],
    variants: list.map(([sku, color, vid]) => ({ id: vid + 100 * id, sku, price: '90', stock: 1, values: [{ es: color }] })), ...extra,
  });
  return buildEditDraft({ mlItems: [item], mlDescriptions: { MLA1: 'Desc' }, tnProducts: [tnP(1, 'Cuaderno A4', vars.slice(0, 2)), tnP(2, 'Cuaderno A5', vars.slice(2), { description: { es: 'Otra desc' } })] });
}

test('TN con varios productos: quitar UNA variante de un producto con variantes borra la variante, no el producto', () => {
  const { draft, baseline, refs } = twoTnProducts();
  const d = clone(draft);
  d.variants = d.variants.filter((v) => v.sku !== 'ROJ');
  const tn = planPublicationUpdate(baseline, d, refs).filter((o) => o.channel === 'tn');
  assert.deepEqual(tn.map((o) => o.kind), ['delete_variant:v1']);
  assert.equal(tn[0].target, '1');
});

test('TN con varios productos: quitar todas las variantes de un producto lo elimina una sola vez', () => {
  const { draft, baseline, refs } = twoTnProducts();
  const d = clone(draft);
  d.variants = d.variants.filter((v) => !['VER', 'NEG'].includes(v.sku));
  const tn = planPublicationUpdate(baseline, d, refs).filter((o) => o.channel === 'tn');
  assert.deepEqual(tn.map((o) => `${o.target}:${o.kind}`), ['2:delete_product']);
  assert.match(tn[0].label, /todas sus variantes/);
});

test('TN con varios productos: el nombre y las fotos de una variante de un producto con variantes son del producto', () => {
  const { draft, baseline, refs } = twoTnProducts();
  const d = clone(draft);
  d.variants[0].titles.tn.value = 'Cuaderno A4 Pro';
  d.variants[0].tn.imageIds = ['tn-10', 'otra'];
  d.variants[0].values = ['Bordó'];
  const tn = planPublicationUpdate(baseline, d, refs).filter((o) => o.channel === 'tn');
  const byKind = Object.fromEntries(tn.map((o) => [o.kind, o]));
  assert.deepEqual(byKind['variant:v1'].payload.fields, ['values'], 'el valor de la variante se renombra como variante');
  assert.equal(byKind['images:v1'].payload.multiVariant, true);
  assert.equal(byKind.name.key, 'tn:1:name');
  assert.match(byKind.name.warn, /2 variantes/);
});

test('cambio común en TN: solo a los productos que tenían el valor que se vio, la URL nunca se copia a otro', () => {
  const { draft, baseline, refs } = twoTnProducts();
  const d = clone(draft);
  d.tn.description.value = 'Nueva';
  d.tn.handle = 'cuaderno-nuevo';
  d.tn.categories = [5, 6];
  const tn = planPublicationUpdate(baseline, d, refs).filter((o) => o.channel === 'tn');
  assert.deepEqual(tn.map((o) => [o.target, o.payload.fields]), [['1', ['description', 'categories', 'handle']], ['2', ['categories']]]);
  assert.match(tn[0].warn, /TN-2 tenía otro valor en «descripción»/);
  assert.match(tn[0].warn, /«URL»/);
});

test('cambio común en ML: descripción y envío van solo a los ítems que lo tenían igual; el envío manda solo lo que cambió', () => {
  const it = (id, sku, desc, pickup) => ({ id, title: `Rep ${sku}`, price: 1, available_quantity: 1, user_product_id: `U${id}`, shipping: { free_shipping: false, local_pick_up: pickup }, pictures: [], attributes: [{ id: 'SELLER_SKU', value_name: sku }, { id: 'COLOR', value_name: sku }] });
  const r = buildEditDraft({ mlItems: [it('MLA1', 'A', 'x', false), it('MLA2', 'B', 'y', true)], mlDescriptions: { MLA1: 'Desc 1', MLA2: 'Desc 2' }, tnProducts: [] });
  const d = clone(r.draft);
  d.ml.description.value = 'Nueva';
  d.ml.freeShipping = true;
  const ops = planPublicationUpdate(r.baseline, d, r.refs);
  assert.deepEqual(kinds(ops), ['ml:ML-1:description', 'ml:ML-1:shipping', 'ml:ML-2:shipping']);
  assert.match(ops[0].warn, /ML-2 tenía otro valor en «descripción»/);
  assert.deepEqual(ops[1].payload, { free_shipping: true }, 'no pisa el retiro en persona de cada ítem');
});

test('vaciar la descripción de ML avisa que ML no lo deja', () => {
  const { draft, baseline, refs } = fixture();
  const d = clone(draft);
  d.ml.description.value = '';
  const op = planPublicationUpdate(baseline, d, refs).find((o) => o.kind === 'description');
  assert.match(op.warn, /vacía/);
});

test('TN: cambiar solo el género no reescribe las medidas; cambiar el SKU no manda nombre ni código de barras', () => {
  const { draft, baseline, refs } = fixture();
  const d = clone(draft);
  d.common.gender = 'female';
  d.variants[0].sku = 'ROJ2';
  const ops = planPublicationUpdate(baseline, d, refs).filter((o) => o.channel === 'tn');
  const common = ops.filter((o) => o.kind === 'variants_common');
  assert.deepEqual(common.map((o) => o.payload), [{ gender: 'female' }, { gender: 'female' }]);
  assert.deepEqual(ops.find((o) => o.kind === 'variant:v1').payload.fields, ['sku']);
});

test('publicación clásica: dos precios distintos generan UN cambio de precio con aviso', () => {
  const { draft, baseline, refs } = fixture();
  const d = clone(draft);
  d.variants[0].ml.price = 9500;
  d.variants[1].ml.price = 9900;
  const prices = planPublicationUpdate(baseline, d, refs).filter((o) => o.channel === 'ml' && o.kind.startsWith('price'));
  assert.equal(prices.length, 1);
  assert.equal(prices[0].payload.price, 9500);
  assert.match(prices[0].warn, /precios distintos/);
});

test('un solo ítem de User Products: el título no se manda (lo arma ML) y queda bloqueado', () => {
  const r = buildEditDraft({
    mlItems: [{ id: 'MLA9', title: 'Agenda Rosa', user_product_id: 'MLAU1', family_name: 'Agenda', price: 1, available_quantity: 1, pictures: [], attributes: [{ id: 'SELLER_SKU', value_name: 'R' }] }],
    tnProducts: [],
  });
  assert.match(r.locks.mlTitle, /User Products/);
  const d = clone(r.draft);
  d.ml.title = { inherited: false, value: 'Otra' };
  assert.deepEqual(planPublicationUpdate(r.baseline, d, r.refs), []);
});

test('una característica en "No aplica" no se puede vaciar: no se manda y se avisa; tipo de publicación avisa que es una sola vez', () => {
  const { draft, baseline, refs } = fixture();
  const b = clone(baseline);
  b.ml.attributes.push({ id: 'COVER', name: 'Tapa', value: '', notApplicable: true });
  const d = clone(b);
  d.ml.attributes.find((a) => a.id === 'COVER').notApplicable = false;
  d.ml.attributes.find((a) => a.id === 'SHEET_TYPE').value = 'Lisa';
  d.ml.listingType = 'gold_pro';
  const ops = planPublicationUpdate(b, d, refs);
  const attrs = ops.find((o) => o.kind === 'attributes');
  assert.deepEqual(attrs.payload.attributes.map((a) => a.id), ['SHEET_TYPE']);
  assert.match(attrs.warn, /No aplica.*Tapa/);
  assert.match(ops.find((o) => o.kind === 'listing_type').warn, /una sola vez/);
  void draft;
});
