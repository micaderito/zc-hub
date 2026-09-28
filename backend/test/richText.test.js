import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainTextToHtml, toMlPlainText } from '../src/lib/richText.js';

test('plainTextToHtml: texto vacío da string vacío', () => {
  assert.equal(plainTextToHtml(''), '');
  assert.equal(plainTextToHtml('   '), '');
  assert.equal(plainTextToHtml(undefined), '');
});

test('plainTextToHtml: doble salto de línea = párrafo nuevo, salto simple = <br>', () => {
  const out = plainTextToHtml('Primer párrafo.\nSegunda línea.\n\nSegundo párrafo.');
  assert.equal(out, '<p>Primer párrafo.<br>Segunda línea.</p><p>Segundo párrafo.</p>');
});

test('plainTextToHtml: escapa &, < y > del texto plano', () => {
  const out = plainTextToHtml('Café & medialunas < 3x1 > gratis');
  assert.equal(out, '<p>Café &amp; medialunas &lt; 3x1 &gt; gratis</p>');
});

test('plainTextToHtml: si ya trae HTML, lo deja pasar tal cual (no lo envuelve ni escapa de nuevo)', () => {
  const html = '<p>Ya tiene <strong>formato</strong></p><ul><li>Uno</li></ul>';
  assert.equal(plainTextToHtml(html), html);
});

test('plainTextToHtml: un <br> suelto también cuenta como HTML existente', () => {
  const html = 'Primera línea<br>Segunda línea';
  assert.equal(plainTextToHtml(html), html);
});

test('toMlPlainText: saca emojis y pictogramas, deja texto común (acentos, °, ×, –, •, ™)', () => {
  assert.equal(
    toMlPlainText('✔ Cuaderno A5 📒 de 80 hojas ✨️\n• 90° · 21 × 14,8 cm – tapa dura ♥\nMooving™ ©'),
    'Cuaderno A5 de 80 hojas\n• 90° · 21 × 14,8 cm – tapa dura\nMooving™ ©'
  );
});

test('toMlPlainText: saca invisibles (ancho cero, variantes) y normaliza nbsp y CRLF', () => {
  assert.equal(toMlPlainText('Cuaderno​A5 rayado️\r\nLínea 2'), 'CuadernoA5 rayado\nLínea 2');
});

test('toMlPlainText: HTML a texto (br y cierres de bloque = salto), entidades decodificadas', () => {
  assert.equal(
    toMlPlainText('<p>Cuaderno <b>A5</b></p><p>Tapa &amp; hojas<br>80 hojas</p>'),
    'Cuaderno A5\nTapa & hojas\n80 hojas'
  );
});

test('toMlPlainText: un "<" o ">" suelto no es HTML y se deja', () => {
  assert.equal(toMlPlainText('Medidas < 21 cm y > 14 cm'), 'Medidas < 21 cm y > 14 cm');
});

test('toMlPlainText: vacío o solo emojis → string vacío', () => {
  assert.equal(toMlPlainText(''), '');
  assert.equal(toMlPlainText(null), '');
  assert.equal(toMlPlainText('📒✨'), '');
});
