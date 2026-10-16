/**
 * Tests de lib/discountResolver.js: qué config de descuento le toca a cada SKU y a qué proveedores
 * pertenece. Puro, sin mocks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDiscountContext, resolveDiscount, suppliersOf, supplierKeyFromName } from '../src/lib/discountResolver.js';

const suppliers = [
  {
    key: 'punto_cero', name: 'Punto Cero', profiles: [
      { id: 1, name: 'General', discount1: 25, discount2: 5, isDefault: true },
      { id: 2, name: 'Agendas', discount1: 30, discount2: 5, isDefault: false },
      { id: 3, name: 'Liquidación', discount1: 40, discount2: 0, isDefault: false },
    ],
  },
  { key: 'bic', name: 'Bic', profiles: [{ id: 9, name: 'Sin descuento', discount1: 0, discount2: 0, isDefault: true }] },
];
const packs = [{ id: 7, skus: ['AG-ROSA', 'AG-AZUL'] }];

test('resolveDiscount: sin config propia ni de pack, la default del proveedor vigente', () => {
  const ctx = buildDiscountContext({ suppliers, packs, costs: [{ sku: 'CUAD', supplierKey: 'punto_cero' }] });
  assert.deepEqual(resolveDiscount('CUAD', ctx), { profileId: 1, name: 'General', discount1: 25, discount2: 5, level: 'default' });
});

test('resolveDiscount: la config del pack le gana a la default; la del SKU le gana a la del pack', () => {
  const ctx = buildDiscountContext({
    suppliers, packs,
    assignments: [
      { type: 'pack', id: '7', supplierKey: 'punto_cero', profileId: 2 },
      { type: 'sku', id: 'AG-AZUL', supplierKey: 'punto_cero', profileId: 3 },
    ],
    costs: [{ sku: 'AG-ROSA', supplierKey: 'punto_cero' }, { sku: 'AG-AZUL', supplierKey: 'punto_cero' }],
  });
  assert.equal(resolveDiscount('AG-ROSA', ctx).name, 'Agendas');
  assert.equal(resolveDiscount('AG-ROSA', ctx).level, 'pack');
  assert.equal(resolveDiscount('AG-AZUL', ctx).name, 'Liquidación');
  assert.equal(resolveDiscount('AG-AZUL', ctx).level, 'sku');
});

test('resolveDiscount: una fila del SKU sin config (null) no tapa la del pack', () => {
  const ctx = buildDiscountContext({
    suppliers, packs,
    assignments: [
      { type: 'pack', id: '7', supplierKey: 'punto_cero', profileId: 2 },
      { type: 'sku', id: 'AG-ROSA', supplierKey: 'punto_cero', profileId: null },
    ],
    costs: [{ sku: 'AG-ROSA', supplierKey: 'punto_cero' }],
  });
  assert.equal(resolveDiscount('AG-ROSA', ctx).name, 'Agendas');
});

test('resolveDiscount: se busca para el proveedor VIGENTE; la config de otro proveedor no aplica', () => {
  const ctx = buildDiscountContext({
    suppliers, packs,
    assignments: [{ type: 'pack', id: '7', supplierKey: 'punto_cero', profileId: 2 }],
    costs: [{ sku: 'AG-ROSA', supplierKey: 'bic' }],
  });
  assert.equal(resolveDiscount('AG-ROSA', ctx).name, 'Sin descuento');
  assert.equal(resolveDiscount('AG-ROSA', ctx, 'punto_cero').name, 'Agendas');
});

test('resolveDiscount: sin proveedor vigente, sin descuento', () => {
  const ctx = buildDiscountContext({ suppliers, packs, costs: [{ sku: 'X', supplierKey: null }] });
  assert.deepEqual(resolveDiscount('X', ctx), { profileId: null, name: null, discount1: 0, discount2: 0, level: 'none' });
});

test('suppliersOf: junta asignaciones, códigos mapeados (también del pack) y vigente, el vigente primero', () => {
  const ctx = buildDiscountContext({
    suppliers, packs,
    assignments: [{ type: 'sku', id: 'AG-ROSA', supplierKey: 'punto_cero', profileId: null }],
    packCodeMap: [{ packId: 7, supplier: 'punto_cero' }],
    skuCodeMap: [{ sku: 'AG-ROSA', supplier: 'bic' }],
    costs: [{ sku: 'AG-ROSA', supplierKey: 'bic' }],
  });
  assert.deepEqual(suppliersOf('AG-ROSA', ctx), ['bic', 'punto_cero']);
  assert.deepEqual(suppliersOf('AG-AZUL', ctx), ['punto_cero']);
  assert.deepEqual(suppliersOf('NADA', ctx), []);
});

test('supplierKeyFromName: slug sin acentos ni símbolos', () => {
  assert.equal(supplierKeyFromName('Bic Argentina'), 'bic_argentina');
  assert.equal(supplierKeyFromName('  Filgo / Librería Ñandú '), 'filgo_libreria_nandu');
});
