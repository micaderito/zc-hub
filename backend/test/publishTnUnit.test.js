/**
 * Tests de la IDEMPOTENCIA de publishTnUnit (el path del worker): TN a veces devuelve 5xx habiendo
 * creado igual, y un reintento re-encolado volvía a crear el producto → "me creó 3 veces la misma
 * variante". Ahora chequea por SKU antes y después de crear.
 *
 * Mockeamos '../src/lib/tiendanube.js' y '../src/services/imageStore.js' (rutas resueltas desde
 * src/services/productPublish.js).
 */
import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const tn = {
  findResults: [], // respuestas sucesivas de findProductBySku (shift por llamada)
  createResult: { id: 999, variants: [] },
  createThrows: null,
  calls: []
};

let publishTnUnit;
before(async () => {
  mock.module('../src/lib/tiendanube.js', {
    exports: {
      findProductBySku: async (_t, _s, sku) => {
        tn.calls.push(['find', sku]);
        return tn.findResults.length ? tn.findResults.shift() : null;
      },
      createProduct: async (_t, _s, body) => {
        tn.calls.push(['create', body.variants?.[0]?.sku]);
        if (tn.createThrows) throw tn.createThrows;
        return tn.createResult;
      },
      createProductImage: async () => ({ id: 1, position: 1 }),
      getProductImages: async () => [],
      updateVariantImage: async () => ({}),
      updateProductImagePosition: async () => ({}),
      getProduct: async () => null
    }
  });
  mock.module('../src/services/imageStore.js', {
    exports: {
      getImage: async () => null,
      getImageUrl: async () => null,
      saveThumbBuffer: async () => {},
      getThumb: async () => null
    }
  });
  ({ publishTnUnit } = await import('../src/services/productPublish.js'));
});

beforeEach(() => {
  tn.findResults = [];
  tn.createResult = { id: 999, variants: [] };
  tn.createThrows = null;
  tn.calls = [];
});

const unit = {
  unitKey: 'SKU-1',
  body: { name: { es: 'Agenda' }, variants: [{ sku: 'SKU-1', price: '100' }] },
  uploadIds: [],
  forVariants: []
};

test('si ya existe un producto con ese SKU, NO lo recrea (reintento tras falla parcial)', async () => {
  tn.findResults = [{ id: 555, variants: [{ sku: 'SKU-1' }] }];
  const r = await publishTnUnit('t', 's', unit);
  assert.equal(r.externalId, 555);
  assert.match(r.detail, /ya existía/);
  assert.ok(!tn.calls.some((c) => c[0] === 'create'));
});

test('TN tira 500 pero el producto quedó creado → lo adopta, la unidad NO falla', async () => {
  // pre-check: no existe → intenta crear → 500 → post-catch: ahora sí aparece
  tn.findResults = [null, { id: 777, variants: [{ sku: 'SKU-1' }] }];
  tn.createThrows = new Error('TN createProduct: 500 Internal Server Error');
  const r = await publishTnUnit('t', 's', unit);
  assert.equal(r.externalId, 777);
  assert.match(r.detail, /TN devolvió error pero el producto quedó/);
});

test('TN tira 500 y el producto realmente no se creó → propaga el error', async () => {
  tn.findResults = [null, null];
  tn.createThrows = new Error('TN createProduct: 500 Internal Server Error');
  await assert.rejects(() => publishTnUnit('t', 's', unit), /500/);
});

test('camino feliz: no existe, crea, devuelve el id nuevo', async () => {
  tn.findResults = [null];
  tn.createResult = { id: 1234, variants: [{ id: 1, sku: 'SKU-1' }] };
  const r = await publishTnUnit('t', 's', unit);
  assert.equal(r.externalId, 1234);
  assert.match(r.detail, /creado/);
  assert.ok(tn.calls.some((c) => c[0] === 'create'));
});
