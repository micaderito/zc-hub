/**
 * Tests de services/publicationUpdate.js: cómo se aplica cada cambio de una edición en ML y TN.
 * Mockea los clientes de las APIs y registra cada llamada.
 */
import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const calls = [];
const state = { items: {}, products: {}, images: {}, catAttrs: [], failDeleteVariation: false, tnFindBySku: null, failKeys: new Set() };
const log = (name, ...args) => { calls.push([name, ...args]); };
const callsOf = (name) => calls.filter((c) => c[0] === name);

let runChannelOps, orderOps;

before(async () => {
  mock.module('../src/store.js', { exports: { tokens: { tiendanube: { access_token: 'tn', store_id: 1 } }, getMlToken: async () => 'ml' } });
  mock.module('../src/lib/mercadolibre.js', {
    exports: {
      getItemOrStatus: async (_t, id) => (state.items[id] ? { item: JSON.parse(JSON.stringify(state.items[id])), status: 200 } : { item: null, status: 404 }),
      updateItem: async (_t, id, body) => {
        if (state.failKeys.has(`updateItem:${id}`)) throw new Error('ML dijo que no');
        log('updateItem', id, body);
        return {};
      },
      setItemDescription: async (_t, id, text) => { log('setItemDescription', id, text); return { ok: true }; },
      setItemListingType: async (_t, id, lt) => log('setItemListingType', id, lt),
      addItemVariation: async (_t, id, v) => { log('addItemVariation', id, v); return { id: 999 }; },
      deleteItemVariation: async (_t, id, vid) => {
        log('deleteItemVariation', id, vid);
        if (state.failDeleteVariation) throw new Error('has_sales');
      },
      createItem: async (_t, body) => { log('createItem', body); return { id: 'MLA-NEW' }; },
      uploadPicture: async (_t, _buf, name) => { log('uploadPicture', name); return `UP-${callsOf('uploadPicture').length}`; },
      getCategoryAttributes: async () => state.catAttrs,
      mlVariationsBody: (item, overrides = {}) => (item?.variations || []).map((v) => (overrides[String(v.id)] ? { id: v.id, ...overrides[String(v.id)] } : { id: v.id })),
    },
  });
  mock.module('../src/lib/tiendanube.js', {
    exports: {
      getProduct: async (_t, _s, id) => (state.products[id] ? JSON.parse(JSON.stringify(state.products[id])) : null),
      getProductImages: async (_t, _s, id) => JSON.parse(JSON.stringify(state.products[id]?.images || [])),
      updateProduct: async (_t, _s, id, body) => log('tn.updateProduct', id, body),
      updateVariant: async (_t, _s, pid, vid, body) => log('tn.updateVariant', pid, vid, body),
      updateVariantSku: async (_t, _s, pid, vid, sku) => log('tn.updateVariantSku', pid, vid, sku),
      updateVariantImage: async (_t, _s, pid, vid, img) => log('tn.updateVariantImage', pid, vid, img),
      createVariant: async (_t, _s, pid, body) => { log('tn.createVariant', pid, body); return { id: 777 }; },
      deleteVariant: async (_t, _s, pid, vid) => log('tn.deleteVariant', pid, vid),
      deleteProduct: async (_t, _s, pid) => log('tn.deleteProduct', pid),
      createProduct: async (_t, _s, body) => { log('tn.createProduct', body); return { id: 555 }; },
      findProductBySku: async () => state.tnFindBySku,
      createProductImage: async (_t, _s, pid, body) => { log('tn.createProductImage', pid, body); return { id: 9000 + callsOf('tn.createProductImage').length }; },
      deleteProductImage: async (_t, _s, pid, id) => log('tn.deleteProductImage', pid, id),
      updateProductImagePosition: async (_t, _s, pid, id, pos) => log('tn.updateProductImagePosition', pid, id, pos),
    },
  });
  mock.module('../src/db.js', { exports: { enqueueMlTask: async (task) => { log('enqueueMlTask', task); return 42; } } });
  mock.module('../src/services/imageStore.js', {
    exports: {
      getImage: async (id) => (state.images[id] ? { buffer: Buffer.from('x'), filename: `${id}.jpg`, mime: 'image/jpeg' } : null),
      getImageUrl: async (id) => (state.images[id] ? `https://supa/${id}.jpg` : null),
    },
  });
  mock.module('../src/services/productPublish.js', {
    exports: {
      // Misma regla que productPublish.packageAttributes: cada medida con dato, redondeada para arriba.
      packageAttributes: (c) => [['SELLER_PACKAGE_LENGTH', c.lengthCm, 'cm'], ['SELLER_PACKAGE_WIDTH', c.widthCm, 'cm'], ['SELLER_PACKAGE_HEIGHT', c.heightCm, 'cm'], ['SELLER_PACKAGE_WEIGHT', c.weightG, 'g']]
        .filter(([, n]) => n != null && Number(n) > 0).map(([id, n, u]) => ({ id, value_name: `${Math.ceil(Number(n))} ${u}` })),
    },
  });
  mock.module('../src/services/conflictsService.js', { exports: { refreshMlItemInSnapshot: async () => {}, refreshTnProductInSnapshot: async () => {} } });
  mock.module('../src/services/tnManualWrites.js', {
    exports: {
      setTnStockManual: async (pid, vid, stock) => { log('setTnStockManual', pid, vid, stock); return true; },
      setTnPriceManual: async (pid, vid, price) => { log('setTnPriceManual', pid, vid, price); return true; },
    },
  });
  ({ runChannelOps, orderOps } = await import('../src/services/publicationUpdate.js'));
});

beforeEach(() => {
  calls.length = 0;
  state.items = {
    MLA1: {
      id: 'MLA1', category_id: 'MLA9', price: 100, shipping: { mode: 'me2' },
      pictures: [{ id: 'P1' }, { id: 'P2' }],
      attributes: [{ id: 'BRAND', value_name: 'Rivadavia' }, { id: 'SHEET_TYPE', value_id: '1', value_name: 'Rayada' }, { id: 'INFERRED', value_name: 'x' }, { id: 'SELLER_SKU', value_name: 'X' }],
      variations: [
        { id: 11, price: 8990, picture_ids: ['P1'], attributes: [{ id: 'SELLER_SKU', value_name: 'ROJ' }] },
        { id: 12, price: 8990, picture_ids: ['P2'], attributes: [{ id: 'SELLER_SKU', value_name: 'AZU' }] },
      ],
    },
  };
  state.products = {
    5: { id: 5, published: true, categories: [{ id: 3 }], attributes: [{ es: 'Color' }], images: [{ id: 50, position: 1 }, { id: 51, position: 2 }], variants: [{ id: 501, sku: 'ROJ' }, { id: 502, sku: 'AZU' }] },
  };
  state.images = { aaaaaaaa: true };
  state.catAttrs = [{ id: 'INFERRED', tags: { read_only: true } }, { id: 'SHEET_TYPE', values: [{ id: '1', name: 'Rayada' }, { id: '2', name: 'Cuadriculada' }] }, { id: 'WIDTH', value_type: 'number_unit', default_unit: 'cm' }];
  state.failDeleteVariation = false;
  state.tnFindBySku = null;
  state.failKeys = new Set();
});

function payload(ops, draftOver = {}) {
  const draft = {
    common: { baseName: 'Cuaderno', brand: 'Rivadavia', barcode: '', weightG: 600, lengthCm: 30, widthCm: 21, heightCm: 2, ageGroup: 'adult', gender: 'unisex', mpn: '' },
    axes: [{ name: 'Color', mlAttributeId: 'COLOR' }],
    variants: [
      { id: 'v1', sku: 'ROJ', values: ['Rojo'], stock: 3, barcode: '', ml: { price: 8990, pictureIds: ['ml-P1'] }, tn: { price: 7990, imageIds: ['tn-50'] } },
      { id: 'v2', sku: 'AZU', values: ['Azul'], stock: 8, barcode: '', ml: { price: 8990, pictureIds: ['ml-P2', 'aaaaaaaa'] }, tn: { price: 7990, imageIds: [] } },
    ],
    ml: { description: { inherited: false, value: 'Desc' }, images: [{ id: 'ml-P2' }, { id: 'ml-P1' }] },
    tn: { mappingMode: 'single_with_variants', description: { inherited: false, value: 'Desc TN' }, freeShipping: false, images: [{ id: 'tn-50', remote: { channel: 'tn', id: '50', url: 'https://tn/50.jpg' } }, { id: 'tn-51', remote: { channel: 'tn', id: '51', url: 'https://tn/51.jpg' } }, { id: 'aaaaaaaa' }] },
    ...draftOver,
  };
  const refs = {
    channels: { ml: true, tn: true },
    ml: { items: [{ itemId: 'MLA1', format: 'legacy' }] },
    tn: { products: [{ productId: 5 }] },
    variants: { v1: { ml: { itemId: 'MLA1', variationId: '11' }, tn: { productId: 5, variantId: 501 } }, v2: { ml: { itemId: 'MLA1', variationId: '12' }, tn: { productId: 5, variantId: 502 } } },
  };
  return { kind: 'update', editId: 'e1', ops, draft, refs };
}
const op = (channel, target, kind, p = {}) => ({ key: `${channel}:${target}:${kind}`, channel, target: String(target), targetLabel: '', kind, label: kind, payload: p });

async function run(channel, pl, done = new Set(), isCancelled = async () => false) {
  const reports = [];
  const res = await runChannelOps(channel, pl, done, { report: async (o, r) => reports.push({ key: o.key, ...r }), isCancelled });
  return { res, reports };
}

test('el orden pone fotos primero, creaciones después, stock/precio al final y borrados último', () => {
  const order = orderOps([op('ml', 'MLA1', 'delete_variation:v1'), op('ml', 'MLA1', 'stock:v2'), op('ml', 'MLA1', 'description'), op('ml', 'MLA1', 'add_variation:v9'), op('ml', 'MLA1', 'pictures')]).map((o) => o.kind);
  assert.deepEqual(order, ['pictures', 'add_variation:v9', 'description', 'stock:v2', 'delete_variation:v1']);
});

test('fotos de un ítem legacy: un solo PUT con la galería y las variaciones, siempre con TODOS los ids', async () => {
  const { reports } = await run('ml', payload([op('ml', 'MLA1', 'pictures'), op('ml', 'MLA1', 'pictures:v2')]));
  const puts = callsOf('updateItem');
  assert.equal(puts.length, 1, 'la segunda operación de fotos del mismo ítem no repite el PUT');
  const body = puts[0][2];
  assert.deepEqual(body.pictures.map((p) => p.id), ['P2', 'P1', 'UP-1'], 'la foto nueva se sube y se suma');
  assert.deepEqual(body.variations, [{ id: 11, picture_ids: ['P1'] }, { id: 12, picture_ids: ['P2', 'UP-1'] }]);
  assert.ok(reports.every((r) => r.status === 'ok'));
});

test('stock, precio y SKU de ML van por la Cola ML (historial con valor previo, igual que Precio y stock)', async () => {
  const { reports } = await run('ml', payload([op('ml', 'MLA1', 'stock:v1', { variationId: '11', stock: 5 }), op('ml', 'MLA1', 'price:v1', { variationId: '11', price: 9500 }), op('ml', 'MLA1', 'sku:v1', { variationId: '11', sku: 'NEW' })]));
  const tasks = callsOf('enqueueMlTask').map((c) => c[1]);
  assert.deepEqual(tasks.map((t) => t.kind), ['stock_ml_set', 'price_ml', 'sku_ml']);
  assert.equal(tasks[0].targetQty, 5);
  assert.equal(tasks[0].idempotencyKey, 'stock_ml_set:MLA1:11');
  assert.equal(tasks[1].targetPrice, 9500);
  assert.match(reports[0].detail, /Cola ML/);
  assert.equal(callsOf('updateItem').length, 0);
});

test('características: parte de lo que tiene el ítem, aplica los cambios y saca los de solo lectura y el SKU', async () => {
  await run('ml', payload([op('ml', 'MLA1', 'attributes', {
    attributes: [{ id: 'SHEET_TYPE', value: 'Cuadriculada', valueId: '2' }, { id: 'COVER', notApplicable: true }, { id: 'WIDTH', value: '21' }, { id: 'OLD', removed: true }],
    brand: 'Ledesma',
    package: { lengthCm: 30, widthCm: 21, heightCm: 1.2, weightG: 600 },
  })]));
  const attrs = callsOf('updateItem')[0][2].attributes;
  const byId = Object.fromEntries(attrs.map((a) => [a.id, a]));
  assert.deepEqual(byId.SHEET_TYPE, { id: 'SHEET_TYPE', value_id: '2' });
  assert.deepEqual(byId.COVER, { id: 'COVER', value_id: '-1', value_name: null });
  assert.deepEqual(byId.WIDTH, { id: 'WIDTH', value_name: '21 cm' }, 'number_unit viaja con unidad');
  assert.deepEqual(byId.OLD, { id: 'OLD', value_id: null, value_name: null });
  assert.equal(byId.BRAND.value_name, 'Ledesma');
  assert.equal(byId.SELLER_PACKAGE_HEIGHT.value_name, '2 cm', 'el paquete se redondea para arriba');
  assert.equal(byId.INFERRED, undefined);
  assert.equal(byId.SELLER_SKU, undefined);
});

test('agregar variación: adopta la que ya existe por SKU (reintento) y si no, sube las fotos que falten e iguala el precio', async () => {
  const v = { id: 'v9', sku: 'AZU', values: ['Azul'], stock: 4, ml: { price: 5000, pictureIds: [] }, tn: {} };
  const r1 = await run('ml', payload([op('ml', 'MLA1', 'add_variation:v9', { variant: v })]));
  assert.equal(r1.reports[0].externalId, '12');
  assert.equal(callsOf('addItemVariation').length, 0);

  calls.length = 0;
  const nueva = { ...v, sku: 'VIO', values: ['Violeta'], ml: { price: 5000, pictureIds: ['aaaaaaaa'] } };
  const r2 = await run('ml', payload([op('ml', 'MLA1', 'add_variation:v9', { variant: nueva })]));
  const put = callsOf('updateItem')[0][2];
  assert.deepEqual(put.pictures.map((p) => p.id), ['P1', 'P2', 'UP-1']);
  assert.deepEqual(put.variations, [{ id: 11 }, { id: 12 }], 'sin tocar las variaciones existentes');
  const created = callsOf('addItemVariation')[0][2];
  assert.equal(created.price, 8990, 'mismo precio que las demás variaciones');
  assert.deepEqual(created.attribute_combinations, [{ id: 'COLOR', value_name: 'Violeta' }]);
  assert.deepEqual(created.picture_ids, ['UP-1']);
  assert.match(r2.reports[0].detail, /Precio igualado/);
});

test('borrar una variación que ML no deja borrar la deja sin stock', async () => {
  state.failDeleteVariation = true;
  const { reports } = await run('ml', payload([op('ml', 'MLA1', 'delete_variation:v1', { variationId: '11' })]));
  assert.deepEqual(callsOf('updateItem')[0][2].variations, [{ id: 11, available_quantity: 0 }, { id: 12 }]);
  assert.match(reports[0].detail, /sin stock/);
  assert.equal(reports[0].status, 'ok');
});

test('crear un ítem en una ficha copia el hermano y manda family_name sin título', async () => {
  state.items.MLA1 = { ...state.items.MLA1, variations: undefined, family_name: 'Agenda 2027', listing_type_id: 'gold_special', condition: 'new', sale_terms: [] };
  const v = { id: 'v9', sku: 'COR', values: ['Coral'], stock: 2, barcode: '779', ml: { price: 15490, pictureIds: ['ml-P1'] }, tn: {} };
  const { reports } = await run('ml', payload([{ ...op('ml', 'new', 'create_item'), key: 'ml:new:v9', payload: { variant: v, title: 'Agenda Coral' } }]));
  const body = callsOf('createItem')[0][1];
  assert.equal(body.family_name, 'Agenda 2027');
  assert.equal(body.title, undefined);
  const ids = body.attributes.map((a) => a.id);
  assert.ok(ids.includes('COLOR') && ids.includes('SELLER_SKU') && ids.includes('GTIN') && ids.includes('BRAND'));
  assert.ok(!ids.includes('INFERRED'));
  assert.equal(callsOf('setItemDescription')[0][1], 'MLA-NEW');
  assert.equal(reports[0].externalId, 'MLA-NEW');
});

test('un error en una operación no frena las demás y lo ya hecho se saltea', async () => {
  state.failKeys.add('updateItem:MLA1');
  const ops = [op('ml', 'MLA1', 'title', { title: 'X' }), op('ml', 'MLA1', 'description', { plain_text: 'Nueva' }), op('ml', 'MLA1', 'listing_type', { id: 'gold_pro' })];
  const { reports, res } = await run('ml', payload(ops), new Set(['ml:MLA1:listing_type']));
  assert.deepEqual(reports.map((r) => [r.key, r.status]), [['ml:MLA1:title', 'error'], ['ml:MLA1:description', 'ok']]);
  assert.equal(callsOf('setItemListingType').length, 0, 'la que ya estaba ok no se repite');
  assert.equal(res.ok, 2);
  assert.equal(res.err, 1);
});

test('cancelar corta antes de la próxima operación', async () => {
  let n = 0;
  const { reports } = await run('ml', payload([op('ml', 'MLA1', 'description', { plain_text: 'a' }), op('ml', 'MLA1', 'listing_type', { id: 'gold_pro' })]), new Set(), async () => n++ > 0);
  assert.equal(reports.length, 1);
});

test('TN: el producto se actualiza solo con los campos que cambiaron; la descripción en texto plano pasa a HTML', async () => {
  await run('tn', payload([op('tn', 5, 'product', { fields: ['description', 'categories'], description: { es: 'Hola\n\nChau' }, categories: [3, 4], brand: 'X' })]));
  const body = callsOf('tn.updateProduct')[0][2];
  assert.deepEqual(Object.keys(body).sort(), ['categories', 'description']);
  assert.equal(body.description.es, '<p>Hola</p><p>Chau</p>');
});

test('TN: fotos del producto — sube las nuevas, borra las que sobran y ordena', async () => {
  await run('tn', payload([op('tn', 5, 'images', { image_ids: ['tn-51', 'aaaaaaaa'] })]));
  assert.deepEqual(callsOf('tn.createProductImage').map((c) => c[2]), [{ src: 'https://supa/aaaaaaaa.jpg', position: 2 }]);
  assert.deepEqual(callsOf('tn.deleteProductImage').map((c) => c[2]), [50]);
  assert.deepEqual(callsOf('tn.updateProductImagePosition').map((c) => [c[2], c[3]]), [['51', 1]]);
});

test('TN: stock y precio van por las escrituras manuales con historial', async () => {
  await run('tn', payload([op('tn', 5, 'stock:v1', { variantId: 501, stock: 4 }), op('tn', 5, 'price:v1', { variantId: 501, price: 8000 })]));
  assert.deepEqual(callsOf('setTnStockManual')[0].slice(1), ['5', 501, 4]);
  assert.deepEqual(callsOf('setTnPriceManual')[0].slice(1), ['5', 501, 8000]);
});

test('TN: agregar variante adopta una existente por SKU; crear producto adopta uno existente y le pone las fotos', async () => {
  const v = { id: 'v9', sku: 'ROJ', values: ['Rojo'], stock: 1, tn: { price: 10, imageIds: [] }, ml: {} };
  const r1 = await run('tn', payload([op('tn', 5, 'add_variant:v9', { variant: v })]));
  assert.equal(r1.reports[0].externalId, '501');
  assert.equal(callsOf('tn.createVariant').length, 0);

  calls.length = 0;
  state.tnFindBySku = { id: 600 };
  state.products[600] = { id: 600, images: [] };
  const nuevo = { ...v, sku: 'VIO', tn: { price: 10, imageIds: ['tn-50'] } };
  const r2 = await run('tn', payload([{ ...op('tn', 'new', 'create_product'), key: 'tn:new:v9', payload: { variant: nuevo, name: { es: 'Cuaderno Violeta' } } }]));
  assert.equal(callsOf('tn.createProduct').length, 0, 'ya existía: no se duplica');
  assert.equal(r2.reports[0].externalId, '600');
  assert.deepEqual(callsOf('tn.createProductImage').map((c) => c[2].src), ['https://tn/50.jpg'], 'le completa la foto (que estaba en otro producto de TN)');
});

test('sin token del canal, todas sus operaciones quedan con error y explicación', async () => {
  const mod = await import('../src/store.js');
  const saved = mod.tokens.tiendanube.access_token;
  mod.tokens.tiendanube.access_token = null;
  try {
    const { reports } = await run('tn', payload([op('tn', 5, 'name:v1', { name: { es: 'X' } })]));
    assert.equal(reports[0].status, 'error');
    assert.match(reports[0].detail, /no está conectada/);
  } finally {
    mod.tokens.tiendanube.access_token = saved;
  }
});
