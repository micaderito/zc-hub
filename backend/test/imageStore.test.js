/**
 * Tests del store de imágenes (guardar/leer/borrar + validaciones de mime y tamaño), backend de
 * disco local (sin SUPABASE_URL/SUPABASE_SERVICE_KEY en el proceso de test, cae solo). El backend
 * de Supabase Storage se cubre aparte en imageStoreSupabase.test.js (necesita mockear fetch antes
 * de importar el módulo, así que no puede compartir proceso con este archivo).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  saveImage, saveImageBuffer, saveThumbBuffer, getImage, getImageUrl, getThumb, removeImage, purgeOld, MAX_THUMB_BYTES,
  __usingSupabaseForTests
} from '../src/services/imageStore.js';

test('el proceso de test no tiene credenciales de Supabase: usa el disco local', () => {
  assert.equal(__usingSupabaseForTests(), false);
});

test('saveImage + getImage: guarda y recupera el binario, mime y filename', async () => {
  const data = Buffer.from('contenido-de-prueba').toString('base64');
  const saved = await saveImage({ filename: 'foto rara!.jpg', mime: 'image/jpeg', data });
  try {
    assert.ok(saved.id);
    assert.equal(saved.mime, 'image/jpeg');
    // el filename se sanea (espacios/símbolos → _).
    assert.match(saved.name, /^foto_rara_\.jpg$|^foto_rara_.jpg$/);
    const got = await getImage(saved.id);
    assert.equal(got.buffer.toString('utf8'), 'contenido-de-prueba');
    assert.equal(got.mime, 'image/jpeg');
  } finally {
    await removeImage(saved.id);
  }
  assert.equal(await getImage(saved.id), null);
});

test('saveImage: quita el prefijo data:...;base64,', async () => {
  const raw = Buffer.from('abc').toString('base64');
  const saved = await saveImage({ filename: 'a.png', mime: 'image/png', data: `data:image/png;base64,${raw}` });
  try {
    assert.equal((await getImage(saved.id)).buffer.toString('utf8'), 'abc');
  } finally {
    await removeImage(saved.id);
  }
});

test('saveImage: rechaza mime no permitido con 400', async () => {
  await assert.rejects(
    () => saveImage({ filename: 'x.pdf', mime: 'application/pdf', data: Buffer.from('x').toString('base64') }),
    (e) => e.statusCode === 400 && /Formato no permitido/.test(e.message)
  );
});

test('saveImage: rechaza imagen vacía con 400', async () => {
  await assert.rejects(
    () => saveImage({ filename: 'x.jpg', mime: 'image/jpeg', data: '' }),
    (e) => e.statusCode === 400
  );
});

test('getImage: id inválido o inexistente devuelve null', async () => {
  assert.equal(await getImage('no-existe-zzz'), null);
  assert.equal(await getImage(''), null);
});

test('getImageUrl: sin Supabase configurado, siempre null (no hay URL pública que servir)', async () => {
  const saved = await saveImageBuffer({ filename: 'f.jpg', mime: 'image/jpeg', buffer: Buffer.from('x') });
  try {
    assert.equal(await getImageUrl(saved.id), null);
  } finally {
    await removeImage(saved.id);
  }
});

/*
 * saveImageBuffer: el paso común que también usa la subida binaria cruda desde el front
 * (POST /api/products/images con Content-Type: image/*, ver routes/products.js) — evita el
 * round-trip por base64/JSON que era la causa principal de la página trabada al cargar fotos.
 */
test('saveImageBuffer: guarda y recupera el binario tal cual (sin pasar por base64)', async () => {
  const buffer = Buffer.from('foto-binaria-de-prueba');
  const saved = await saveImageBuffer({ filename: 'foto.jpg', mime: 'image/jpeg', buffer });
  try {
    assert.ok(saved.id);
    assert.equal(saved.size, buffer.length);
    const got = await getImage(saved.id);
    assert.equal(got.buffer.toString('utf8'), 'foto-binaria-de-prueba');
    assert.equal(got.mime, 'image/jpeg');
  } finally {
    await removeImage(saved.id);
  }
});

test('saveImageBuffer: mismas validaciones que saveImage (mime no permitido, vacía, tamaño)', async () => {
  await assert.rejects(
    () => saveImageBuffer({ filename: 'x.pdf', mime: 'application/pdf', buffer: Buffer.from('x') }),
    (e) => e.statusCode === 400 && /Formato no permitido/.test(e.message)
  );
  await assert.rejects(
    () => saveImageBuffer({ filename: 'x.jpg', mime: 'image/jpeg', buffer: Buffer.alloc(0) }),
    (e) => e.statusCode === 400
  );
  await assert.rejects(
    () => saveImageBuffer({ filename: 'x.jpg', mime: 'image/jpeg', buffer: Buffer.alloc(11 * 1024 * 1024) }),
    (e) => e.statusCode === 400 && /10 MB/.test(e.message)
  );
});

/* ───────────── miniaturas ───────────── */

test('saveThumbBuffer + getThumb: round-trip de la miniatura', async () => {
  const saved = await saveImageBuffer({ filename: 'f.jpg', mime: 'image/jpeg', buffer: Buffer.from('original') });
  try {
    assert.equal(await getThumb(saved.id), null); // todavía no hay miniatura
    await saveThumbBuffer(saved.id, Buffer.from('mini'));
    const thumb = await getThumb(saved.id);
    assert.equal(thumb.buffer.toString('utf8'), 'mini');
    assert.equal(thumb.mime, 'image/jpeg');
    // El original queda intacto: es el que se publica en ML/TN.
    assert.equal((await getImage(saved.id)).buffer.toString('utf8'), 'original');
  } finally {
    await removeImage(saved.id);
  }
});

test('saveThumbBuffer: 404 si la imagen no existe, 400 si está vacía o es enorme', async () => {
  await assert.rejects(
    () => saveThumbBuffer('deadbeefdeadbeefdeadbeefdeadbeef', Buffer.from('x')),
    (e) => e.statusCode === 404
  );
  const saved = await saveImageBuffer({ filename: 'f.jpg', mime: 'image/jpeg', buffer: Buffer.from('x') });
  try {
    await assert.rejects(() => saveThumbBuffer(saved.id, Buffer.alloc(0)), (e) => e.statusCode === 400);
    await assert.rejects(
      () => saveThumbBuffer(saved.id, Buffer.alloc(MAX_THUMB_BYTES + 1)),
      (e) => e.statusCode === 400
    );
  } finally {
    await removeImage(saved.id);
  }
});

test('removeImage: borra también la miniatura', async () => {
  const saved = await saveImageBuffer({ filename: 'f.jpg', mime: 'image/jpeg', buffer: Buffer.from('x') });
  await saveThumbBuffer(saved.id, Buffer.from('mini'));
  await removeImage(saved.id);
  assert.equal(await getImage(saved.id), null);
  assert.equal(await getThumb(saved.id), null);
});

test('purgeOld: borra lo vencido y sin referencia, respeta lo reciente y lo referenciado', async () => {
  const viejo = await saveImageBuffer({ filename: 'v.jpg', mime: 'image/jpeg', buffer: Buffer.from('viejo') });
  const nuevo = await saveImageBuffer({ filename: 'n.jpg', mime: 'image/jpeg', buffer: Buffer.from('nuevo') });
  const viejoReferenciado = await saveImageBuffer({ filename: 'r.jpg', mime: 'image/jpeg', buffer: Buffer.from('ref') });
  await saveThumbBuffer(viejo.id, Buffer.from('mini'));
  try {
    // "ahora" 100 días en el futuro: el TTL (72 h) ya venció para los tres, pero solo purgamos
    // pasando un now explícito para no depender del reloj real. isReferenced deja vivo lo que
    // todavía pertenece a un borrador o job (ver backend/src/index.js).
    const isReferenced = async (id) => id === viejoReferenciado.id;
    const removed = await purgeOld(isReferenced, Date.now() + 100 * 24 * 60 * 60 * 1000);
    assert.ok(removed >= 2);
    assert.equal(await getImage(viejo.id), null);
    assert.equal(await getThumb(viejo.id), null);
    assert.equal(await getImage(nuevo.id), null);
    assert.ok(await getImage(viejoReferenciado.id)); // vencido pero referenciado: no se toca
  } finally {
    await removeImage(viejo.id);
    await removeImage(nuevo.id);
    await removeImage(viejoReferenciado.id);
  }
});
