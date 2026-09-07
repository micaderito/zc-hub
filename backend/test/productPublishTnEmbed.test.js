/**
 * publishProduct (TN) con Supabase Storage configurado (imageStore.getImageUrl resuelve): el
 * producto se crea PELADO y las fotos se suben DE A UNA con `POST /products/{id}/images {src}`
 * (no embebidas en el POST de creación, que TN corta con 500 cuando son 10+). Vive en su propio
 * archivo porque necesita mockear imageStore.js ANTES de importar productPublish.js.
 *
 * Cubre también el bug de orden reportado: en `one_per_variant`, la portada de cada producto es
 * la PRIMERA foto que la usuaria eligió PARA ESA VARIANTE (el orden del modal), no la primera foto
 * de la galería general que aparezca asignada a esa variante.
 */
import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const state = { responder: null, calls: [] };

async function mockFetch(url, opts = {}) {
  let body;
  if (typeof opts.body === 'string') {
    try { body = JSON.parse(opts.body); } catch { body = opts.body; }
  }
  state.calls.push({ url, method: opts.method || 'GET', body });
  return state.responder(url, opts);
}

function makeRes({ status = 200, json = null } = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => json, text: async () => JSON.stringify(json ?? {}) };
}

const urlFor = (id) => `https://supabase.example/storage/${id}.jpg`;

let publishProduct;
before(async () => {
  mock.module('node-fetch', { exports: { default: mockFetch } });
  mock.module('../src/services/imageStore.js', {
    exports: {
      getImageUrl: async (id) => urlFor(id),
      getImage: async () => null // no debería llamarse: todo se resuelve por URL
    }
  });
  ({ publishProduct } = await import('../src/services/productPublish.js'));
});
beforeEach(() => {
  state.calls = [];
  state.responder = null;
});

const mlBlock = { mapping_mode: 'single_with_variants', title: 'X', category_id: 'C', currency_id: 'ARS', buying_mode: 'buy_it_now', condition: 'new', listing_type_id: 'gold_special', attributes: [], sale_terms: [], shipping: {}, base_price: 1, base_stock: 1 };
const isTnPost = (url, opts) => url.endsWith('/products') && opts.method === 'POST';
const isTnImagePost = (url, opts) => /\/products\/\d+\/images$/.test(url) && opts.method === 'POST';
const isTnGetImages = (url, opts) => /\/products\/\d+\/images$/.test(url) && (opts.method || 'GET') === 'GET';
const isTnFindBySku = (url, opts) => url.includes('/products?q=') && (opts.method || 'GET') === 'GET';

test('crea el producto SIN images y sube cada foto de a una con POST /images {src}', async () => {
  let seq = 700;
  state.responder = (url, opts) => {
    if (isTnFindBySku(url, opts)) return makeRes({ json: [] }); // no existe → se crea
    if (isTnPost(url, opts)) return makeRes({ status: 201, json: { id: 1, images: [], variants: [{ id: 5, sku: 'CUA' }] } });
    if (isTnGetImages(url, opts)) return makeRes({ json: [] }); // recién creado: sin imágenes
    if (isTnImagePost(url, opts)) return makeRes({ status: 201, json: { id: ++seq, position: JSON.parse(opts.body).position } });
    throw new Error(`URL inesperada: ${opts.method} ${url}`);
  };
  const payload = {
    common: { sku: 'CUA' },
    axes: [],
    variants: [],
    ml: { ...mlBlock },
    tn: { mapping_mode: 'single_with_variants', name: { es: 'X' }, categories: [], published: true, base_price: 1, base_stock: 1, variants: [], image_ids: ['imgA', 'imgB'] }
  };
  const { results } = await publishProduct(payload, { tnToken: 't', storeId: '9', channels: ['tn'] });
  assert.equal(results[0].status, 'ok');
  const post = state.calls.find((c) => isTnPost(c.url, c));
  assert.equal(post.body.images, undefined); // el POST de creación NO lleva imágenes
  const imgPosts = state.calls.filter((c) => isTnImagePost(c.url, c)).map((c) => c.body);
  assert.deepEqual(imgPosts, [{ src: urlFor('imgA'), position: 1 }, { src: urlFor('imgB'), position: 2 }]);
});

test('one_per_variant: la portada de cada producto es la 1ª foto del ORDEN DE LA VARIANTE, no de la galería', async () => {
  // Galería general: [g1, g2, g3]. La variante "Negro" eligió, en SU modal, el orden [g2, g1]
  // (portada = g2) — un orden distinto al de la galería. El bug reportado mandaba [g1, g2] (el
  // orden de la galería), dejando g1 como portada en vez de la g2 elegida.
  const isTnVariantPut = (u, o) => /\/variants\/\d+$/.test(u) && o.method === 'PUT';
  let seq = 900;
  state.responder = (url, opts) => {
    if (isTnFindBySku(url, opts)) return makeRes({ json: [] });
    if (isTnPost(url, opts)) return makeRes({ status: 201, json: { id: 1, images: [], variants: [{ id: 5, sku: 'CUA-N' }] } });
    if (isTnGetImages(url, opts)) return makeRes({ json: [] });
    if (isTnImagePost(url, opts)) return makeRes({ status: 201, json: { id: ++seq, position: JSON.parse(opts.body).position } });
    if (isTnVariantPut(url, opts)) return makeRes({ json: { id: 5, image_id: seq } });
    throw new Error(`URL inesperada: ${opts.method} ${url}`);
  };
  const payload = {
    common: { sku: 'CUA' },
    axes: [{ name: 'Color' }],
    variants: [{ sku: 'CUA-N', values: ['Negro'], tn: { price: 100, stock: 5, image_ids: ['g2', 'g1'] } }],
    ml: { ...mlBlock },
    tn: {
      mapping_mode: 'one_per_variant',
      name: { es: 'X' },
      categories: [],
      published: true,
      base_price: 1,
      base_stock: 1,
      image_ids: ['g1', 'g2', 'g3'], // orden de la galería general: g1 primero
      variants: [{ sku: 'CUA-N', values: [{ es: 'Negro' }], price: 100, stock: 5 }]
    }
  };
  const { results } = await publishProduct(payload, { tnToken: 't', storeId: '9', channels: ['tn'] });
  assert.equal(results[0].status, 'ok');
  const imgPosts = state.calls.filter((c) => isTnImagePost(c.url, c)).map((c) => c.body);
  // La portada (position 1) es g2 —la elegida por la usuaria para esta variante— no g1.
  assert.deepEqual(imgPosts, [{ src: urlFor('g2'), position: 1 }, { src: urlFor('g1'), position: 2 }]);
});
