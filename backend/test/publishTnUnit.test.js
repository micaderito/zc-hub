/**
 * Tests de publishTnUnit (el path del worker): idempotencia + reconciliación de imágenes.
 *
 * - TN a veces devuelve 5xx habiendo creado igual → un reintento re-encolado volvía a crear el
 *   producto ("me creó 3 veces la misma variante"). Ahora chequea por SKU antes y después de crear.
 * - El producto se crea PELADO y las fotos se suben DE A UNA (syncTnProductImages), completando solo
 *   las que falten — también en el camino adoptado, que antes las salteaba todas.
 *
 * Mockeamos '../src/lib/tiendanube.js' y '../src/services/imageStore.js' (rutas resueltas desde
 * src/services/productPublish.js).
 */
import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const tn = {
  findResults: [], // respuestas sucesivas de findProductBySku (shift por llamada)
  createResult: { id: 999, variants: [{ id: 7, sku: 'SKU-1' }] },
  createThrows: null,
  currentImages: [], // lo que devuelve getProductImages
  calls: []
};
let imgSeq;

let publishTnUnit;
before(async () => {
  mock.module('../src/lib/tiendanube.js', {
    exports: {
      findProductBySku: async (_t, _s, sku) => {
        tn.calls.push(['find', sku]);
        return tn.findResults.length ? tn.findResults.shift() : null;
      },
      createProduct: async (_t, _s, body) => {
        tn.calls.push(['create', body.variants?.[0]?.sku, body.images]);
        if (tn.createThrows) throw tn.createThrows;
        return tn.createResult;
      },
      getProductImages: async () => tn.currentImages,
      createProductImage: async (_t, _s, _pid, { position }) => {
        tn.calls.push(['image', position]);
        return { id: ++imgSeq, position };
      },
      updateProductImagePosition: async () => ({}),
      updateVariantImage: async () => ({}),
      getProduct: async () => ({ variants: tn.createResult.variants })
    }
  });
  mock.module('../src/services/imageStore.js', {
    exports: {
      getImageUrl: async (id) => `https://cdn.example/${id}.jpg`,
      getImage: async () => null,
      saveThumbBuffer: async () => {},
      getThumb: async () => null
    }
  });
  ({ publishTnUnit } = await import('../src/services/productPublish.js'));
});

beforeEach(() => {
  tn.findResults = [];
  tn.createResult = { id: 999, variants: [{ id: 7, sku: 'SKU-1' }] };
  tn.createThrows = null;
  tn.currentImages = [];
  tn.calls = [];
  imgSeq = 100;
});

const unit = {
  unitKey: 'SKU-1',
  body: { name: { es: 'Agenda' }, variants: [{ sku: 'SKU-1', price: '100' }] },
  uploadIds: ['a', 'b', 'c'],
  forVariants: []
};

test('el POST de creación NO lleva imágenes; se suben de a una después', async () => {
  tn.findResults = [null];
  const r = await publishTnUnit('t', 's', unit);
  assert.equal(r.externalId, 999);
  const create = tn.calls.find((c) => c[0] === 'create');
  assert.equal(create[2], undefined); // sin images en el body
  assert.deepEqual(
    tn.calls.filter((c) => c[0] === 'image').map((c) => c[1]),
    [1, 2, 3]
  );
});

test('si ya existe un producto con ese SKU, NO lo recrea pero SÍ le completa las fotos que falten', async () => {
  tn.findResults = [{ id: 555, variants: [{ id: 7, sku: 'SKU-1' }] }];
  tn.currentImages = [{ id: 10, position: 1 }]; // ya tiene 1 de 3
  const r = await publishTnUnit('t', 's', unit);
  assert.equal(r.externalId, 555);
  assert.match(r.detail, /ya existía/);
  assert.ok(!tn.calls.some((c) => c[0] === 'create'));
  // completa las 2 que faltan (posiciones 2 y 3), no re-sube la 1
  assert.deepEqual(
    tn.calls.filter((c) => c[0] === 'image').map((c) => c[1]),
    [2, 3]
  );
});

test('TN tira error en la creación pero el producto quedó → lo adopta y completa las fotos', async () => {
  tn.findResults = [null, { id: 777, variants: [{ id: 7, sku: 'SKU-1' }] }];
  tn.createThrows = new Error('TN createProduct: 500 Internal Server Error');
  tn.currentImages = [];
  const r = await publishTnUnit('t', 's', unit);
  assert.equal(r.externalId, 777);
  assert.match(r.detail, /TN devolvió error en la creación pero el producto quedó/);
  assert.equal(tn.calls.filter((c) => c[0] === 'image').length, 3); // sube las 3
});

test('TN tira error y el producto realmente no se creó → propaga el error', async () => {
  tn.findResults = [null, null];
  tn.createThrows = new Error('TN createProduct: 500 Internal Server Error');
  await assert.rejects(() => publishTnUnit('t', 's', unit), /500/);
});

test('camino feliz: no existe, crea, sube las 3 fotos, devuelve el id nuevo', async () => {
  tn.findResults = [null];
  tn.createResult = { id: 1234, variants: [{ id: 1, sku: 'SKU-1' }] };
  const r = await publishTnUnit('t', 's', unit);
  assert.equal(r.externalId, 1234);
  assert.match(r.detail, /creado/);
  assert.ok(tn.calls.some((c) => c[0] === 'create'));
  assert.equal(tn.calls.filter((c) => c[0] === 'image').length, 3);
});
