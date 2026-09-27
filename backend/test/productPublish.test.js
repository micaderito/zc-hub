/**
 * Tests de los builders de fan-out (buildMlItems / buildTnProducts): funciones puras que
 * transforman el payload del front en los bodies de cada API según el modo de mapeo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMlItems, buildTnProducts, mlUnitKey, planTnUnits, sanitizeMlAttributeValues, mlDroppedAttributes } from '../src/services/productPublish.js';

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

test('buildMlItems: un paquete finito (alto < 3 cm) igual manda sus 4 medidas', () => {
  // Bug: había un mínimo inventado (dim ≥ 3 cm, peso ≥ 50 g) y el paquete era todo-o-nada: un
  // cuaderno de 2 cm de alto se publicaba SIN ninguna medida de paquete, en silencio.
  const items = buildMlItems(
    { ml: { ...mlBase }, axes: [], variants: [], common: { lengthCm: 30, widthCm: 22, heightCm: 1.5, weightG: 40 } },
    picMap
  );
  const val = (id) => items[0].attributes.find((a) => a.id === id)?.value_name;
  assert.equal(val('SELLER_PACKAGE_LENGTH'), '30 cm');
  assert.equal(val('SELLER_PACKAGE_WIDTH'), '22 cm');
  assert.equal(val('SELLER_PACKAGE_HEIGHT'), '2 cm'); // redondea para ARRIBA: nunca achica el paquete
  assert.equal(val('SELLER_PACKAGE_WEIGHT'), '40 g');
});

test('buildMlItems: manda las medidas de paquete que haya aunque falte alguna, y omite las vacías/0', () => {
  const items = buildMlItems(
    { ml: { ...mlBase }, axes: [], variants: [], common: { lengthCm: 30, widthCm: null, heightCm: 0, weightG: 480 } },
    picMap
  );
  const ids = items[0].attributes.map((a) => a.id).filter((id) => String(id).startsWith('SELLER_PACKAGE_'));
  assert.deepEqual(ids.sort(), ['SELLER_PACKAGE_LENGTH', 'SELLER_PACKAGE_WEIGHT']);
});

test('buildMlItems (one_per_variant): cada publicación lleva las medidas del paquete', () => {
  const items = buildMlItems(
    {
      ml: { ...mlBase, mapping_mode: 'one_per_variant' },
      axes: [{ name: 'Color' }],
      variants: [
        { sku: 'A', values: ['Rojo'], ml: { price: 1, stock: 1 } },
        { sku: 'B', values: ['Azul'], ml: { price: 1, stock: 1 } }
      ],
      common: { lengthCm: 30, widthCm: 22, heightCm: 1, weightG: 300 }
    },
    picMap,
    { userProducts: true }
  );
  for (const it of items) assert.ok(it.attributes.some((a) => a.id === 'SELLER_PACKAGE_HEIGHT' && a.value_name === '1 cm'));
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

test('buildMlItems: respeta un UNITS_PER_PACK válido que ya mandó el usuario', () => {
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

test('buildMlItems: normaliza un UNITS_PER_PACK inválido (vacío / value_id espurio) a 1', () => {
  const conValueId = buildMlItems(
    {
      ml: {
        ...mlBase,
        // borrador migrado: quedó con un value_id que ML rechaza para un atributo numérico
        attributes: [...mlBase.attributes, { id: 'SALE_FORMAT', value_id: '1359391' }, { id: 'UNITS_PER_PACK', value_id: '1359391' }]
      },
      axes: [],
      variants: []
    },
    picMap
  );
  const a1 = conValueId[0].attributes.filter((a) => a.id === 'UNITS_PER_PACK');
  assert.equal(a1.length, 1);
  assert.deepEqual(a1[0], { id: 'UNITS_PER_PACK', value_name: '1' });

  const vacio = buildMlItems(
    { ml: { ...mlBase, attributes: [...mlBase.attributes, { id: 'SALE_FORMAT', value_id: '1359391' }, { id: 'UNITS_PER_PACK', value_name: '' }] }, axes: [], variants: [] },
    picMap
  );
  assert.deepEqual(
    vacio[0].attributes.find((a) => a.id === 'UNITS_PER_PACK'),
    { id: 'UNITS_PER_PACK', value_name: '1' }
  );
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

test('planTnUnits: producto SIMPLE (sin variantes) sube la galería general en cualquier modo', () => {
  // Bug: con `one_per_variant` y sin variantes, buscaba las fotos en `variants[0]` (inexistente)
  // y el producto de TN se creaba sin ninguna foto.
  for (const mapping_mode of ['one_per_variant', 'single_with_variants']) {
    const units = planTnUnits({
      tn: { ...tnBase, mapping_mode, image_ids: ['g1', 'g2'], variants: [{ sku: 'CUA-1' }], base_price: 100, base_stock: 5 },
      variants: []
    });
    assert.equal(units.length, 1, mapping_mode);
    assert.equal(units[0].unitKey, '', mapping_mode);
    assert.deepEqual(units[0].uploadIds, ['g1', 'g2'], mapping_mode);
    assert.deepEqual(units[0].forVariants, [], mapping_mode);
  }
});

/* ---------- sanitizeMlAttributeValues: value_id que ML no puede aceptar ---------- */

/**
 * Atributos reales de MLA40513 (Agendas y Diarios Íntimos), recortados: `YEAR` es `number` y NO
 * trae `values[]`, así que cualquier `value_id` sobre él es inválido para `POST /items`.
 */
const catAttrs = [
  { id: 'YEAR', name: 'Año', value_type: 'number' },
  { id: 'SALE_FORMAT', name: 'Formato de venta', value_type: 'list', values: [{ id: '1359391', name: 'Unidad' }, { id: '1359392', name: 'Pack' }] }
];

test('sanitizeMlAttributeValues: un value_id sobre un atributo sin lista cerrada cae a value_name', () => {
  const out = sanitizeMlAttributeValues([{ id: 'YEAR', value_id: '7967741', value_name: '2027' }], catAttrs);
  assert.deepEqual(out, [{ id: 'YEAR', value_name: '2027' }]);
});

test('sanitizeMlAttributeValues: sin value_name que rescatar, el atributo inválido se descarta', () => {
  const out = sanitizeMlAttributeValues([{ id: 'YEAR', value_id: '7967741' }, { id: 'BRAND', value_name: 'ZC' }], catAttrs);
  assert.deepEqual(out, [{ id: 'BRAND', value_name: 'ZC' }]);
});

test('sanitizeMlAttributeValues: un value_id que SÍ está en la lista de la categoría sobrevive', () => {
  const attrs = [{ id: 'SALE_FORMAT', value_id: '1359391' }];
  assert.deepEqual(sanitizeMlAttributeValues(attrs, catAttrs), attrs);
});

test('sanitizeMlAttributeValues: un value_id que no está en la lista cerrada también se sanea', () => {
  const out = sanitizeMlAttributeValues([{ id: 'SALE_FORMAT', value_id: '999', value_name: 'Unidad' }], catAttrs);
  assert.deepEqual(out, [{ id: 'SALE_FORMAT', value_name: 'Unidad' }]);
});

test('sanitizeMlAttributeValues: no opina sobre atributos que la categoría no declara', () => {
  const attrs = [{ id: 'CUSTOM_X', value_id: 'abc' }];
  assert.deepEqual(sanitizeMlAttributeValues(attrs, catAttrs), attrs);
});

test('sanitizeMlAttributeValues: fail-open — sin definición de la categoría no toca nada', () => {
  const attrs = [{ id: 'YEAR', value_id: '7967741' }];
  assert.deepEqual(sanitizeMlAttributeValues(attrs, null), attrs);
  assert.deepEqual(sanitizeMlAttributeValues(attrs, []), attrs);
});

test('sanitizeMlAttributeValues: deja pasar tal cual lo que ya viene por value_name', () => {
  const attrs = [{ id: 'YEAR', value_name: '2027' }, { id: 'SELLER_SKU', value_name: 'CUA-1' }];
  assert.deepEqual(sanitizeMlAttributeValues(attrs, catAttrs), attrs);
});

/* ---------- number_unit: un número pelado lleva la unidad por defecto de la categoría ---------- */

const catDims = [
  { id: 'WIDTH', name: 'Ancho', value_type: 'number_unit', default_unit: 'cm', allowed_units: [{ id: 'cm', name: 'cm' }] },
  { id: 'LENGTH', name: 'Largo', value_type: 'number_unit', default_unit: 'cm', allowed_units: [{ id: 'cm', name: 'cm' }, { id: 'mm', name: 'mm' }] },
  { id: 'SHEETS_NUMBER', name: 'Cantidad de hojas', value_type: 'number' }
];

test('sanitizeMlAttributeValues: number_unit sin unidad ("20") sale con la unidad por defecto ("20 cm")', () => {
  // Bug: ML descarta en silencio un number_unit sin unidad — "Ancho: 20" no aparecía en la publicación.
  const out = sanitizeMlAttributeValues(
    [{ id: 'WIDTH', value_name: '20' }, { id: 'LENGTH', value_name: '29,7' }, { id: 'SHEETS_NUMBER', value_name: '80' }],
    catDims
  );
  assert.deepEqual(out, [
    { id: 'WIDTH', value_name: '20 cm' },
    { id: 'LENGTH', value_name: '29.7 cm' },
    { id: 'SHEETS_NUMBER', value_name: '80' } // `number` no lleva unidad
  ]);
});

test('sanitizeMlAttributeValues: number_unit que ya trae unidad se respeta (con o sin espacio)', () => {
  const out = sanitizeMlAttributeValues([{ id: 'LENGTH', value_name: '297 mm' }, { id: 'WIDTH', value_name: '21cm' }], catDims);
  assert.deepEqual(out, [{ id: 'LENGTH', value_name: '297 mm' }, { id: 'WIDTH', value_name: '21 cm' }]);
});

test('medidas: ML recibe Largo/Ancho/Grosor como paquete y el backend pasa las de TN tal cual las arma el front', () => {
  const common = { lengthCm: 20, widthCm: 15, heightCm: 1, weightG: 300 };
  const ml = buildMlItems({ ml: { ...mlBase }, axes: [], variants: [], common }, picMap)[0].attributes;
  const val = (id) => ml.find((a) => a.id === id)?.value_name;
  assert.equal(val('SELLER_PACKAGE_LENGTH'), '20 cm');
  assert.equal(val('SELLER_PACKAGE_WIDTH'), '15 cm');
  assert.equal(val('SELLER_PACKAGE_HEIGHT'), '1 cm');
  const tn = buildTnProducts({
    tn: { ...tnBase, base_price: 100, base_stock: 1, variants: [{ sku: 'X', depth: 20, width: 15, height: 1, weight: 0.3 }] },
    variants: []
  })[0].variants[0];
  assert.equal(tn.depth, '20.00');
  assert.equal(tn.width, '15.00');
  assert.equal(tn.height, '1.00');
  assert.equal(tn.weight, '0.30');
});

test('mlDroppedAttributes: detecta lo mandado con valor que ML no devolvió en el ítem creado', () => {
  const sent = [
    { id: 'PAPER_HEIGHT', value_name: '21 cm' },
    { id: 'PAPER_THICKNESS', value_name: '80 g' },
    { id: 'PAPER_SIZE', value_id: '93218' },
    { id: 'SHEET_TYPE', value_name: '' }
  ];
  const created = {
    id: 'MLA1',
    attributes: [
      { id: 'PAPER_HEIGHT', value_name: '21 cm' },
      { id: 'PAPER_SIZE', value_id: null, value_name: null }
    ],
    warnings: [{ code: 'item.attributes.invalid', message: 'Attribute PAPER_THICKNESS was dropped' }, 'otro aviso']
  };
  const { missing, warnings } = mlDroppedAttributes(sent, created);
  assert.deepEqual(missing, ['PAPER_THICKNESS', 'PAPER_SIZE']);
  assert.deepEqual(warnings, ['Attribute PAPER_THICKNESS was dropped', 'otro aviso']);
});

test('mlDroppedAttributes: sin diferencias ni warnings devuelve listas vacías', () => {
  const sent = [{ id: 'PAPER_WIDTH', value_name: '14.8 cm' }];
  assert.deepEqual(mlDroppedAttributes(sent, { attributes: [{ id: 'PAPER_WIDTH', value_name: '14.8 cm' }] }), { missing: [], warnings: [] });
  assert.deepEqual(mlDroppedAttributes(undefined, null), { missing: [], warnings: [] });
});

for (const [mode, userProducts] of [['single_with_variants', true], ['one_per_variant', true], ['single_with_variants', false]]) {
  test(`variantes (${mode}, ${userProducts ? 'User Products' : 'legacy'}): las medidas viajan en cada ítem y el diff no marca eje ni SKU como descartados`, () => {
    const attributes = [...mlBase.attributes, { id: 'PAPER_HEIGHT', value_name: '21 cm' }, { id: 'PAPER_THICKNESS', value_name: '90 g' }];
    const items = buildMlItems(
      {
        ml: { ...mlBase, mapping_mode: mode, attributes },
        axes: [{ name: 'Color', mlAttributeId: 'COLOR' }],
        variants: [
          { sku: 'A', values: ['Rojo'], ml: { price: 1, stock: 1 } },
          { sku: 'B', values: ['Azul'], ml: { price: 1, stock: 1 } }
        ]
      },
      picMap,
      { userProducts }
    );
    assert.equal(items.length, userProducts ? 2 : 1);
    for (const it of items) {
      assert.ok(it.attributes.some((a) => a.id === 'PAPER_HEIGHT' && a.value_name === '21 cm'));
      assert.ok(it.attributes.some((a) => a.id === 'PAPER_THICKNESS' && a.value_name === '90 g'));
      // ML devuelve lo mismo que se mandó (eco): nada tiene que figurar como descartado.
      assert.deepEqual(mlDroppedAttributes(it.attributes, { attributes: it.attributes }).missing, []);
    }
  });
}

test('"No aplica": sanitize lo deja pasar normalizado (value_name null) y lo saca de un atributo de variantes', (t) => {
  t.mock.method(console, 'warn', () => {});
  const defs = [
    { id: 'SHEET_TYPE', value_type: 'string', values: [{ id: '2350959', name: 'Rayada' }] },
    { id: 'PAPER_THICKNESS', value_type: 'number_unit', default_unit: 'g' },
    { id: 'COLOR', value_type: 'list', tags: { allow_variations: true }, values: [{ id: '52049', name: 'Negro' }] }
  ];
  const out = sanitizeMlAttributeValues(
    [
      { id: 'SHEET_TYPE', value_id: '-1', value_name: 'basura' },
      { id: 'PAPER_THICKNESS', value_id: '-1', value_name: null },
      { id: 'COLOR', value_id: '-1', value_name: null }
    ],
    defs
  );
  assert.deepEqual(out, [
    { id: 'SHEET_TYPE', value_id: '-1', value_name: null },
    { id: 'PAPER_THICKNESS', value_id: '-1', value_name: null }
  ]);
});

test('"No aplica" en SALE_FORMAT no dispara UNITS_PER_PACK', () => {
  const items = buildMlItems(
    { ml: { ...mlBase, attributes: [...mlBase.attributes, { id: 'SALE_FORMAT', value_id: '-1', value_name: null }] }, axes: [], variants: [] },
    picMap
  );
  assert.equal(items[0].attributes.some((a) => a.id === 'UNITS_PER_PACK'), false);
});

test('mlDroppedAttributes: un "No aplica" que ML no devuelve no cuenta como descartado', () => {
  const sent = [{ id: 'SHEET_TYPE', value_id: '-1', value_name: null }, { id: 'PAPER_SIZE', value_id: '93218' }];
  assert.deepEqual(mlDroppedAttributes(sent, { attributes: [{ id: 'PAPER_SIZE', value_id: '93218' }] }).missing, []);
});

for (const [mode, userProducts] of [['single_with_variants', true], ['one_per_variant', true], ['single_with_variants', false]]) {
  test(`variantes (${mode}, ${userProducts ? 'User Products' : 'legacy'}): un "No aplica" viaja en cada ítem sin tocar el eje`, () => {
    const attributes = [...mlBase.attributes, { id: 'SHEET_TYPE', value_id: '-1', value_name: null }];
    const items = buildMlItems(
      {
        ml: { ...mlBase, mapping_mode: mode, attributes },
        axes: [{ name: 'Color', mlAttributeId: 'COLOR' }],
        variants: [
          { sku: 'A', values: ['Rojo'], ml: { price: 1, stock: 1 } },
          { sku: 'B', values: ['Azul'], ml: { price: 1, stock: 1 } }
        ]
      },
      picMap,
      { userProducts }
    );
    for (const it of items) {
      assert.deepEqual(it.attributes.find((a) => a.id === 'SHEET_TYPE'), { id: 'SHEET_TYPE', value_id: '-1', value_name: null });
    }
    if (userProducts) {
      assert.deepEqual(items.map((it) => it.attributes.find((a) => a.id === 'COLOR')?.value_name), ['Rojo', 'Azul']);
    }
  });
}
