/**
 * Tests de los builders de fan-out (buildMlItems / buildTnProducts): funciones puras que
 * transforman el payload del front en los bodies de cada API según el modo de mapeo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMlItems, buildTnProducts } from '../src/services/productPublish.js';

const mlBase = {
  mapping_mode: 'single_with_variants',
  title: 'Cuaderno A4',
  category_id: 'MLA388307',
  currency_id: 'ARS',
  buying_mode: 'buy_it_now',
  condition: 'new',
  listing_type_id: 'gold_special',
  attributes: [
    { id: 'BRAND', value_name: 'ZC' },
    { id: 'SELLER_SKU', value_name: 'CUA-1' }
  ],
  sale_terms: [],
  shipping: { mode: 'me2', free_shipping: true, local_pick_up: false, dimensions: null },
  image_ids: ['t1', 't2'],
  base_price: 3500,
  base_stock: 10
};

/** picMap de ejemplo: id temporal → picture_id ya subido a ML. */
const picMap = new Map([
  ['t1', 'PIC1'],
  ['t2', 'PIC2']
]);

const tnBase = {
  mapping_mode: 'single_with_variants',
  name: { es: 'Cuaderno A4' },
  categories: [11],
  brand: 'ZC',
  published: false,
  base_price: 3500,
  base_promo_price: 3000,
  base_stock: 10,
  variants: []
};

/* ───────────────── ML ───────────────── */

test('buildMlItems (simple): un item con price/available_quantity base, SELLER_SKU y portada = 1ª foto', () => {
  const items = buildMlItems({ ml: { ...mlBase }, axes: [], variants: [] }, picMap);
  assert.equal(items.length, 1);
  assert.equal(items[0].price, 3500);
  assert.equal(items[0].available_quantity, 10);
  assert.ok(items[0].attributes.some((a) => a.id === 'SELLER_SKU'));
  // pictures desde el picMap, en orden (la primera es la portada).
  assert.deepEqual(items[0].pictures, [{ id: 'PIC1' }, { id: 'PIC2' }]);
  // shipping: dimensions null se descarta.
  assert.equal(items[0].shipping.dimensions, undefined);
  assert.equal(items[0].shipping.mode, 'me2');
});

test('buildMlItems: sin picMap las pictures quedan vacías (no rompe)', () => {
  const items = buildMlItems({ ml: { ...mlBase }, axes: [], variants: [] });
  assert.deepEqual(items[0].pictures, []);
});

test('buildMlItems: agrega atributos SELLER_PACKAGE_* (peso/dimensiones enteros con unidad) desde common', () => {
  const items = buildMlItems(
    { ml: { ...mlBase }, axes: [], variants: [], common: { lengthCm: 30, widthCm: 22, heightCm: 3, weightG: 480 } },
    picMap
  );
  const attrs = items[0].attributes;
  const val = (id) => attrs.find((a) => a.id === id)?.value_name;
  assert.equal(val('SELLER_PACKAGE_LENGTH'), '30 cm');
  assert.equal(val('SELLER_PACKAGE_WIDTH'), '22 cm');
  assert.equal(val('SELLER_PACKAGE_HEIGHT'), '3 cm');
  assert.equal(val('SELLER_PACKAGE_WEIGHT'), '480 g');
});

test('buildMlItems: NO agrega SELLER_PACKAGE_* si falta un dato o no cumple el mínimo (dim ≥3cm, peso ≥50g)', () => {
  const items = buildMlItems(
    { ml: { ...mlBase }, axes: [], variants: [], common: { lengthCm: 30, widthCm: 22, heightCm: 2, weightG: 480 } },
    picMap
  );
  assert.ok(!items[0].attributes.some((a) => String(a.id).startsWith('SELLER_PACKAGE_')));
});

test('buildMlItems (single_with_variants): variations[] con SELLER_SKU y picture_ids por variación', () => {
  const items = buildMlItems(
    {
      ml: { ...mlBase, mapping_mode: 'single_with_variants' },
      axes: [{ name: 'Color' }],
      variants: [{ sku: 'CUA-1-N', values: ['Negro'], ml: { price: 100, stock: 5, picture_ids: ['t2'] } }]
    },
    picMap
  );
  assert.equal(items.length, 1);
  const item = items[0];
  // item-level NO lleva SELLER_SKU ni price; sí el pool de pictures.
  assert.equal(item.price, undefined);
  assert.ok(!item.attributes.some((a) => a.id === 'SELLER_SKU'));
  assert.deepEqual(item.pictures, [{ id: 'PIC1' }, { id: 'PIC2' }]);
  assert.equal(item.variations.length, 1);
  assert.deepEqual(item.variations[0].attribute_combinations, [{ name: 'Color', value_name: 'Negro' }]);
  assert.equal(item.variations[0].price, 100);
  assert.equal(item.variations[0].available_quantity, 5);
  assert.deepEqual(item.variations[0].attributes, [{ id: 'SELLER_SKU', value_name: 'CUA-1-N' }]);
  // picture_ids de la variación resueltos desde el picMap.
  assert.deepEqual(item.variations[0].picture_ids, ['PIC2']);
});

test('buildMlItems (one_per_variant): N items simples, cada uno con SELLER_SKU, título y sus fotos', () => {
  const items = buildMlItems(
    {
      ml: { ...mlBase, mapping_mode: 'one_per_variant' },
      axes: [{ name: 'Color' }],
      variants: [
        { sku: 'CUA-N', values: ['Negro'], ml: { price: 100, stock: 5, picture_ids: ['t1'] } },
        { sku: 'CUA-R', values: ['Rojo'], ml: { price: 110, stock: 3 } }
      ]
    },
    picMap
  );
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Cuaderno A4 Negro');
  assert.equal(items[0].price, 100);
  assert.ok(items[0].attributes.some((a) => a.id === 'SELLER_SKU' && a.value_name === 'CUA-N'));
  // La variante con foto propia usa esa; la que no tiene cae a la galería general.
  assert.deepEqual(items[0].pictures, [{ id: 'PIC1' }]);
  assert.deepEqual(items[1].pictures, [{ id: 'PIC1' }, { id: 'PIC2' }]);
  assert.equal(items[1].title, 'Cuaderno A4 Rojo');
});

/* ───────────────── TN ───────────────── */

test('buildTnProducts (simple): inyecta precio/stock base y price va como string', () => {
  const products = buildTnProducts({
    tn: { ...tnBase },
    variants: []
  });
  assert.equal(products.length, 1);
  assert.equal(products[0].published, false);
  assert.deepEqual(products[0].categories, [11]);
  const v = products[0].variants[0];
  assert.equal(v.price, '3500.00');
  assert.equal(v.promotional_price, '3000.00');
  assert.equal(v.stock, 10);
  assert.equal(v.stock_management, true);
});

test('buildTnProducts (single_with_variants): un producto con todas las variantes normalizadas', () => {
  const products = buildTnProducts({
    tn: {
      ...tnBase,
      mapping_mode: 'single_with_variants',
      variants: [{ sku: 'CUA-N', values: [{ es: 'Color: Negro' }], price: 100, promotional_price: null, stock: 5 }]
    },
    variants: [{ sku: 'CUA-N', values: ['Negro'] }]
  });
  assert.equal(products.length, 1);
  assert.equal(products[0].variants.length, 1);
  assert.equal(products[0].variants[0].price, '100.00');
  assert.equal(products[0].variants[0].promotional_price, undefined);
  assert.deepEqual(products[0].variants[0].values, [{ es: 'Color: Negro' }]);
});

test('buildTnProducts (one_per_variant): N productos, uno por variante, con nombre sufijado', () => {
  const products = buildTnProducts({
    tn: {
      ...tnBase,
      mapping_mode: 'one_per_variant',
      variants: [
        { sku: 'CUA-N', values: [{ es: 'Color: Negro' }], price: 100, stock: 5 },
        { sku: 'CUA-R', values: [{ es: 'Color: Rojo' }], price: 110, stock: 3 }
      ]
    },
    variants: [
      { sku: 'CUA-N', values: ['Negro'] },
      { sku: 'CUA-R', values: ['Rojo'] }
    ]
  });
  assert.equal(products.length, 2);
  assert.equal(products[0].name.es, 'Cuaderno A4 Negro');
  // producto simple por variante: sin combinaciones de valores.
  assert.equal(products[0].variants[0].values, undefined);
  assert.equal(products[1].name.es, 'Cuaderno A4 Rojo');
});
