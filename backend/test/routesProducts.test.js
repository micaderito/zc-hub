/**
 * Tests HTTP de routes/products.js, acotados a dos cosas que solo se rompen en runtime:
 *
 * 1. **Los GET de imagen tienen que ser públicos.** Se usan como `<img src>` en crear-producto y
 *    una etiqueta `<img>` no puede mandar el header Authorization. La regex del bypass de auth
 *    matcheaba un solo segmento, así que al agregar `/images/:id/thumb` era facilísimo dejarlo
 *    detrás de requireAuth — y el síntoma habría sido "imágenes rotas al restaurar un borrador",
 *    sin ningún error visible del lado del servidor.
 * 2. **El límite de fotos por variación no puede llegar en 0.** ML devuelve
 *    `max_pictures_per_item_var: 0` en categorías mal configuradas, y ese 0 hacía que en el front
 *    la guarda `length >= limite` diera `0 >= 0` y bloqueara TODA selección de fotos en ML.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mock } from 'node:test';

const store = {
  images: new Map(), // id → { buffer, mime, filename }
  thumbs: new Map(), // id → { buffer, mime }
  categoryDetail: null,
};

let app, server, baseUrl;

before(async () => {
  mock.module('../src/services/imageStore.js', {
    exports: {
      saveImage: () => ({ id: 'x', name: 'x', mime: 'image/jpeg', size: 1 }),
      saveImageBuffer: () => ({ id: 'x', name: 'x', mime: 'image/jpeg', size: 1 }),
      saveThumbBuffer: (id, buffer) => {
        if (!store.images.has(id)) throw Object.assign(new Error('La imagen no existe'), { statusCode: 404 });
        store.thumbs.set(id, { buffer, mime: 'image/jpeg' });
        return { ok: true, size: buffer.length };
      },
      getImage: (id) => store.images.get(id) ?? null,
      getThumb: (id) => store.thumbs.get(id) ?? null,
      removeImage: (id) => { store.images.delete(id); store.thumbs.delete(id); },
    },
  });
  // requireAuth real: lo que se está probando es justamente qué rutas lo esquivan.
  mock.module('../src/middleware/requireAuth.js', {
    exports: {
      requireAuth: (req, res, next) => {
        if (req.headers.authorization === 'Bearer ok') return next();
        return res.status(401).json({ error: 'Sesión inválida o vencida' });
      },
      invalidateAuthUserCache: () => {},
    },
  });
  mock.module('../src/store.js', {
    exports: { tokens: { mercadolibre: { access_token: 'ml' } }, getMlToken: async () => 'ml' },
  });
  mock.module('../src/lib/mercadolibre.js', {
    exports: { getCategory: async () => store.categoryDetail },
  });

  const { productRoutes } = await import('../src/routes/products.js');
  app = express();
  app.use('/api/products', productRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/products`;
});

after(() => { server.close(); });

test('GET /images/:id/thumb es PÚBLICO (un <img src> no puede mandar Authorization)', async () => {
  store.images.set('abc123', { buffer: Buffer.from('original'), mime: 'image/jpeg', filename: 'f.jpg' });
  store.thumbs.set('abc123', { buffer: Buffer.from('mini'), mime: 'image/jpeg' });

  const res = await fetch(`${baseUrl}/images/abc123/thumb`); // sin header Authorization
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'mini');
});

test('GET /images/:id sigue siendo público', async () => {
  store.images.set('abc123', { buffer: Buffer.from('original'), mime: 'image/jpeg', filename: 'f.jpg' });
  const res = await fetch(`${baseUrl}/images/abc123`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'original');
});

test('GET /images/:id/thumb sin miniatura cae al original (borradores previos a la miniatura)', async () => {
  store.images.set('sinthumb', { buffer: Buffer.from('original'), mime: 'image/jpeg', filename: 'f.jpg' });
  store.thumbs.delete('sinthumb');

  const res = await fetch(`${baseUrl}/images/sinthumb/thumb`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'original');
  assert.equal(res.headers.get('x-thumb'), 'original');
});

test('GET /images/:id/thumb de un id inexistente → 404', async () => {
  const res = await fetch(`${baseUrl}/images/nada/thumb`);
  assert.equal(res.status, 404);
});

test('POST /images/:id/thumb SÍ exige sesión (a diferencia del GET)', async () => {
  store.images.set('abc123', { buffer: Buffer.from('original'), mime: 'image/jpeg', filename: 'f.jpg' });

  const sinAuth = await fetch(`${baseUrl}/images/abc123/thumb`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg' },
    body: Buffer.from('mini'),
  });
  assert.equal(sinAuth.status, 401);

  const conAuth = await fetch(`${baseUrl}/images/abc123/thumb`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg', Authorization: 'Bearer ok' },
    body: Buffer.from('mini-nueva'),
  });
  assert.equal(conAuth.status, 200);
  assert.equal(store.thumbs.get('abc123').buffer.toString('utf8'), 'mini-nueva');
});

test('el límite de fotos por variación NUNCA sale en 0 aunque ML lo informe así', async () => {
  store.categoryDetail = {
    id: 'MLA388307',
    name: 'Cuadernos',
    path_from_root: [],
    children_categories: [],
    settings: { listing_allowed: true, max_pictures_per_item: 0, max_pictures_per_item_var: 0 },
  };

  const res = await fetch(`${baseUrl}/categories/mercadolibre/MLA388307`, {
    headers: { Authorization: 'Bearer ok' },
  });
  const body = await res.json();

  // Con el 0 pasando entero, el front bloqueaba toda selección de fotos de ML (0 >= 0).
  assert.equal(body.max_pictures, 12);
  assert.equal(body.max_pictures_per_var, 10);
});

test('un límite válido de ML se respeta tal cual', async () => {
  store.categoryDetail = {
    id: 'MLA1',
    name: 'Otra',
    path_from_root: [],
    children_categories: [],
    settings: { listing_allowed: true, max_pictures_per_item: 8, max_pictures_per_item_var: 6 },
  };

  const res = await fetch(`${baseUrl}/categories/mercadolibre/MLA1`, {
    headers: { Authorization: 'Bearer ok' },
  });
  const body = await res.json();
  assert.equal(body.max_pictures, 8);
  assert.equal(body.max_pictures_per_var, 6);
});
