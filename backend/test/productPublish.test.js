/**
 * Tests de los builders de fan-out (buildMlItems / buildTnProducts): funciones puras que
 * transforman el payload del front en los bodies de cada API según el modo de mapeo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMlItems, buildTnProducts, mlUnitKey, planTnUnits } from '../src/services/productPublish.js';

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
  ['t1', { id: 'PIC1' }],
  ['t2', { id: 'PIC2' }]
]);

const tnBase = {
  mapping_mode: 'single_with_variants',
  name: { es: 'Cuaderno A4' },
  description: { es: 'Descripción de prueba' },
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

test('buildMlItems (one_per_variant): usa el título propio de la variante si viene, no el automático', () => {
  const items = buildMlItems(
    {
      ml: { ...mlBase, mapping_mode: 'one_per_variant' },
      axes: [{ name: 'Color' }],
      variants: [{ sku: 'CUA-N', values: ['Negro'], ml: { price: 100, stock: 5, title: 'Cuaderno A4 Negro Edición Especial' } }]
    },
    picMap
  );
  assert.equal(items[0].title, 'Cuaderno A4 Negro Edición Especial');
});

test('buildMlItems: agrega GTIN al item simple si hay código de barras en common; no lo inventa si falta', () => {
  const conBarcode = buildMlItems(
    { ml: { ...mlBase }, axes: [], variants: [], common: { barcode: '7791234567890' } },
    picMap
  );
  assert.ok(conBarcode[0].attributes.some((a) => a.id === 'GTIN' && a.value_name === '7791234567890'));

  const sinBarcode = buildMlItems({ ml: { ...mlBase }, axes: [], variants: [], common: {} }, picMap);
  assert.ok(!sinBarcode[0].attributes.some((a) => a.id === 'GTIN'));
});

test('buildMlItems: si viene SALE_FORMAT sin UNITS_PER_PACK, agrega UNITS_PER_PACK=1 (ML lo exige)', () => {
  const items = buildMlItems(
    { ml: { ...mlBase, attributes: [...mlBase.attributes, { id: 'SALE_FORMAT', value_id: '1359391' }] }, axes: [], variants: [] },
    picMap
  );
  assert.ok(items[0].attributes.some((a) => a.id === 'UNITS_PER_PACK' && a.value_name === '1'));
});

test('buildMlItems: NO toca UNITS_PER_PACK si el usuario ya lo mandó', () => {
  const items = buildMlItems(
    {
      ml: {
        ...mlBase,
        attributes: [...mlBase.attributes, { id: 'SALE_FORMAT', value_id: '1359392' }, { id: 'UNITS_PER_PACK', value_name: '6' }]
      },
      axes: [],
      variants: []
    },
    picMap
  );
  const ups = items[0].attributes.filter((a) => a.id === 'UNITS_PER_PACK');
  assert.equal(ups.length, 1);
  assert.equal(ups[0].value_name, '6');
});

test('buildMlItems: sin SALE_FORMAT no inventa UNITS_PER_PACK', () => {
  const items = buildMlItems({ ml: { ...mlBase }, axes: [], variants: [] }, picMap);
  assert.ok(!items[0].attributes.some((a) => a.id === 'UNITS_PER_PACK'));
});

test('buildMlItems (one_per_variant): la red de UNITS_PER_PACK aplica a cada ítem de la familia', () => {
  const items = buildMlItems(
    {
      ml: {
        ...mlBase,
        mapping_mode: 'one_per_variant',
        attributes: [...mlBase.attributes, { id: 'SALE_FORMAT', value_id: '1359391' }]
      },
      axes: [{ name: 'Color' }],
      variants: [
        { sku: 'CUA-N', values: ['Negro'], ml: { price: 100, stock: 5 } },
        { sku: 'CUA-R', values: ['Rojo'], ml: { price: 110, stock: 3 } }
      ]
    },
    picMap
  );
  assert.ok(items.every((it) => it.attributes.some((a) => a.id === 'UNITS_PER_PACK' && a.value_name === '1')));
});

test('buildMlItems (one_per_variant): GTIN es el código de barras de CADA variante, no el común', () => {
  const items = buildMlItems(
    {
      ml: { ...mlBase, mapping_mode: 'one_per_variant' },
      axes: [{ name: 'Color' }],
      variants: [
        { sku: 'CUA-N', values: ['Negro'], barcode: '7791111111111', ml: { price: 100, stock: 5 } },
        { sku: 'CUA-R', values: ['Rojo'], ml: { price: 110, stock: 3 } } // sin propio → sin GTIN (el front ya resolvió el fallback al común)
      ]
    },
    picMap
  );
  assert.ok(items[0].attributes.some((a) => a.id === 'GTIN' && a.value_name === '7791111111111'));
  assert.ok(!items[1].attributes.some((a) => a.id === 'GTIN'));
});

test('buildMlItems (single_with_variants): GTIN va por variación, no al nivel del ítem', () => {
  const items = buildMlItems(
    {
      ml: { ...mlBase, mapping_mode: 'single_with_variants' },
      axes: [{ name: 'Color' }],
      variants: [{ sku: 'CUA-1-N', values: ['Negro'], barcode: '7792222222222', ml: { price: 100, stock: 5 } }]
    },
    picMap
  );
  assert.ok(!items[0].attributes.some((a) => a.id === 'GTIN'));
  assert.ok(items[0].variations[0].attributes.some((a) => a.id === 'GTIN' && a.value_name === '7792222222222'));
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

test('buildTnProducts (one_per_variant): usa el nombre propio de la variante si viene, no el automático', () => {
  const products = buildTnProducts({
    tn: {
      ...tnBase,
      mapping_mode: 'one_per_variant',
      variants: [{ sku: 'CUA-N', values: [{ es: 'Color: Negro' }], price: 100, stock: 5 }]
    },
    variants: [{ sku: 'CUA-N', values: ['Negro'], name: 'Cuaderno A4 Negro Edición Especial' }]
  });
  assert.equal(products[0].name.es, 'Cuaderno A4 Negro Edición Especial');
});

test('buildTnProducts (one_per_variant): el nombre en pt SIEMPRE lleva el sufijo automático (no hay override por idioma)', () => {
  const products = buildTnProducts({
    tn: {
      ...tnBase,
      name: { es: 'Cuaderno A4', pt: 'Caderno A4' },
      mapping_mode: 'one_per_variant',
      variants: [
        { sku: 'CUA-N', values: [{ es: 'Color: Negro' }], price: 100, stock: 5 },
        { sku: 'CUA-R', values: [{ es: 'Color: Rojo' }], price: 110, stock: 3 }
      ]
    },
    // Uno con nombre propio en es (no debería afectar el pt) y otro 100% automático.
    variants: [
      { sku: 'CUA-N', values: ['Negro'], name: 'Cuaderno A4 Negro Edición Especial' },
      { sku: 'CUA-R', values: ['Rojo'] }
    ]
  });
  assert.equal(products[0].name.pt, 'Caderno A4 Negro');
  assert.equal(products[1].name.es, 'Cuaderno A4 Rojo');
  assert.equal(products[1].name.pt, 'Caderno A4 Rojo');
});

/* ───────────────── ML: modelo User Products (family_name) ───────────────── */
// La cuenta ya está migrada al modelo User Products (tag user_product_seller): POST /items
// RECHAZA `variations[]` y RECHAZA que el vendedor mande `title` — hay que mandar `family_name`
// y un ítem por variación (ver CLAUDE.md y lib/mlUserProducts.js).

test('buildMlItems (sin variantes, userProducts): family_name en vez de title', () => {
  const items = buildMlItems({ ml: { ...mlBase }, axes: [], variants: [] }, picMap, { userProducts: true });
  assert.equal(items[0].family_name, 'Cuaderno A4');
  assert.equal(items[0].title, undefined);
});

test('buildMlItems (single_with_variants, userProducts): N items con el MISMO family_name, sin title ni variations', () => {
  const items = buildMlItems(
    {
      ml: { ...mlBase, mapping_mode: 'single_with_variants' },
      axes: [{ name: 'Color' }],
      variants: [
        { sku: 'CUA-1-N', values: ['Negro'], ml: { price: 100, stock: 5 } },
        { sku: 'CUA-1-R', values: ['Rojo'], ml: { price: 100, stock: 3 } }
      ]
    },
    picMap,
    { userProducts: true }
  );
  assert.equal(items.length, 2);
  assert.ok(items.every((it) => it.family_name === 'Cuaderno A4'));
  assert.ok(items.every((it) => it.title === undefined));
  assert.ok(items.every((it) => it.variations === undefined));
  // Cada item lleva su propio price/available_quantity y SELLER_SKU (a diferencia del legacy).
  assert.equal(items[0].price, 100);
  assert.equal(items[0].available_quantity, 5);
  assert.ok(items[0].attributes.some((a) => a.id === 'SELLER_SKU' && a.value_name === 'CUA-1-N'));
  assert.ok(items[1].attributes.some((a) => a.id === 'SELLER_SKU' && a.value_name === 'CUA-1-R'));
});

test('buildMlItems (one_per_variant, userProducts): family_name PROPIO por variante (no comparten familia)', () => {
  const items = buildMlItems(
    {
      ml: { ...mlBase, mapping_mode: 'one_per_variant' },
      axes: [{ name: 'Color' }],
      variants: [
        { sku: 'CUA-N', values: ['Negro'], ml: { price: 100, stock: 5 } },
        { sku: 'CUA-R', values: ['Rojo'], ml: { price: 110, stock: 3 } }
      ]
    },
    picMap,
    { userProducts: true }
  );
  assert.equal(items[0].family_name, 'Cuaderno A4 Negro');
  assert.equal(items[1].family_name, 'Cuaderno A4 Rojo');
  assert.notEqual(items[0].family_name, items[1].family_name);
  assert.ok(items.every((it) => it.title === undefined));
});

/* ───────────────── ML: atributos de eje (mlAttributeId) ───────────────── */

test('buildMlItems: eje mapeado a un atributo real de ML manda value_id si el valor matchea una opción cerrada', () => {
  const items = buildMlItems(
    {
      ml: { ...mlBase, mapping_mode: 'one_per_variant' },
      axes: [{ name: 'Color', mlAttributeId: 'COLOR', allowedValues: [{ id: '52049', name: 'Negro' }, { id: '52055', name: 'Rojo' }] }],
      variants: [{ sku: 'CUA-N', values: ['Negro'], ml: { price: 100, stock: 5 } }]
    },
    picMap
  );
  assert.deepEqual(
    items[0].attributes.find((a) => a.id === 'COLOR'),
    { id: 'COLOR', value_id: '52049' }
  );
});

test('buildMlItems: eje mapeado pero el valor NO matchea ninguna opción → value_name (sin inventar un value_id)', () => {
  const items = buildMlItems(
    {
      ml: { ...mlBase, mapping_mode: 'one_per_variant' },
      axes: [{ name: 'Color', mlAttributeId: 'COLOR', allowedValues: [{ id: '52049', name: 'Negro' }] }],
      variants: [{ sku: 'CUA-B', values: ['Bordó'], ml: { price: 100, stock: 5 } }]
    },
    picMap
  );
  assert.deepEqual(
    items[0].attributes.find((a) => a.id === 'COLOR'),
    { id: 'COLOR', value_name: 'Bordó' }
  );
});

test('buildMlItems: matchea el valor ignorando mayúsculas/acentos', () => {
  const items = buildMlItems(
    {
      ml: { ...mlBase, mapping_mode: 'one_per_variant' },
      axes: [{ name: 'Color', mlAttributeId: 'COLOR', allowedValues: [{ id: '9', name: 'Bordó' }] }],
      variants: [{ sku: 'CUA-B', values: ['BORDO'], ml: { price: 100, stock: 5 } }]
    },
    picMap
  );
  assert.deepEqual(items[0].attributes.find((a) => a.id === 'COLOR'), { id: 'COLOR', value_id: '9' });
});

test('buildMlItems: eje SIN mapear manda un atributo personalizado ({name}, sin id de categoría)', () => {
  const items = buildMlItems(
    {
      ml: { ...mlBase, mapping_mode: 'one_per_variant' },
      axes: [{ name: 'Estampado' }],
      variants: [{ sku: 'CUA-F', values: ['Flores'], ml: { price: 100, stock: 5 } }]
    },
    picMap
  );
  assert.deepEqual(
    items[0].attributes.find((a) => a.value_name === 'Flores'),
    { name: 'Estampado', value_name: 'Flores' }
  );
});

test('buildMlItems: el atributo mapeado a un eje NO se duplica si también viene en la lista general de atributos', () => {
  const items = buildMlItems(
    {
      ml: {
        ...mlBase,
        mapping_mode: 'one_per_variant',
        attributes: [...mlBase.attributes, { id: 'COLOR', value_name: 'Este no debería usarse' }]
      },
      axes: [{ name: 'Color', mlAttributeId: 'COLOR', allowedValues: [] }],
      variants: [{ sku: 'CUA-N', values: ['Negro'], ml: { price: 100, stock: 5 } }]
    },
    picMap
  );
  const colorAttrs = items[0].attributes.filter((a) => a.id === 'COLOR');
  assert.equal(colorAttrs.length, 1);
  assert.equal(colorAttrs[0].value_name, 'Negro');
});

/* ───────────────── TN: attributes de producto + mpn/age_group/gender ───────────────── */

test('buildTnProducts (single_with_variants): manda attributes (nombres de eje) a nivel producto', () => {
  const products = buildTnProducts({
    tn: {
      ...tnBase,
      attributes: [{ es: 'Color' }],
      mapping_mode: 'single_with_variants',
      variants: [{ sku: 'CUA-N', values: [{ es: 'Negro' }], price: 100, stock: 5 }]
    },
    variants: [{ sku: 'CUA-N', values: ['Negro'] }]
  });
  assert.deepEqual(products[0].attributes, [{ es: 'Color' }]);
  // Y el valor de la variante queda LIMPIO (sin el nombre del eje adentro, ver CLAUDE.md).
  assert.deepEqual(products[0].variants[0].values, [{ es: 'Negro' }]);
});

test('buildTnProducts (one_per_variant): NO manda attributes a nivel producto (un producto = una sola variante)', () => {
  const products = buildTnProducts({
    tn: {
      ...tnBase,
      attributes: [{ es: 'Color' }],
      mapping_mode: 'one_per_variant',
      variants: [{ sku: 'CUA-N', values: [{ es: 'Negro' }], price: 100, stock: 5 }]
    },
    variants: [{ sku: 'CUA-N', values: ['Negro'] }]
  });
  assert.equal(products[0].attributes, undefined);
});

test('buildTnProducts: mpn/age_group/gender viajan por variante (Instagram/Google Shopping)', () => {
  const products = buildTnProducts({
    tn: {
      ...tnBase,
      mapping_mode: 'single_with_variants',
      variants: [{ sku: 'CUA-N', values: [{ es: 'Negro' }], price: 100, stock: 5, mpn: 'MPN-1', age_group: 'adult', gender: 'unisex' }]
    },
    variants: [{ sku: 'CUA-N', values: ['Negro'] }]
  });
  const v = products[0].variants[0];
  assert.equal(v.mpn, 'MPN-1');
  assert.equal(v.age_group, 'adult');
  assert.equal(v.gender, 'unisex');
});

test('buildTnProducts (simple, sin variantes): mpn/age_group/gender también aplican al producto simple', () => {
  const products = buildTnProducts({
    tn: { ...tnBase, variants: [{ mpn: 'MPN-X', age_group: 'kids', gender: 'female' }] },
    variants: []
  });
  const v = products[0].variants[0];
  assert.equal(v.mpn, 'MPN-X');
  assert.equal(v.age_group, 'kids');
  assert.equal(v.gender, 'female');
});

/* ───────────────── TN: descripción como HTML (respeta párrafos) ───────────────── */

test('buildTnProducts: convierte la descripción de texto plano a HTML con párrafos', () => {
  const products = buildTnProducts({
    tn: { ...tnBase, description: { es: 'Primer párrafo.\n\nSegundo párrafo.' } },
    variants: []
  });
  assert.deepEqual(products[0].description, { es: '<p>Primer párrafo.</p><p>Segundo párrafo.</p>' });
});

test('buildTnProducts: si la descripción ya trae HTML, la deja pasar tal cual', () => {
  const html = '<p>Ya con <strong>formato</strong></p>';
  const products = buildTnProducts({ tn: { ...tnBase, description: { es: html } }, variants: [] });
  assert.deepEqual(products[0].description, { es: html });
});

test('buildTnProducts: la descripción es un objeto por idioma ({es,pt}) — convierte CADA idioma presente', () => {
  const products = buildTnProducts({
    tn: { ...tnBase, description: { es: 'Uno.\n\nDos.', pt: 'Um.\n\nDois.' } },
    variants: []
  });
  assert.deepEqual(products[0].description, { es: '<p>Uno.</p><p>Dos.</p>', pt: '<p>Um.</p><p>Dois.</p>' });
});

test('buildTnProducts: sin descripción, no rompe (queda undefined)', () => {
  const { description, ...tnSinDescripcion } = tnBase;
  const products = buildTnProducts({ tn: tnSinDescripcion, variants: [] });
  assert.equal(products[0].description, undefined);
});

/* ───────────────── unidades de publicación (worker en background) ───────────────── */

test('mlUnitKey: el SKU (SELLER_SKU) de un ítem armado por buildMlItems', () => {
  const items = buildMlItems(
    { ml: { ...mlBase, mapping_mode: 'one_per_variant' }, axes: [{ name: 'Color' }], variants: [{ sku: 'CUA-N', values: ['Negro'], ml: { price: 100, stock: 5 } }] },
    picMap
  );
  assert.equal(mlUnitKey(items[0]), 'CUA-N');
});

test('mlUnitKey: sin SELLER_SKU (legacy single_with_variants, un solo ítem) da string vacío', () => {
  const items = buildMlItems(
    { ml: { ...mlBase, mapping_mode: 'single_with_variants' }, axes: [{ name: 'Color' }], variants: [{ sku: 'CUA-1-N', values: ['Negro'], ml: { price: 100, stock: 5 } }] },
    picMap
  );
  assert.equal(mlUnitKey(items[0]), '');
});

test('planTnUnits (single_with_variants): UNA sola unidad con unitKey vacío (aunque tenga varias variantes adentro)', () => {
  const units = planTnUnits({
    tn: { ...tnBase, mapping_mode: 'single_with_variants', image_ids: ['g1', 'g2'], variants: [{ sku: 'CUA-N', values: [{ es: 'Negro' }], price: 100, stock: 5 }] },
    variants: [{ sku: 'CUA-N', values: ['Negro'], tn: { image_ids: ['g1'] } }]
  });
  assert.equal(units.length, 1);
  assert.equal(units[0].unitKey, '');
  assert.deepEqual(units[0].uploadIds, ['g1', 'g2']); // comparte la galería general
});

test('planTnUnits (one_per_variant): una unidad POR VARIANTE, unitKey = su SKU, fotos en SU propio orden', () => {
  const units = planTnUnits({
    tn: {
      ...tnBase,
      mapping_mode: 'one_per_variant',
      image_ids: ['g1', 'g2', 'g3'],
      variants: [
        { sku: 'CUA-N', values: [{ es: 'Negro' }], price: 100, stock: 5 },
        { sku: 'CUA-R', values: [{ es: 'Rojo' }], price: 110, stock: 3 }
      ]
    },
    variants: [
      { sku: 'CUA-N', values: ['Negro'], tn: { image_ids: ['g2', 'g1'] } }, // orden propio: g2 primero (portada)
      { sku: 'CUA-R', values: ['Rojo'], tn: { image_ids: ['g3'] } }
    ]
  });
  assert.equal(units.length, 2);
  assert.equal(units[0].unitKey, 'CUA-N');
  assert.deepEqual(units[0].uploadIds, ['g2', 'g1']);
  assert.equal(units[1].unitKey, 'CUA-R');
  assert.deepEqual(units[1].uploadIds, ['g3']);
});
