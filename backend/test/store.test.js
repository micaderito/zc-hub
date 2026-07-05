/**
 * Tests del mapeo SKU↔canal en memoria (store.js).
 *
 * Este mapeo es la fuente que usa sync/reintentar/revertir para resolver un SKU a su ítem de ML
 * o variante de TN. Vive solo en memoria y se llena con setResolutionFromAnalysis() (al correr el
 * análisis de Conflictos) o addResolution() (al vincular un par). Si el proceso se reinicia, el
 * mapeo queda vacío hasta que algo lo vuelve a poblar — de ahí el fallback en syncService.js
 * (ensureSkuResolved) que dispara un refresh cuando una búsqueda no encuentra nada.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setResolutionFromAnalysis,
  addResolution,
  getMlItemBySku,
  getTnVariantBySku,
  getResolvedSkus,
  getSkuByMlItem,
  getSkuByTnVariant,
} from '../src/store.js';

beforeEach(() => {
  setResolutionFromAnalysis([], []);
});

test('mapeo vacío al arrancar (o tras un reinicio): ninguna búsqueda encuentra nada', () => {
  assert.equal(getMlItemBySku('CREANDO'), null);
  assert.equal(getTnVariantBySku('CREANDO'), null);
  assert.deepEqual(getResolvedSkus(), []);
});

test('setResolutionFromAnalysis puebla ambos lados desde las filas de ML y TN', () => {
  setResolutionFromAnalysis(
    [{ sku: 'CREANDO', itemId: 'MLA1', variationId: '111' }],
    [{ sku: 'CREANDO', productId: 500, variantId: 900 }]
  );
  assert.deepEqual(getMlItemBySku('CREANDO'), { itemId: 'MLA1', variationId: '111' });
  assert.deepEqual(getTnVariantBySku('CREANDO'), { productId: 500, variantId: 900 });
  assert.equal(getSkuByMlItem('MLA1', '111'), 'CREANDO');
  assert.equal(getSkuByTnVariant(900), 'CREANDO');
});

test('setResolutionFromAnalysis reemplaza el estado anterior (no acumula entre llamadas)', () => {
  setResolutionFromAnalysis([{ sku: 'A', itemId: 'MLA1' }], [{ sku: 'A', productId: 1, variantId: 2 }]);
  setResolutionFromAnalysis([{ sku: 'B', itemId: 'MLA2' }], [{ sku: 'B', productId: 3, variantId: 4 }]);
  assert.equal(getMlItemBySku('A'), null, 'el SKU del análisis anterior no debe quedar');
  assert.deepEqual(getMlItemBySku('B'), { itemId: 'MLA2', variationId: undefined });
});

test('addResolution agrega un par sin borrar lo que ya estaba resuelto', () => {
  setResolutionFromAnalysis([{ sku: 'A', itemId: 'MLA1' }], [{ sku: 'A', productId: 1, variantId: 2 }]);
  addResolution({ sku: 'B', mercadolibre: { itemId: 'MLA2' }, tiendanube: { productId: 3, variantId: 4 } });
  assert.deepEqual(getMlItemBySku('A'), { itemId: 'MLA1', variationId: undefined });
  assert.deepEqual(getMlItemBySku('B'), { itemId: 'MLA2', variationId: undefined });
});

test('addResolution con datos parciales (solo un canal) no rompe la resolución del otro SKU', () => {
  addResolution({ sku: 'SOLO-ML', mercadolibre: { itemId: 'MLA9' } });
  assert.deepEqual(getMlItemBySku('SOLO-ML'), { itemId: 'MLA9', variationId: undefined });
  assert.equal(getTnVariantBySku('SOLO-ML'), null);
});

test('getResolvedSkus incluye SKU de ambos lados sin duplicar los que están en los dos', () => {
  setResolutionFromAnalysis(
    [{ sku: 'PAR', itemId: 'MLA1' }, { sku: 'SOLO-ML', itemId: 'MLA2' }],
    [{ sku: 'PAR', productId: 1, variantId: 2 }, { sku: 'SOLO-TN', productId: 3, variantId: 4 }]
  );
  const skus = getResolvedSkus().sort();
  assert.deepEqual(skus, ['PAR', 'SOLO-ML', 'SOLO-TN']);
});
