/**
 * Tests de services/publicationImport.js: cómo se convierten publicaciones reales de ML/TN en el
 * borrador del form de edición (buildEditDraft, puro) y la lectura en vivo (importHubProduct).
 */
import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const state = { catalog: { mlRows: [], tnRows: [] }, items: {}, descs: {}, products: {}, itemStatus: {} };
let buildEditDraft, importHubProduct, checkRemoteChanges;

before(async () => {
  mock.module('../src/store.js', {
    exports: { tokens: { tiendanube: { access_token: 'tn', store_id: 1 } }, getMlToken: async () => 'ml' },
  });
  mock.module('../src/services/conflictsService.js', { exports: { getCatalogRows: async () => state.catalog } });
  mock.module('../src/lib/mercadolibre.js', {
    exports: {
      getItemOrStatus: async (_t, id) => (state.items[id] ? { item: state.items[id], status: 200 } : { item: null, status: state.itemStatus[id] ?? 404 }),
      getItemDescription: async (_t, id) => (id in state.descs ? state.descs[id] : ''),
      getCategory: async () => ({ name: 'Cuadernos' }),
      getItems: async (_t, ids) => ids.map((id) => state.items[id]).filter(Boolean),
    },
  });
  mock.module('../src/lib/tiendanube.js', {
    exports: { getProduct: async (_t, _s, id) => state.products[id] ?? null },
  });
  ({ buildEditDraft, importHubProduct, checkRemoteChanges } = await import('../src/services/publicationImport.js'));
});

beforeEach(() => {
  state.catalog = { mlRows: [], tnRows: [] };
  state.items = {};
  state.descs = {};
  state.products = {};
  state.itemStatus = {};
});

/** Publi clásica de ML con 2 colores (variations[]) + 2 productos de TN (uno por color). */
function legacyFixture() {
  const item = {
    id: 'MLA1', title: 'Cuaderno Rivadavia A4', category_id: 'MLA1234', listing_type_id: 'gold_pro', condition: 'new',
    sold_quantity: 37, last_updated: '2026-10-01T10:00:00Z', currency_id: 'ARS',
    shipping: { mode: 'me2', free_shipping: true, local_pick_up: false },
    sale_terms: [{ id: 'WARRANTY_TYPE', value_name: 'Garantía del vendedor' }, { id: 'WARRANTY_TIME', value_name: '30 días' }],
    pictures: [{ id: 'P1', secure_url: 'https://ml/p1.jpg' }, { id: 'P2', secure_url: 'https://ml/p2.jpg' }],
    attributes: [
      { id: 'BRAND', name: 'Marca', value_name: 'Rivadavia' },
      { id: 'SHEET_TYPE', name: 'Tipo de hoja', value_id: '123', value_name: 'Rayada' },
      { id: 'SELLER_PACKAGE_LENGTH', name: 'Largo', value_name: '30 cm', value_struct: { number: 30, unit: 'cm' } },
      { id: 'SELLER_PACKAGE_WEIGHT', name: 'Peso', value_name: '0.6 kg', value_struct: { number: 0.6, unit: 'kg' } },
      { id: 'COVER', name: 'Tapa', value_id: '-1', value_name: null },
    ],
    variations: [
      { id: 11, price: 8990, available_quantity: 3, sold_quantity: 20, picture_ids: ['P1'], attribute_combinations: [{ id: 'COLOR', name: 'Color', value_id: '1', value_name: 'Rojo' }], attributes: [{ id: 'SELLER_SKU', value_name: 'RIV-ROJ' }] },
      { id: 12, price: 8990, available_quantity: 8, sold_quantity: 0, picture_ids: ['P2'], attribute_combinations: [{ id: 'COLOR', name: 'Color', value_id: '2', value_name: 'Azul' }], attributes: [{ id: 'SELLER_SKU', value_name: 'RIV-AZU' }] },
    ],
  };
  const tnP = (id, color, sku, stock) => ({
    id, name: { es: `Cuaderno Rivadavia A4 ${color}` }, description: { es: '<p>Tapa dura</p>' }, categories: [{ id: 5 }], brand: 'Rivadavia',
    updated_at: '2026-10-02T10:00:00Z', images: [{ id: id * 10, src: `http://tn/${id}.jpg` }],
    variants: [{ id: id + 1000, sku, price: '7990.00', stock, values: [], barcode: '779', weight: '0.6', height: '30', width: '21', depth: '2', age_group: 'adult', gender: 'unisex' }],
  });
  return { item, tnProducts: [tnP(1, 'Rojo', 'RIV-ROJ', 5), tnP(2, 'Azul', 'RIV-AZU', 8)] };
}

test('publi clásica con variaciones ↔ un producto de TN por color: modos, ejes, variantes unidas por SKU y fotos remotas', () => {
  const { item, tnProducts } = legacyFixture();
  const { draft, refs, locks, notes } = buildEditDraft({ mlItems: [item], mlDescriptions: { MLA1: 'Texto ML' }, tnProducts, categoryName: 'Cuadernos' });

  assert.equal(draft.ml.mappingMode, 'single_with_variants');
  assert.equal(draft.tn.mappingMode, 'one_per_variant');
  assert.deepEqual(draft.axes, [{ name: 'Color', mlAttributeId: 'COLOR' }]);
  assert.equal(draft.variants.length, 2);
  const [rojo, azul] = draft.variants;
  assert.deepEqual(rojo.values, ['Rojo']);
  assert.equal(rojo.sku, 'RIV-ROJ');
  assert.equal(rojo.stock, 3, 'el stock es el de ML');
  assert.equal(rojo.ml.price, 8990);
  assert.equal(rojo.tn.price, 7990);
  assert.deepEqual(rojo.ml.pictureIds, ['ml-P1']);
  assert.deepEqual(rojo.tn.imageIds, ['tn-10'], 'en "uno por variante" las fotos de TN son las del producto');
  assert.deepEqual(rojo.titles.tn, { inherited: false, value: 'Cuaderno Rivadavia A4 Rojo' });
  assert.equal(azul.barcode, '779');

  assert.equal(draft.common.baseName, 'Cuaderno Rivadavia A4');
  assert.equal(draft.common.brand, 'Rivadavia');
  assert.equal(draft.common.lengthCm, 30);
  assert.equal(draft.common.weightG, 600, 'kg → g');
  assert.equal(draft.common.widthCm, 21, 'sin dato de ML cae al de TN');
  assert.equal(draft.ml.listingType, 'gold_pro');
  assert.equal(draft.ml.freeShipping, true);
  assert.equal(draft.ml.warrantyTime, '30 días');
  assert.deepEqual(draft.ml.description, { inherited: false, value: 'Texto ML' });
  assert.deepEqual(draft.tn.description, { inherited: false, value: '<p>Tapa dura</p>' });
  assert.deepEqual(draft.tn.categories, [5]);
  assert.equal(draft.ml.categoryName, 'Cuadernos');

  // Características: sin las que el form maneja aparte (paquete) y con el "No aplica" respetado.
  const ids = draft.ml.attributes.map((a) => a.id);
  assert.ok(ids.includes('SHEET_TYPE'));
  assert.ok(!ids.includes('SELLER_PACKAGE_LENGTH'));
  assert.equal(draft.ml.attributes.find((a) => a.id === 'COVER').notApplicable, true);
  assert.equal(draft.ml.attributes.find((a) => a.id === 'SHEET_TYPE').valueId, '123');

  assert.deepEqual(draft.ml.images.map((i) => i.id), ['ml-P1', 'ml-P2']);
  assert.equal(draft.ml.images[0].remote.url, 'https://ml/p1.jpg');
  assert.equal(draft.tn.images[0].previewUrl, 'https://tn/1.jpg', 'http → https');

  assert.deepEqual(refs.variants.v1, { ml: { itemId: 'MLA1', variationId: '11', soldQuantity: 20 }, tn: { productId: 1, variantId: 1001 } });
  assert.equal(refs.ml.items[0].lastUpdated, '2026-10-01T10:00:00Z');
  assert.equal(refs.ml.items[0].format, 'legacy');
  assert.ok(locks.mlTitle.includes('37'), 'con ventas el título queda bloqueado');
  assert.ok(locks.condition);
  assert.ok(locks.mlCategory);
  assert.ok(notes.some((n) => n.includes('stock distinto')), 'Rojo tenía 3 en ML y 5 en TN');
});

test('ficha de User Products (un ítem por color) ↔ un producto de TN con variantes', () => {
  const upItem = (id, color, sku, sold) => ({
    id, title: `Agenda 2027 ${color}`, family_name: 'Agenda 2027 Mooving', user_product_id: `MLAU${id}`, domain_id: 'MLA-AGENDAS',
    category_id: 'MLA9', listing_type_id: 'gold_special', condition: 'new', price: 15490, available_quantity: 4, sold_quantity: sold,
    pictures: [{ id: `${id}-a`, secure_url: `https://ml/${id}.jpg` }],
    attributes: [{ id: 'BRAND', value_name: 'Mooving' }, { id: 'COLOR', name: 'Color', value_name: color }, { id: 'SELLER_SKU', value_name: sku }],
  });
  const tnProduct = {
    id: 9, name: { es: 'Agenda 2027 semanal Mooving' }, attributes: [{ es: 'Color' }], images: [{ id: 1, src: 'https://tn/1.jpg' }, { id: 2, src: 'https://tn/2.jpg' }],
    variants: [
      { id: 91, sku: 'LIL', price: '13990', stock: 4, values: [{ es: 'Lila' }], image_id: 2 },
      { id: 92, sku: 'CEL', price: '13990', stock: 4, values: [{ es: 'Celeste' }] },
    ],
  };
  const { draft, locks, refs } = buildEditDraft({ mlItems: [upItem('MLA1', 'Lila', 'LIL', 0), upItem('MLA2', 'Celeste', 'CEL', 0)], tnProducts: [tnProduct] });
  assert.equal(draft.ml.mappingMode, 'one_per_variant');
  assert.equal(draft.tn.mappingMode, 'single_with_variants');
  assert.deepEqual(draft.axes, [{ name: 'Color', mlAttributeId: 'COLOR' }], 'el eje es el atributo que cambia entre ítems de la ficha');
  assert.deepEqual(draft.variants.map((v) => v.values[0]), ['Lila', 'Celeste']);
  assert.deepEqual(draft.variants[0].tn.imageIds, ['tn-2'], 'con TN de un solo producto, la foto de la variante es su image_id');
  assert.deepEqual(draft.variants[0].titles.ml, { inherited: false, value: 'Agenda 2027 Lila' });
  assert.equal(draft.common.baseName, 'Agenda 2027 semanal Mooving');
  assert.ok(locks.mlTitle.includes('ficha'), 'en una ficha el título lo arma ML');
  assert.equal(refs.ml.items[1].format, 'up');
  assert.equal(refs.ml.items[1].userProductId, 'MLAU' + 'MLA2');
});

test('varios ítems sueltos de ML (sin ficha) ↔ 1 producto de TN con variantes: el nombre de cada variante sale de TN', () => {
  const item = (id, sku) => ({ id, title: `Repuesto A4 ${sku}`, price: 100, available_quantity: 5, pictures: [], attributes: [{ id: 'SELLER_SKU', value_name: sku }] });
  const product = {
    id: 4, name: { es: 'Repuesto A4' }, attributes: [{ es: 'Hoja' }], images: [],
    variants: [{ id: 41, sku: 'RAY', price: '90', stock: 5, values: [{ es: 'Rayada' }] }, { id: 42, sku: 'LIS', price: '90', stock: 5, values: [{ es: 'Lisa' }] }],
  };
  const { draft } = buildEditDraft({ mlItems: [item('MLA1', 'RAY'), item('MLA2', 'LIS')], tnProducts: [product] });
  assert.deepEqual(draft.axes, [{ name: 'Hoja' }]);
  assert.deepEqual(draft.variants.map((v) => v.values[0]), ['Rayada', 'Lisa']);
  assert.equal(draft.ml.mappingMode, 'one_per_variant');
});

test('producto simple: sin ejes ni variantes, con SKU, stock y precio base', () => {
  const item = { id: 'MLA5', title: 'Lapicera Bic x10', price: 5600, available_quantity: 18, sold_quantity: 0, pictures: [], attributes: [{ id: 'SELLER_SKU', value_name: 'BIC10' }] };
  const product = { id: 3, name: { es: 'Lapicera Bic x10' }, images: [], variants: [{ id: 31, sku: 'BIC10', price: '4990', stock: 18, values: [] }] };
  const { draft, refs, locks } = buildEditDraft({ mlItems: [item], tnProducts: [product] });
  assert.equal(draft.variants.length, 0);
  assert.equal(draft.axes.length, 0);
  assert.equal(draft.common.sku, 'BIC10');
  assert.equal(draft.common.baseStock, 18);
  assert.equal(draft.ml.basePrice, 5600);
  assert.equal(draft.tn.basePrice, 4990);
  assert.equal(refs.simple, true);
  assert.deepEqual(refs.base.tn, { productId: 3, variantId: 31 });
  assert.equal(locks.mlTitle, undefined, 'sin ventas el título se puede cambiar');
});

test('variante en un solo canal y canal faltante quedan avisados', () => {
  const { item } = legacyFixture();
  const { draft, notes } = buildEditDraft({ mlItems: [item], tnProducts: [] });
  assert.equal(draft.variants.length, 2);
  assert.ok(notes.some((n) => n.includes('no está publicado en Tienda Nube')));
  const { tnProducts } = legacyFixture();
  const r = buildEditDraft({ mlItems: [{ ...item, variations: [item.variations[0]] }], tnProducts });
  assert.ok(r.notes.some((n) => n.includes('"Azul" está en Tienda Nube pero no en Mercado Libre')));
});

test('importHubProduct lee en vivo las publicaciones del grupo', async () => {
  const { item, tnProducts } = legacyFixture();
  state.catalog = {
    mlRows: [{ itemId: 'MLA1', variationId: '11', sku: 'RIV-ROJ', stock: 3 }, { itemId: 'MLA1', variationId: '12', sku: 'RIV-AZU', stock: 8 }],
    tnRows: [{ productId: 1, variantId: 1001, sku: 'RIV-ROJ', stock: 5 }, { productId: 2, variantId: 1002, sku: 'RIV-AZU', stock: 8 }],
  };
  state.items.MLA1 = item;
  state.descs.MLA1 = 'Desc';
  state.products = { 1: tnProducts[0], 2: tnProducts[1] };
  const r = await importHubProduct('ml:MLA1');
  assert.equal(r.draft.variants.length, 2);
  assert.equal(r.draft.ml.categoryName, 'Cuadernos');
  assert.equal(r.group.key, 'ml:MLA1');
});

test('importHubProduct: grupo inexistente → 404; ML que no contesta → 502 (no arma una edición a medias)', async () => {
  await assert.rejects(importHubProduct('ml:NOPE'), (e) => e.status === 404);
  state.catalog = { mlRows: [{ itemId: 'MLA1', variationId: null, sku: 'X', stock: 1 }], tnRows: [] };
  state.itemStatus.MLA1 = 429;
  await assert.rejects(importHubProduct('ml:MLA1'), (e) => e.status === 502);
  state.itemStatus = {};
  state.items.MLA1 = { id: 'MLA1', title: 'X', attributes: [], pictures: [] };
  state.descs.MLA1 = null;
  await assert.rejects(importHubProduct('ml:MLA1'), (e) => e.status === 502 && e.message.includes('descripción'));
});

test('checkRemoteChanges avisa qué publicación cambió desde que se abrió la edición', async () => {
  state.items.MLA1 = { id: 'MLA1', last_updated: '2026-10-05T00:00:00Z' };
  state.products[1] = { id: 1, updated_at: '2026-10-02T10:00:00Z' };
  const changed = await checkRemoteChanges({
    ml: { items: [{ itemId: 'MLA1', lastUpdated: '2026-10-01T10:00:00Z', title: 'Cuaderno' }] },
    tn: { products: [{ productId: 1, updatedAt: '2026-10-02T10:00:00Z', name: 'Cuaderno TN' }] },
  });
  assert.deepEqual(changed, [{ channel: 'ml', id: 'MLA1', name: 'Cuaderno' }]);
});
