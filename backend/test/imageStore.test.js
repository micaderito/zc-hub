/**
 * Tests del store temporal de imágenes (guardar/leer/borrar + validaciones de mime y tamaño).
 * Escribe en data/tmp-images (disco real) y limpia lo que crea.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveImage, saveImageBuffer, getImage, removeImage } from '../src/services/imageStore.js';

test('saveImage + getImage: guarda y recupera el binario, mime y filename', () => {
  const data = Buffer.from('contenido-de-prueba').toString('base64');
  const saved = saveImage({ filename: 'foto rara!.jpg', mime: 'image/jpeg', data });
  try {
    assert.ok(saved.id);
    assert.equal(saved.mime, 'image/jpeg');
    // el filename se sanea (espacios/símbolos → _).
    assert.match(saved.name, /^foto_rara_\.jpg$|^foto_rara_.jpg$/);
    const got = getImage(saved.id);
    assert.equal(got.buffer.toString('utf8'), 'contenido-de-prueba');
    assert.equal(got.mime, 'image/jpeg');
  } finally {
    removeImage(saved.id);
  }
  assert.equal(getImage(saved.id), null);
});

test('saveImage: quita el prefijo data:...;base64,', () => {
  const raw = Buffer.from('abc').toString('base64');
  const saved = saveImage({ filename: 'a.png', mime: 'image/png', data: `data:image/png;base64,${raw}` });
  try {
    assert.equal(getImage(saved.id).buffer.toString('utf8'), 'abc');
  } finally {
    removeImage(saved.id);
  }
});

test('saveImage: rechaza mime no permitido con 400', () => {
  assert.throws(
    () => saveImage({ filename: 'x.pdf', mime: 'application/pdf', data: Buffer.from('x').toString('base64') }),
    (e) => e.statusCode === 400 && /Formato no permitido/.test(e.message)
  );
});

test('saveImage: rechaza imagen vacía con 400', () => {
  assert.throws(
    () => saveImage({ filename: 'x.jpg', mime: 'image/jpeg', data: '' }),
    (e) => e.statusCode === 400
  );
});

test('getImage: id inválido o inexistente devuelve null', () => {
  assert.equal(getImage('no-existe-zzz'), null);
  assert.equal(getImage(''), null);
});

/*
 * saveImageBuffer: el paso común que ahora usa también la subida binaria cruda desde el front
 * (POST /api/products/images con Content-Type: image/*, ver routes/products.js) — evita el
 * round-trip por base64/JSON que era la causa principal de la página trabada al cargar fotos.
 * saveImage() (base64) es solo un decode + delegar acá, así que sus tests de arriba ya cubren esa
 * parte; estos cubren el nuevo camino directo con Buffer.
 */
test('saveImageBuffer: guarda y recupera el binario tal cual (sin pasar por base64)', () => {
  const buffer = Buffer.from('foto-binaria-de-prueba');
  const saved = saveImageBuffer({ filename: 'foto.jpg', mime: 'image/jpeg', buffer });
  try {
    assert.ok(saved.id);
    assert.equal(saved.size, buffer.length);
    const got = getImage(saved.id);
    assert.equal(got.buffer.toString('utf8'), 'foto-binaria-de-prueba');
    assert.equal(got.mime, 'image/jpeg');
  } finally {
    removeImage(saved.id);
  }
});

test('saveImageBuffer: mismas validaciones que saveImage (mime no permitido, vacía, tamaño)', () => {
  assert.throws(
    () => saveImageBuffer({ filename: 'x.pdf', mime: 'application/pdf', buffer: Buffer.from('x') }),
    (e) => e.statusCode === 400 && /Formato no permitido/.test(e.message)
  );
  assert.throws(
    () => saveImageBuffer({ filename: 'x.jpg', mime: 'image/jpeg', buffer: Buffer.alloc(0) }),
    (e) => e.statusCode === 400
  );
  assert.throws(
    () => saveImageBuffer({ filename: 'x.jpg', mime: 'image/jpeg', buffer: Buffer.alloc(11 * 1024 * 1024) }),
    (e) => e.statusCode === 400 && /10 MB/.test(e.message)
  );
});
