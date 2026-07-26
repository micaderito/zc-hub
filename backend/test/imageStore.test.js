/**
 * Tests del store temporal de imágenes (guardar/leer/borrar + validaciones de mime y tamaño).
 * Escribe en data/tmp-images (disco real) y limpia lo que crea.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveImage, getImage, removeImage } from '../src/services/imageStore.js';

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
