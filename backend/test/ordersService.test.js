/**
 * Tests de los helpers puros de ordersService.js (Pedidos al proveedor): código/descr./precio de
 * cada unidad de compra, sugerido en packs, último pedido / en camino, totales con descuentos
 * encadenados, refresco de precios y duplicado (todo o solo faltantes). Sin base de datos.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listUnitPrice, packListPrice, resolvePackCode, suggestPacks, buildOrderHistoryIndex, buildCatalog,
  computeOrderTotals, buildPriceIndex, refreshLinePrices, buildDuplicateLines, sanitizeOrderInput,
} from '../src/services/ordersService.js';

const PACK_CI = { id: 1, name: 'Cuadernos inteligentes', sku: 'PK-CI', unitCount: 8, mode: 'assorted', skus: ['CI-1', 'CI-2', 'CI-3'] };
const PACK_RH = { id: 2, name: 'Repuestos A5', sku: null, unitCount: 8, mode: 'single', skus: ['RH-1'] };

test('listUnitPrice: precio de lista por unidad del bulto, null sin bulto', () => {
  assert.equal(listUnitPrice({ bulkPrice: 12000, bulkQty: 12 }), 1000);
  assert.equal(listUnitPrice({ bulkPrice: null, bulkQty: 12, unitCost: 900 }), null);
  assert.equal(listUnitPrice(undefined), null);
});

test('packListPrice: unidad × unidades del pack, tomando el primer modelo con bulto', () => {
  const costs = new Map([['CI-2', { bulkPrice: 24000, bulkQty: 2 }]]);
  assert.equal(packListPrice(PACK_CI, costs), 96000);
  assert.equal(packListPrice(PACK_RH, costs), null);
});

test('resolvePackCode: mapeo de Precios > SKU propio del pack > código del único modelo', () => {
  const skuCodes = new Map([['RH-1', '3305']]);
  assert.equal(resolvePackCode(PACK_CI, new Map([[1, '4410-SUR']]), skuCodes), '4410-SUR');
  assert.equal(resolvePackCode(PACK_CI, new Map(), skuCodes), 'PK-CI');
  assert.equal(resolvePackCode(PACK_RH, new Map(), skuCodes), '3305');
  assert.equal(resolvePackCode({ ...PACK_CI, sku: null }, new Map(), skuCodes), null);
});

test('suggestPacks: manda el modelo con alerta activa que más falta; null sin alertas activas', () => {
  const members = [
    { alertState: 'out', threshold: 3, stockEffective: 0 },       // faltan 3
    { alertState: 'still-low', threshold: 3, stockEffective: 2 }, // falta 1
    { alertState: 'restocked', threshold: 3, stockEffective: 9 },
  ];
  // pack de 8 con 3 modelos → 2 de cada uno → ceil(3/2) = 2 packs
  assert.equal(suggestPacks(members, 8, 3), 2);
  assert.equal(suggestPacks([{ alertState: 'restocked', threshold: 3, stockEffective: 9 }], 8, 3), null);
  assert.equal(suggestPacks([{ alertState: 'watching', threshold: 3, stockEffective: 1 }], 8, 1), null);
});

test('buildOrderHistoryIndex: último pedido y en camino, sin contar borradores', () => {
  const orders = [
    { id: 3, name: 'Borrador', status: 'borrador', createdAt: 'c3', lines: [{ kind: 'pack', packId: 1, qty: 9 }] },
    { id: 2, name: 'Septiembre', status: 'pendiente', orderedAt: 'o2', lines: [{ kind: 'pack', packId: 1, qty: 2 }] },
    { id: 1, name: 'Agosto', status: 'recibido', orderedAt: 'o1', lines: [{ kind: 'pack', packId: 1, qty: 3 }, { kind: 'sku', sku: 'LG', qty: 1 }, { kind: 'free', qty: 1 }] },
  ];
  const { last, pending } = buildOrderHistoryIndex(orders);
  assert.deepEqual(last.get('pack:1'), { orderId: 2, orderName: 'Septiembre', date: 'o2', qty: 2 });
  assert.equal(last.get('sku:LG').orderId, 1);
  assert.deepEqual(pending.get('pack:1'), { orderId: 2, orderName: 'Septiembre' });
  assert.equal(pending.has('sku:LG'), false);
});

test('buildCatalog: packs con todos sus modelos + SKUs sueltos por bulto, con código/descr./precio/depósito', () => {
  const units = buildCatalog({
    packs: [PACK_CI],
    snapshotData: {
      mlRows: [
        { sku: 'CI-1', title: 'Cuaderno A5', variationName: 'rayado', stock: 0 },
        { sku: 'CI-2', title: 'Cuaderno A4', variationName: null, stock: 6 },
        { sku: 'CI-3', title: 'Cuaderno A5 liso', variationName: null, stock: 7 },
        { sku: 'LG', title: 'Lapicera gel', variationName: null, stock: 4 },
      ],
      tnRows: [{ sku: 'NA', productName: 'Notas adhesivas', variantName: null, stock: 9 }],
    },
    restockRows: [{ sku: 'CI-1', state: 'out', threshold: 2 }, { sku: 'LG', state: 'still-low', threshold: 5 }],
    rules: [{ sku: 'CI-1', threshold: 2 }, { sku: 'LG', threshold: 5 }, { sku: 'NA', threshold: 3 }],
    costs: [{ sku: 'CI-1', bulkPrice: 96000, bulkQty: 8 }, { sku: 'LG', bulkPrice: 14400, bulkQty: 12 }],
    skuCodeMap: [{ sku: 'LG', code: 'GEL-07N' }],
    packCodeMap: [{ packId: 1, code: '4410-SUR' }],
    codeDescriptions: new Map([['4410-SUR', 'CUADERNO INTELIGENTE SURTIDO X8']]),
    depositoBySku: new Map([['CI-1', 8], ['LG', 20]]),
    orders: [],
  });

  const ci = units.find((u) => u.key === 'pack:1');
  assert.equal(ci.code, '4410-SUR');
  assert.equal(ci.description, 'CUADERNO INTELIGENTE SURTIDO X8');
  assert.equal(ci.price, 96000);
  assert.equal(ci.members.length, 3, 'muestra todos los modelos aunque haya avisado uno solo');
  assert.equal(ci.alerted, true);
  assert.equal(ci.depositoStock, 8);
  assert.equal(ci.suggestedQty, 1); // falta 2 de CI-1, 8/3 → 2 por modelo → 1 pack
  assert.equal(ci.members[0].label, 'Cuaderno A5 (rayado)');

  const lg = units.find((u) => u.key === 'sku:LG');
  assert.equal(lg.unitsPerPack, 12, 'sin pack se pide por el bulto de Precios');
  assert.equal(lg.price, 14400);
  assert.equal(lg.code, 'GEL-07N');
  assert.equal(lg.description, 'Lapicera gel', 'sin descripción del proveedor, el nombre del producto');
  assert.equal(lg.suggestedQty, 1);

  const na = units.find((u) => u.key === 'sku:NA');
  assert.equal(na.unitsPerPack, 1);
  assert.equal(na.price, null);
  assert.equal(na.alerted, false);
  assert.equal(na.members[0].alertState, 'watching');
  assert.ok(!units.some((u) => u.key === 'sku:CI-1'), 'un SKU que está en un pack no aparece suelto');
});

test('computeOrderTotals: 25% sobre el subtotal y 5% sobre lo que queda; las líneas sin precio no suman', () => {
  const t = computeOrderTotals({
    discount1: 25, discount2: 5,
    lines: [{ qty: 2, unitPrice: 96000 }, { qty: 1, unitPrice: 42000 }, { qty: 3, unitPrice: null }],
  });
  assert.equal(t.subtotal, 234000);
  assert.equal(t.discount1Amount, 58500);
  assert.equal(t.discount2Amount, 8775);
  assert.equal(t.total, 166725);
  assert.equal(t.packs, 6);
  assert.equal(t.missingPrices, 1);
});

test('refreshLinePrices: actualiza las "de Precios", no toca las editadas ni los ítems libres', () => {
  const index = buildPriceIndex([PACK_CI], [{ sku: 'CI-1', bulkPrice: 104000, bulkQty: 8 }, { sku: 'LG', bulkPrice: 15000, bulkQty: 12 }]);
  const out = refreshLinePrices([
    { kind: 'pack', packId: 1, unitPrice: 96000, priceSource: 'precios' },
    { kind: 'sku', sku: 'LG', unitPrice: 9999, priceSource: 'manual' },
    { kind: 'sku', sku: 'LG', unitPrice: 14400, priceSource: 'precios' },
    { kind: 'free', unitPrice: 42000, priceSource: 'manual' },
  ], index);
  assert.deepEqual(out.map((l) => l.unitPrice), [104000, 9999, 15000, 42000]);
});

test('buildDuplicateLines: todo, o solo lo que faltó con la cantidad faltante', () => {
  const order = {
    lines: [
      { kind: 'pack', packId: 1, qty: 3, receivedQty: 3, priceSource: 'precios', origin: 'alerta' },
      { kind: 'pack', packId: 2, qty: 2, receivedQty: 1, priceSource: 'precios', origin: 'manual' },
      { kind: 'free', qty: 1, receivedQty: 0, code: '5520', priceSource: 'manual', origin: 'libre' },
    ],
  };
  const all = buildDuplicateLines(order, 'all');
  assert.equal(all.length, 3);
  assert.ok(all.every((l) => l.receivedQty === null));
  assert.deepEqual(all.map((l) => l.origin), ['copia', 'copia', 'libre']);

  const missing = buildDuplicateLines(order, 'missing');
  assert.deepEqual(missing.map((l) => [l.kind, l.qty]), [['pack', 1], ['free', 1]]);
});

test('sanitizeOrderInput: valida nombre, descuentos y líneas; ítem libre siempre a mano', () => {
  assert.ok(sanitizeOrderInput({ name: '', discount1: 25, discount2: 5, lines: [] }).error);
  assert.ok(sanitizeOrderInput({ name: 'X', discount1: 120, discount2: 5, lines: [] }).error);
  assert.ok(sanitizeOrderInput({ name: 'X', discount1: 25, discount2: 5, lines: [{ kind: 'pack', qty: 1 }] }).error);
  assert.ok(sanitizeOrderInput({ name: 'X', discount1: 25, discount2: 5, lines: [{ kind: 'free', qty: 0 }] }).error);
  const { value } = sanitizeOrderInput({
    name: ' Pedido ', discount1: '25', discount2: 5,
    lines: [{ kind: 'free', qty: 2, code: ' 5520 ', description: 'Planner', unitPrice: '', priceSource: 'precios' }],
  });
  assert.equal(value.name, 'Pedido');
  assert.equal(value.discount1, 25);
  assert.equal(value.lines[0].code, '5520');
  assert.equal(value.lines[0].unitPrice, null);
  assert.equal(value.lines[0].priceSource, 'manual');
  assert.equal(value.lines[0].origin, 'libre');
});
