/**
 * Tests de las funciones puras de salesService.js (dashboard de ventas de ML por provincia, ver
 * CLAUDE.md → "Alertas de stock: sugerencia de reposición por pack" y el plan del dashboard).
 *
 * Cubre:
 * 1) normalizeStateName: variantes de CABA, sin envío → "Sin provincia".
 * 2) classifyOrder: paid → facturada; cancelled/no pagada → cancelada; envío devuelto → devuelta.
 * 3) buildOrderRow: items_amount = Σ unit_price × quantity SIN envío; unidades y fees.
 * 4) computePreviousPeriod: mismo largo, inmediatamente anterior.
 * 5) aggregateSalesReport: totales por provincia, comparativa vs. período anterior, que las
 *    excluidas (canceladas/devueltas) no sumen al facturado pero sí al conteo de auditoría, y que
 *    "ventas" cuente paquetes (pack_id) — no líneas de orden — para no contar cada producto de un
 *    carrito como una venta aparte (incidente 2026-08-19: un pack de 9 productos se veía como "9
 *    ventas" en vez de 1; el Excel de ML de esa cuenta lo confirmó).
 *
 * No mockea nada: son funciones puras (sin red ni base) por diseño, justamente para poder
 * testearlas así.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeStateName,
  classifyOrder,
  buildOrderRow,
  computePreviousPeriod,
  aggregateSalesReport,
} from '../src/services/salesService.js';

// ─── normalizeStateName ───────────────────────────────────────────────────────

test('normalizeStateName: variantes de CABA se unifican', () => {
  assert.equal(normalizeStateName('Capital Federal'), 'CABA');
  assert.equal(normalizeStateName('Ciudad Autónoma de Buenos Aires'), 'CABA');
  assert.equal(normalizeStateName('CABA'), 'CABA');
  assert.equal(normalizeStateName('  capital federal  '), 'CABA');
});

test('normalizeStateName: provincia normal se conserva tal cual', () => {
  assert.equal(normalizeStateName('Córdoba'), 'Córdoba');
});

test('normalizeStateName: sin envío (null/vacío) → "Sin provincia"', () => {
  assert.equal(normalizeStateName(null), 'Sin provincia');
  assert.equal(normalizeStateName(undefined), 'Sin provincia');
  assert.equal(normalizeStateName('   '), 'Sin provincia');
});

// ─── classifyOrder ─────────────────────────────────────────────────────────────

test('classifyOrder: orden pagada sin problemas de envío → facturada', () => {
  const out = classifyOrder({ status: 'paid' }, null);
  assert.deepEqual(out, { computedStatus: 'facturada', exclusionReason: null });
});

test('classifyOrder: orden cancelled → cancelada', () => {
  const out = classifyOrder({ status: 'cancelled' }, null);
  assert.equal(out.computedStatus, 'cancelada');
  assert.equal(out.exclusionReason, 'cancelada_ml');
});

test('classifyOrder: orden que nunca se pagó (invalid) → cancelada', () => {
  const out = classifyOrder({ status: 'invalid' }, null);
  assert.equal(out.computedStatus, 'cancelada');
  assert.equal(out.exclusionReason, 'no_pagada');
});

test('classifyOrder: pagada con envío en "returning_to_sender" → devuelta', () => {
  const out = classifyOrder({ status: 'paid' }, { status: 'shipped', substatus: 'returning_to_sender' });
  assert.equal(out.computedStatus, 'devuelta');
  assert.equal(out.exclusionReason, 'envio_devuelto');
});

test('classifyOrder: pagada con envío status "returned" → devuelta', () => {
  const out = classifyOrder({ status: 'paid' }, { status: 'returned' });
  assert.equal(out.computedStatus, 'devuelta');
});

test('classifyOrder: pagada con envío "delivered" (llegó bien) → facturada', () => {
  const out = classifyOrder({ status: 'paid' }, { status: 'delivered' });
  assert.equal(out.computedStatus, 'facturada');
});

// ─── buildOrderRow ─────────────────────────────────────────────────────────────

function makeOrder(overrides = {}) {
  return {
    id: 1001,
    status: 'paid',
    date_created: '2026-07-10T12:00:00.000-03:00',
    order_items: [
      { item: { id: 'MLA1', title: 'Cuaderno A4', seller_sku: 'CUAD-A4' }, quantity: 2, unit_price: 1000, sale_fee: 80 },
      { item: { id: 'MLA2', title: 'Agenda 2027', seller_sku: 'AGE-2027' }, quantity: 1, unit_price: 500, sale_fee: 40 },
    ],
    payments: [{ transaction_amount: 2500, shipping_cost: 300 }],
    shipping: { id: 555 },
    ...overrides,
  };
}

test('buildOrderRow: items_amount es la suma de unit_price × quantity, SIN el envío', () => {
  const { row } = buildOrderRow(makeOrder(), { status: 'delivered' });
  // 2*1000 + 1*500 = 2500 — el shipping_cost (300) del pago no debe sumarse acá.
  assert.equal(row.itemsAmount, 2500);
  assert.equal(row.shippingCost, 300);
});

test('buildOrderRow: unidades y comisiones son la suma de los ítems', () => {
  const { row } = buildOrderRow(makeOrder(), null);
  assert.equal(row.units, 3);
  assert.equal(row.mlFees, 120);
});

test('buildOrderRow: arma un ítem por línea con su SKU', () => {
  const { items } = buildOrderRow(makeOrder(), null);
  assert.equal(items.length, 2);
  assert.equal(items[0].sku, 'CUAD-A4');
  assert.equal(items[0].unitPrice, 1000);
  assert.equal(items[1].sku, 'AGE-2027');
});

test('buildOrderRow: computed_status viaja desde classifyOrder', () => {
  const { row: facturada } = buildOrderRow(makeOrder(), { status: 'delivered' });
  assert.equal(facturada.computedStatus, 'facturada');

  const { row: cancelada } = buildOrderRow(makeOrder({ status: 'cancelled' }), null);
  assert.equal(cancelada.computedStatus, 'cancelada');
});

// ─── computePreviousPeriod ─────────────────────────────────────────────────────

test('computePreviousPeriod: mismo largo en días, no el mes calendario anterior', () => {
  // Julio tiene 31 días: el período anterior de igual largo termina el 30/6 (el día antes del
  // 1/7) y arranca 31 días antes de eso — 31/5, no 1/6 (junio tiene 30 días).
  const { prevFrom, prevTo } = computePreviousPeriod(
    '2026-07-01T00:00:00.000Z',
    '2026-07-31T23:59:59.999Z'
  );
  assert.equal(prevTo.slice(0, 10), '2026-06-30');
  assert.equal(prevFrom.slice(0, 10), '2026-05-31');
});

test('computePreviousPeriod: rango de una semana → semana anterior, mismo largo', () => {
  const { prevFrom, prevTo } = computePreviousPeriod(
    '2026-07-08T00:00:00.000Z',
    '2026-07-14T23:59:59.999Z'
  );
  assert.equal(prevFrom.slice(0, 10), '2026-07-01');
  assert.equal(prevTo.slice(0, 10), '2026-07-07');
});

// ─── aggregateSalesReport ───────────────────────────────────────────────────────

let rowSeq = 0;
function row({ dateCreated, computedStatus = 'facturada', stateName = 'CABA', itemsAmount = 1000, units = 1, orderId, packId = null }) {
  rowSeq += 1;
  return { orderId: orderId ?? `order-${rowSeq}`, packId, dateCreated, computedStatus, stateName, itemsAmount, units };
}

test('aggregateSalesReport: totales por provincia y % del total', () => {
  const rows = [
    row({ dateCreated: '2026-07-05T12:00:00Z', stateName: 'Buenos Aires', itemsAmount: 3000, units: 3 }),
    row({ dateCreated: '2026-07-06T12:00:00Z', stateName: 'CABA', itemsAmount: 1000, units: 1 }),
  ];
  const out = aggregateSalesReport(rows, {
    from: '2026-07-01T00:00:00.000Z', to: '2026-07-31T23:59:59.999Z',
    prevFrom: '2026-06-01T00:00:00.000Z', prevTo: '2026-06-30T23:59:59.999Z',
  });
  assert.equal(out.kpis.facturadoTotal, 4000);
  assert.equal(out.kpis.ventas, 2);
  assert.equal(out.kpis.unidades, 4);
  const ba = out.provinces.find((p) => p.name === 'Buenos Aires');
  assert.equal(ba.facturado, 3000);
  assert.equal(ba.pctOfTotal, 75);
  assert.equal(out.provinces[0].name, 'Buenos Aires', 'ordenado por facturado descendente');
});

test('aggregateSalesReport: canceladas y devueltas NO suman al facturado pero sí se cuentan', () => {
  const rows = [
    row({ dateCreated: '2026-07-05T12:00:00Z', itemsAmount: 1000 }),
    row({ dateCreated: '2026-07-06T12:00:00Z', computedStatus: 'cancelada', itemsAmount: 5000 }),
    row({ dateCreated: '2026-07-07T12:00:00Z', computedStatus: 'devuelta', itemsAmount: 5000 }),
  ];
  const out = aggregateSalesReport(rows, {
    from: '2026-07-01T00:00:00.000Z', to: '2026-07-31T23:59:59.999Z',
    prevFrom: '2026-06-01T00:00:00.000Z', prevTo: '2026-06-30T23:59:59.999Z',
  });
  assert.equal(out.kpis.facturadoTotal, 1000, 'las excluidas no deben sumar al total');
  assert.equal(out.excluded.total, 3);
  assert.equal(out.excluded.facturadas, 1);
  assert.equal(out.excluded.canceladas, 1);
  assert.equal(out.excluded.devueltas, 1);
});

test('aggregateSalesReport: compara contra el período anterior por provincia y en total', () => {
  const rows = [
    // período anterior (junio): Buenos Aires facturó 1000
    row({ dateCreated: '2026-06-15T12:00:00Z', stateName: 'Buenos Aires', itemsAmount: 1000 }),
    // período actual (julio): Buenos Aires facturó 1500 → +50%
    row({ dateCreated: '2026-07-15T12:00:00Z', stateName: 'Buenos Aires', itemsAmount: 1500 }),
  ];
  const out = aggregateSalesReport(rows, {
    from: '2026-07-01T00:00:00.000Z', to: '2026-07-31T23:59:59.999Z',
    prevFrom: '2026-06-01T00:00:00.000Z', prevTo: '2026-06-30T23:59:59.999Z',
  });
  assert.equal(out.kpis.facturadoDeltaPct, 50);
  const ba = out.provinces.find((p) => p.name === 'Buenos Aires');
  assert.equal(ba.deltaPct, 50);
});

test('aggregateSalesReport: un pack de varios productos cuenta como 1 venta, no una por producto', () => {
  const rows = [
    // 3 productos del mismo carrito → ML los guarda como 3 order_id distintos, mismo pack_id.
    row({ dateCreated: '2026-07-05T12:00:00Z', stateName: 'Buenos Aires', itemsAmount: 1000, units: 1, orderId: 'o1', packId: 'pack-A' }),
    row({ dateCreated: '2026-07-05T12:01:00Z', stateName: 'Buenos Aires', itemsAmount: 2000, units: 2, orderId: 'o2', packId: 'pack-A' }),
    row({ dateCreated: '2026-07-05T12:02:00Z', stateName: 'Buenos Aires', itemsAmount: 500, units: 1, orderId: 'o3', packId: 'pack-A' }),
    // venta suelta, sin pack.
    row({ dateCreated: '2026-07-06T12:00:00Z', stateName: 'Buenos Aires', itemsAmount: 1500, units: 1, orderId: 'o4', packId: null }),
  ];
  const out = aggregateSalesReport(rows, {
    from: '2026-07-01T00:00:00.000Z', to: '2026-07-31T23:59:59.999Z',
    prevFrom: '2026-06-01T00:00:00.000Z', prevTo: '2026-06-30T23:59:59.999Z',
  });
  assert.equal(out.kpis.ventas, 2, 'el pack cuenta 1 vez + la venta suelta = 2, no 4 líneas de orden');
  assert.equal(out.kpis.unidades, 5, 'las unidades sí suman todas las líneas (1+2+1+1)');
  assert.equal(out.kpis.facturadoTotal, 5000, 'el facturado no cambia: sigue siendo la suma de todas las líneas');
  const ba = out.provinces.find((p) => p.name === 'Buenos Aires');
  assert.equal(ba.ventas, 2);
});

test('aggregateSalesReport: provincia nueva (sin ventas en el período anterior) → +100%, no división por cero', () => {
  const rows = [row({ dateCreated: '2026-07-05T12:00:00Z', stateName: 'Mendoza', itemsAmount: 500 })];
  const out = aggregateSalesReport(rows, {
    from: '2026-07-01T00:00:00.000Z', to: '2026-07-31T23:59:59.999Z',
    prevFrom: '2026-06-01T00:00:00.000Z', prevTo: '2026-06-30T23:59:59.999Z',
  });
  assert.equal(out.provinces[0].deltaPct, 100);
});
