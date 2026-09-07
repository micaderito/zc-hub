import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainTextToHtml } from '../src/lib/richText.js';

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
