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
