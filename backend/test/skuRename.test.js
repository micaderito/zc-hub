/** Tests de skuRename.js: qué cambio de la foto del catálogo cuenta como renombre de SKU. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skuIndex, detectSkuRenames } from '../src/services/skuRename.js';

const ml = (itemId, variationId, sku) => ({ itemId, variationId, sku });
const tn = (productId, variantId, sku) => ({ productId, variantId, sku });
const snap = (mlRows, tnRows = []) => ({ mlRows, tnRows });
const detect = (before, after) => detectSkuRenames(skuIndex(before), after);

test('las dos puntas pasan de A a B → se renombra', () => {
  const r = detect(snap([ml('MLA1', 1, 'A')], [tn(5, 50, 'A')]), snap([ml('MLA1', 1, 'B')], [tn(5, 50, 'B')]));
  assert.deepEqual(r.renames, [{ from: 'A', to: 'B' }]);
});

test('solo ML cambia y TN sigue con A → no se mueve (A sigue en uso)', () => {
  const r = detect(snap([ml('MLA1', 1, 'A')], [tn(5, 50, 'A')]), snap([ml('MLA1', 1, 'B')], [tn(5, 50, 'A')]));
  assert.deepEqual(r.renames, []);
  assert.equal(r.skipped[0].reason, 'in_use');
});

test('un SKU que solo estaba en TN se renombra solo con TN', () => {
  const r = detect(snap([], [tn(5, 50, 'A')]), snap([], [tn(5, 50, 'B')]));
  assert.deepEqual(r.renames, [{ from: 'A', to: 'B' }]);
});

test('Vincular: TN pasa a usar el SKU de ML que ya existía → B → A', () => {
  const r = detect(snap([ml('MLA1', null, 'A')], [tn(5, 50, 'B')]), snap([ml('MLA1', null, 'A')], [tn(5, 50, 'A')]));
  assert.deepEqual(r.renames, [{ from: 'B', to: 'A' }]);
});

test('A se parte en dos SKUs distintos → ambiguo, no se toca', () => {
  const r = detect(snap([ml('MLA1', 1, 'A')], [tn(5, 50, 'A')]), snap([ml('MLA1', 1, 'B')], [tn(5, 50, 'C')]));
  assert.deepEqual(r.renames, []);
  assert.equal(r.skipped[0].reason, 'ambiguous');
});

test('la publicación desaparece o le sacan el SKU → no es renombre', () => {
  assert.deepEqual(detect(snap([ml('MLA1', 1, 'A')]), snap([])).renames, []);
  assert.deepEqual(detect(snap([ml('MLA1', 1, 'A')]), snap([ml('MLA1', 1, '')])).renames, []);
  assert.deepEqual(detect(snap([ml('MLA1', 1, null)]), snap([ml('MLA1', 1, 'B')])).renames, []);
});

test('una fila nueva con otro SKU no cuenta como renombre', () => {
  assert.deepEqual(detect(snap([ml('MLA1', 1, 'A')]), snap([ml('MLA1', 1, 'A'), ml('MLA1', 2, 'B')])).renames, []);
});

test('intercambio A ↔ B entre dos productos → los dos siguen en uso, no se mueve nada', () => {
  const r = detect(snap([ml('MLA1', null, 'A'), ml('MLA2', null, 'B')]), snap([ml('MLA1', null, 'B'), ml('MLA2', null, 'A')]));
  assert.deepEqual(r.renames, []);
});

test('sin foto previa (arranque) no se detecta nada', () => {
  assert.deepEqual(detectSkuRenames(null, snap([ml('MLA1', 1, 'B')])).renames, []);
});

test('espacios alrededor del SKU no cuentan como cambio', () => {
  assert.deepEqual(detect(snap([ml('MLA1', 1, 'A')]), snap([ml('MLA1', 1, ' A ')])).renames, []);
});
