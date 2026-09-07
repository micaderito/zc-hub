/**
 * imageStore.js con backend de Supabase Storage. Necesita SUPABASE_URL/SUPABASE_SERVICE_KEY
 * seteadas y `node-fetch` mockeado ANTES de importar el módulo (lee las env vars una sola vez, al
 * cargar), así que vive en su propio archivo — node:test aísla cada archivo en su propio proceso.
 */
import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const state = { calls: [], responder: null };

function mockFetch(url, options = {}) {
  const call = { url: String(url), method: options.method || 'GET', headers: options.headers || {}, body: options.body };
  state.calls.push(call);
  if (state.responder) return Promise.resolve(state.responder(call));
  return Promise.resolve({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
}

let imageStore;
before(async () => {
  process.env.SUPABASE_URL = 'https://test-project.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'test-service-key';
  process.env.SUPABASE_BUCKET = 'product-images';
  mock.module('node-fetch', { exports: { default: mockFetch } });
  imageStore = await import('../src/services/imageStore.js');
});
beforeEach(() => {
  state.calls = [];
  state.responder = null;
});

test('usa el backend de Supabase cuando hay credenciales', () => {
  assert.equal(imageStore.__usingSupabaseForTests(), true);
});

test('saveImageBuffer: sube el original y el meta.json al bucket configurado', async () => {
  const saved = await imageStore.saveImageBuffer({ filename: 'foto.jpg', mime: 'image/jpeg', buffer: Buffer.from('data') });
  assert.ok(saved.id);
  const uploads = state.calls.filter((c) => c.method === 'POST');
  assert.equal(uploads.length, 2);
  assert.ok(uploads[0].url.includes(`/storage/v1/object/product-images/${saved.id}/original.jpg`));
  assert.equal(uploads[0].headers.Authorization, 'Bearer test-service-key');
  assert.ok(uploads[1].url.includes(`/storage/v1/object/product-images/${saved.id}/meta.json`));
});

test('getImage: descarga el original y el meta desde la URL pública del bucket', async () => {
  const id = 'abc123';
  state.responder = (call) => {
    if (call.url.endsWith(`${id}/meta.json`)) {
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(JSON.stringify({ mime: 'image/png', filename: 'x.png' })) };
    }
    if (call.url.endsWith(`${id}/original.png`)) {
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('binario') };
    }
    return { ok: false, status: 404, text: async () => 'not found' };
  };
  const got = await imageStore.getImage(id);
  assert.equal(got.buffer.toString('utf8'), 'binario');
  assert.equal(got.mime, 'image/png');
});

test('getImage: si el meta no existe, devuelve null sin pedir el original', async () => {
  state.responder = () => ({ ok: false, status: 404, text: async () => '' });
  assert.equal(await imageStore.getImage('no-existe'), null);
});

test('getImageUrl: URL pública determinística, usando la extensión real del meta', async () => {
  const id = 'deadbeef01';
  state.responder = (call) => {
    if (call.url.endsWith(`${id}/meta.json`)) {
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(JSON.stringify({ mime: 'image/webp', filename: 'x.webp' })) };
    }
    return { ok: false, status: 404, text: async () => '' };
  };
  const url = await imageStore.getImageUrl(id);
  assert.equal(url, `https://test-project.supabase.co/storage/v1/object/public/product-images/${id}/original.webp`);
});

test('getImageUrl: null si la imagen no existe', async () => {
  state.responder = () => ({ ok: false, status: 404, text: async () => '' });
  assert.equal(await imageStore.getImageUrl('no-existe'), null);
});

test('removeImage: borra por prefijo (todas las extensiones posibles + meta + thumb) en una sola llamada', async () => {
  await imageStore.removeImage('abc123');
  const deletes = state.calls.filter((c) => c.method === 'DELETE');
  assert.equal(deletes.length, 1);
  assert.ok(deletes[0].url.endsWith('/storage/v1/object/product-images'));
  const body = JSON.parse(deletes[0].body);
  assert.ok(body.prefixes.includes('abc123/meta.json'));
  assert.ok(body.prefixes.includes('abc123/thumb.jpg'));
});

test('purgeOld: no hace nada con Supabase (el borrado es en cascada, no por TTL de disco)', async () => {
  const removed = await imageStore.purgeOld(async () => false);
  assert.equal(removed, 0);
  assert.equal(state.calls.length, 0);
});
