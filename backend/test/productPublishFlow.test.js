/**
 * Tests de la orquestación real de publicación (publishProduct → publishMl/publishTn) y de las
 * funciones lib createItem/createProduct. Mockeamos `node-fetch` e interceptamos los POST a
 * /items (ML) y /products (TN) para cubrir: éxito en ambos, token faltante, falla parcial
 * (un canal OK y el otro error) y el label con múltiples ids (one_per_variant).
 */
import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { saveImage, removeImage } from '../src/services/imageStore.js';

const state = { responder: null, calls: [] };

async function mockFetch(url, opts = {}) {
  let body;
  if (typeof opts.body === 'string') {
    try { body = JSON.parse(opts.body); } catch { body = opts.body; }
  }
  state.calls.push({ url, method: opts.method || 'GET', body });
  return state.responder(url, opts);
}

function makeRes({ status = 200, json = null, text = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => json,
    text: async () => (text != null ? text : JSON.stringify(json ?? {}))
  };
}

let publishProduct;
before(async () => {
  mock.module('node-fetch', { exports: { default: mockFetch } });
  ({ publishProduct } = await import('../src/services/productPublish.js'));
});
beforeEach(() => {
  state.calls = [];
  state.responder = null;
});

const mlBlock = {
  mapping_mode: 'single_with_variants',
  title: 'Cuaderno A4',
  category_id: 'MLA388307',
  currency_id: 'ARS',
  buying_mode: 'buy_it_now',
  condition: 'new',
  listing_type_id: 'gold_special',
  attributes: [{ id: 'SELLER_SKU', value_name: 'CUA-1' }],
  sale_terms: [],
  shipping: { mode: 'me2', free_shipping: true, local_pick_up: false, dimensions: null },
  pictures: [{ source: 'https://x.com/a.jpg' }],
  base_price: 3500,
  base_stock: 10
};
const tnBlock = {
  mapping_mode: 'single_with_variants',
  name: { es: 'Cuaderno A4' },
  categories: [],
  brand: 'ZC',
  published: true,
  base_price: 3500,
  base_promo_price: null,
  base_stock: 10,
  variants: []
};
const simplePayload = () => ({ common: { sku: 'CUA-1' }, axes: [], variants: [], ml: { ...mlBlock }, tn: { ...tnBlock } });

const isMlPost = (url, opts) => url.endsWith('/items') && opts.method === 'POST';
const isTnPost = (url, opts) => url.endsWith('/products') && opts.method === 'POST';
const bothOk = (url, opts) => {
  if (isMlPost(url, opts)) return makeRes({ json: { id: 'MLA123' } });
  if (isTnPost(url, opts)) return makeRes({ status: 201, json: { id: 90431 } });
  throw new Error(`URL inesperada: ${opts.method} ${url}`);
};

test('publishProduct: ambos canales OK → status ok con los ids creados', async () => {
  state.responder = bothOk;
  const { results } = await publishProduct(simplePayload(), { mlToken: 't', tnToken: 't', storeId: '9' });
  const ml = results.find((r) => r.channel === 'ml');
  const tn = results.find((r) => r.channel === 'tn');
  assert.equal(ml.status, 'ok');
  assert.match(ml.detail, /MLA123/);
  assert.equal(tn.status, 'ok');
  assert.match(tn.detail, /90431/);
  // createItem/createProduct: se envió el precio/stock base en el body simple.
  const mlBody = state.calls.find((c) => isMlPost(c.url, c)).body;
  assert.equal(mlBody.price, 3500);
  assert.equal(mlBody.available_quantity, 10);
  const tnBody = state.calls.find((c) => isTnPost(c.url, c)).body;
  assert.equal(tnBody.published, true);
  assert.equal(tnBody.variants[0].price, '3500.00');
});

test('publishProduct: token de ML faltante → ML error sin llamar a la API, TN sigue OK', async () => {
  state.responder = bothOk;
  const { results } = await publishProduct(simplePayload(), { mlToken: null, tnToken: 't', storeId: '9' });
  const ml = results.find((r) => r.channel === 'ml');
  const tn = results.find((r) => r.channel === 'tn');
  assert.equal(ml.status, 'error');
  assert.match(ml.detail, /No conectado a Mercado Libre/);
  assert.equal(tn.status, 'ok');
  // No debe haber POST a /items.
  assert.equal(state.calls.some((c) => isMlPost(c.url, c)), false);
});

test('publishProduct: falla parcial → ML OK y TN error con el detalle de la API', async () => {
  state.responder = (url, opts) => {
    if (isMlPost(url, opts)) return makeRes({ json: { id: 'MLA123' } });
    if (isTnPost(url, opts)) return makeRes({ status: 422, text: 'variants: price required' });
    throw new Error(`URL inesperada: ${opts.method} ${url}`);
  };
  const { results } = await publishProduct(simplePayload(), { mlToken: 't', tnToken: 't', storeId: '9' });
  assert.equal(results.find((r) => r.channel === 'ml').status, 'ok');
  const tn = results.find((r) => r.channel === 'tn');
  assert.equal(tn.status, 'error');
  assert.match(tn.detail, /422/);
});

test('publishProduct: ML error propaga el mensaje real de ML', async () => {
  state.responder = (url, opts) => {
    if (isMlPost(url, opts)) return makeRes({ status: 400, json: { message: 'category invalid', cause: [{ message: 'category invalid' }] } });
    if (isTnPost(url, opts)) return makeRes({ status: 201, json: { id: 1 } });
    throw new Error(`URL inesperada: ${opts.method} ${url}`);
  };
  const { results } = await publishProduct(simplePayload(), { mlToken: 't', tnToken: 't', storeId: '9' });
  const ml = results.find((r) => r.channel === 'ml');
  assert.equal(ml.status, 'error');
  assert.match(ml.detail, /category invalid/);
});

test('publishProduct: con channels=["tn"] solo publica TN (reintento de un canal), no toca ML', async () => {
  state.responder = bothOk;
  const { results } = await publishProduct(simplePayload(), { mlToken: 't', tnToken: 't', storeId: '9', channels: ['tn'] });
  assert.equal(results.length, 1);
  assert.equal(results[0].channel, 'tn');
  assert.equal(results[0].status, 'ok');
  // No debe haber ningún POST a /items (ML no se tocó).
  assert.equal(state.calls.some((c) => isMlPost(c.url, c)), false);
});

test('publishProduct (one_per_variant): crea N publicaciones y el label lista los ids', async () => {
  let n = 0;
  state.responder = (url, opts) => {
    if (isMlPost(url, opts)) return makeRes({ json: { id: `MLA${++n}` } });
    if (isTnPost(url, opts)) return makeRes({ status: 201, json: { id: 100 + n } });
    throw new Error(`URL inesperada: ${opts.method} ${url}`);
  };
  const payload = {
    common: { sku: 'CUA' },
    axes: [{ name: 'Color' }],
    variants: [
      { sku: 'CUA-N', values: ['Negro'], ml: { price: 100, stock: 5 } },
      { sku: 'CUA-R', values: ['Rojo'], ml: { price: 110, stock: 3 } }
    ],
    ml: { ...mlBlock, mapping_mode: 'one_per_variant' },
    tn: {
      ...tnBlock,
      mapping_mode: 'one_per_variant',
      variants: [
        { sku: 'CUA-N', values: [{ es: 'Color: Negro' }], price: 100, stock: 5 },
        { sku: 'CUA-R', values: [{ es: 'Color: Rojo' }], price: 110, stock: 3 }
      ]
    }
  };
  const { results } = await publishProduct(payload, { mlToken: 't', tnToken: 't', storeId: '9' });
  const ml = results.find((r) => r.channel === 'ml');
  assert.equal(ml.status, 'ok');
  assert.match(ml.detail, /2 publicaciones/);
  assert.match(ml.detail, /MLA1/);
  assert.match(ml.detail, /MLA2/);
  // Se hicieron 2 POST a /items.
  assert.equal(state.calls.filter((c) => isMlPost(c.url, c)).length, 2);
});

/* ───────────────── Imágenes ───────────────── */

const isTnImagePost = (url, opts) => url.includes('/images') && opts.method === 'POST';
const isTnVariantPut = (url, opts) => /\/variants\/\d+$/.test(url) && opts.method === 'PUT';

test('publishProduct (TN single_with_variants): sube la galería a un producto y asocia UNA imagen (image_ids[0]) a la variante', async () => {
  const img = saveImage({ filename: 'a.jpg', mime: 'image/jpeg', data: Buffer.from('hello-tn').toString('base64') });
  try {
    state.responder = (url, opts) => {
      if (isTnPost(url, opts)) return makeRes({ status: 201, json: { id: 90431, variants: [{ id: 555, sku: 'CUA-N' }] } });
      if (isTnImagePost(url, opts)) return makeRes({ status: 201, json: { id: 777, position: 1 } });
      if (isTnVariantPut(url, opts)) return makeRes({ status: 200, json: { id: 555, image_id: 777 } });
      throw new Error(`URL inesperada: ${opts.method} ${url}`);
    };
    const payload = {
      common: { sku: 'CUA-N' },
      axes: [{ name: 'Color' }],
      variants: [{ sku: 'CUA-N', values: ['Negro'], tn: { price: 100, stock: 5, image_ids: [img.id] } }],
      ml: { ...mlBlock },
      tn: {
        ...tnBlock,
        mapping_mode: 'single_with_variants',
        image_ids: [img.id],
        variants: [{ sku: 'CUA-N', values: [{ es: 'Color: Negro' }], price: 100, stock: 5 }]
      }
    };
    const { results } = await publishProduct(payload, { tnToken: 't', storeId: '9', channels: ['tn'] });
    assert.equal(results[0].status, 'ok');
    // Subió la imagen por attachment (base64), con position 1 (portada).
    const imgCall = state.calls.find((c) => isTnImagePost(c.url, c));
    assert.ok(imgCall, 'debe haber POST a /images');
    assert.equal(imgCall.body.position, 1);
    assert.equal(imgCall.body.attachment, Buffer.from('hello-tn').toString('base64'));
    assert.equal(imgCall.body.filename, 'a.jpg');
    // Asoció image_id 777 a la variante 555 (match por SKU).
    const putCall = state.calls.find((c) => isTnVariantPut(c.url, c));
    assert.ok(putCall, 'debe haber PUT a /variants/555');
    assert.match(putCall.url, /\/variants\/555$/);
    assert.equal(putCall.body.image_id, 777);
  } finally {
    removeImage(img.id);
  }
});

test('publishProduct (TN one_per_variant): cada producto recibe SOLO las fotos asignadas a su variante (varias)', async () => {
  // Galería de 3 fotos; la variante Negro usa 2, la variante Rojo usa 1.
  const g1 = saveImage({ filename: 'g1.jpg', mime: 'image/jpeg', data: Buffer.from('g1').toString('base64') });
  const g2 = saveImage({ filename: 'g2.jpg', mime: 'image/jpeg', data: Buffer.from('g2').toString('base64') });
  const g3 = saveImage({ filename: 'g3.jpg', mime: 'image/jpeg', data: Buffer.from('g3').toString('base64') });
  try {
    let prodSeq = 100;
    let imgSeq = 700;
    state.responder = (url, opts) => {
      if (isTnPost(url, opts)) return makeRes({ status: 201, json: { id: ++prodSeq, variants: [{ id: prodSeq * 10, sku: JSON.parse(opts.body).variants[0].sku }] } });
      // TN honra la position pedida (caso feliz → sin reconciliación).
      if (isTnImagePost(url, opts)) return makeRes({ status: 201, json: { id: ++imgSeq, position: JSON.parse(opts.body).position } });
      if (isTnVariantPut(url, opts)) return makeRes({ status: 200, json: {} });
      throw new Error(`URL inesperada: ${opts.method} ${url}`);
    };
    const payload = {
      common: { sku: 'CUA' },
      axes: [{ name: 'Color' }],
      variants: [
        { sku: 'CUA-N', values: ['Negro'], tn: { price: 100, stock: 5, image_ids: [g1.id, g2.id] } },
        { sku: 'CUA-R', values: ['Rojo'], tn: { price: 110, stock: 3, image_ids: [g3.id] } }
      ],
      ml: { ...mlBlock },
      tn: {
        ...tnBlock,
        mapping_mode: 'one_per_variant',
        image_ids: [g1.id, g2.id, g3.id],
        variants: [
          { sku: 'CUA-N', values: [{ es: 'Color: Negro' }], price: 100, stock: 5 },
          { sku: 'CUA-R', values: [{ es: 'Color: Rojo' }], price: 110, stock: 3 }
        ]
      }
    };
    const { results } = await publishProduct(payload, { tnToken: 't', storeId: '9', channels: ['tn'] });
    assert.equal(results[0].status, 'ok');
    // Se crearon 2 productos.
    assert.equal(state.calls.filter((c) => isTnPost(c.url, c)).length, 2);
    // En total 3 subidas de imagen (2 al primer producto, 1 al segundo), NO 6 (no se sube toda la galería a cada uno).
    const imgPosts = state.calls.filter((c) => isTnImagePost(c.url, c));
    assert.equal(imgPosts.length, 3);
    // Producto 101 (Negro) recibió 2 fotos; producto 102 (Rojo) recibió 1.
    const byProduct = (id) => imgPosts.filter((c) => c.url.includes(`/products/${id}/images`)).length;
    assert.equal(byProduct(101), 2);
    assert.equal(byProduct(102), 1);
  } finally {
    removeImage(g1.id);
    removeImage(g2.id);
    removeImage(g3.id);
  }
});

test('publishProduct (TN imágenes): si TN NO respeta la position del POST, reconcilia con PUT para garantizar el orden', async () => {
  const g1 = saveImage({ filename: 'g1.jpg', mime: 'image/jpeg', data: Buffer.from('g1').toString('base64') });
  const g2 = saveImage({ filename: 'g2.jpg', mime: 'image/jpeg', data: Buffer.from('g2').toString('base64') });
  const isTnImagePut = (url, opts) => /\/images\/\d+$/.test(url) && opts.method === 'PUT';
  try {
    let imgSeq = 500;
    state.responder = (url, opts) => {
      if (isTnPost(url, opts)) return makeRes({ status: 201, json: { id: 90431, variants: [{ id: 555, sku: 'CUA' }] } });
      // TN ignora la position pedida y devuelve siempre 99 (orden equivocado).
      if (isTnImagePost(url, opts)) return makeRes({ status: 201, json: { id: ++imgSeq, position: 99 } });
      if (isTnImagePut(url, opts)) return makeRes({ status: 200, json: {} });
      throw new Error(`URL inesperada: ${opts.method} ${url}`);
    };
    const payload = {
      common: { sku: 'CUA' },
      axes: [],
      variants: [],
      ml: { ...mlBlock },
      tn: { ...tnBlock, mapping_mode: 'single_with_variants', image_ids: [g1.id, g2.id] }
    };
    const { results } = await publishProduct(payload, { tnToken: 't', storeId: '9', channels: ['tn'] });
    assert.equal(results[0].status, 'ok');
    // Como la position devuelta (99) != la pedida (1 y 2), reconcilia ambas con PUT a /images/{id}.
    const puts = state.calls.filter((c) => isTnImagePut(c.url, c));
    assert.equal(puts.length, 2);
    // La primera imagen (501) queda en position 1 (portada); la segunda (502) en position 2.
    const putFor = (imgId) => puts.find((c) => c.url.endsWith(`/images/${imgId}`));
    assert.equal(putFor(501).body.position, 1);
    assert.equal(putFor(502).body.position, 2);
  } finally {
    removeImage(g1.id);
    removeImage(g2.id);
  }
});

test('publishProduct (ML con imágenes): sube el binario a /pictures/items/upload y usa el picture_id en pictures[]', async () => {
  const img = saveImage({ filename: 'b.png', mime: 'image/png', data: Buffer.from('hello-ml').toString('base64') });
  const realFetch = globalThis.fetch;
  let uploadCalls = 0;
  // uploadPicture usa el fetch GLOBAL (multipart); lo interceptamos aparte del mock de node-fetch.
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes('/pictures/items/upload') && opts.method === 'POST') {
      uploadCalls++;
      return makeRes({ json: { id: 'PIC-XYZ' } });
    }
    throw new Error(`globalThis.fetch inesperado: ${opts.method} ${url}`);
  };
  try {
    state.responder = (url, opts) => {
      if (isMlPost(url, opts)) return makeRes({ json: { id: 'MLA999' } });
      throw new Error(`URL inesperada: ${opts.method} ${url}`);
    };
    const payload = {
      common: { sku: 'CUA-1' },
      axes: [],
      variants: [],
      ml: { ...mlBlock, image_ids: [img.id] },
      tn: { ...tnBlock }
    };
    const { results } = await publishProduct(payload, { mlToken: 't', channels: ['ml'] });
    assert.equal(results[0].status, 'ok');
    assert.equal(uploadCalls, 1);
    // El body del POST /items referencia el picture_id devuelto por el upload.
    const itemCall = state.calls.find((c) => isMlPost(c.url, c));
    assert.deepEqual(itemCall.body.pictures, [{ id: 'PIC-XYZ' }]);
  } finally {
    globalThis.fetch = realFetch;
    removeImage(img.id);
  }
});

const isMlDescPost = (url, opts) => /\/items\/[^/]+\/description$/.test(url) && opts.method === 'POST';

test('publishProduct (ML descripción): tras crear el ítem, setea la descripción en un POST aparte a /items/{id}/description', async () => {
  state.responder = (url, opts) => {
    if (isMlPost(url, opts)) return makeRes({ json: { id: 'MLA555' } });
    if (isMlDescPost(url, opts)) return makeRes({ json: { plain_text: JSON.parse(opts.body).plain_text } });
    throw new Error(`URL inesperada: ${opts.method} ${url}`);
  };
  const payload = {
    common: { sku: 'CUA-1' },
    axes: [],
    variants: [],
    ml: { ...mlBlock, description: { plain_text: 'Cuaderno premium tapa dura.' } },
    tn: { ...tnBlock }
  };
  const { results } = await publishProduct(payload, { mlToken: 't', channels: ['ml'] });
  assert.equal(results[0].status, 'ok');
  const descCall = state.calls.find((c) => isMlDescPost(c.url, c));
  assert.ok(descCall, 'debe haber POST a /items/MLA555/description');
  assert.match(descCall.url, /\/items\/MLA555\/description$/);
  assert.equal(descCall.body.plain_text, 'Cuaderno premium tapa dura.');
  // El body del POST /items NO debe incluir description (va aparte).
  const itemCall = state.calls.find((c) => isMlPost(c.url, c));
  assert.equal(itemCall.body.description, undefined);
});

test('publishProduct (ML descripción): si la descripción está vacía, NO llama a /description', async () => {
  state.responder = (url, opts) => {
    if (isMlPost(url, opts)) return makeRes({ json: { id: 'MLA556' } });
    if (isMlDescPost(url, opts)) return makeRes({ json: {} });
    throw new Error(`URL inesperada: ${opts.method} ${url}`);
  };
  const payload = {
    common: { sku: 'CUA-1' },
    axes: [],
    variants: [],
    ml: { ...mlBlock, description: { plain_text: '' } },
    tn: { ...tnBlock }
  };
  await publishProduct(payload, { mlToken: 't', channels: ['ml'] });
  assert.equal(state.calls.some((c) => isMlDescPost(c.url, c)), false);
});
