/**
 * Tests de lib/mlCancelReason.js: qué cancelaciones de ML NO pueden restaurar stock solas.
 *
 * La regla nace del incidente 2026-08-11: la venta se canceló desde ML con motivo "no tengo
 * stock", ML dejó su stock como estaba (bien: la unidad no existía) y el hub igual sumó la unidad
 * en Tienda Nube, que quedó en 3 contra 2 de ML.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCancelDetail, needsManualReview } from '../src/lib/mlCancelReason.js';

test('cancelación pedida por el vendedor → revisión manual', () => {
  const out = needsManualReview({
    status: 'cancelled',
    cancel_detail: { group: 'seller', code: 'out_of_stock', description: 'No tengo stock', requested_by: 'seller' },
  });
  assert.equal(out.manual, true);
  assert.match(out.reason, /vendedor/);
  assert.match(out.reason, /No tengo stock/);
});

test('motivo "sin stock" sin requested_by también va a revisión manual', () => {
  const out = needsManualReview({ status: 'cancelled', cancel_detail: { code: 'OUT_OF_STOCK' } });
  assert.equal(out.manual, true);
  assert.match(out.reason, /falta de stock/);
});

test('cancelación pedida por el comprador restaura sola (la decide el envío, no el motivo)', () => {
  const out = needsManualReview({
    status: 'cancelled',
    cancel_detail: { group: 'buyer', code: 'buyer_regret', description: 'Me arrepentí', requested_by: 'buyer' },
  });
  assert.equal(out.manual, false);
  assert.equal(out.reason, null);
});

test('orden sin cancel_detail restaura sola: es el caso más común (pago rechazado, timeout)', () => {
  assert.equal(needsManualReview({ status: 'cancelled' }).manual, false);
  assert.equal(needsManualReview({ status: 'cancelled', cancel_detail: null }).manual, false);
  assert.equal(needsManualReview(null).manual, false);
});

test('status_detail string no es un motivo (es un código de estado): no fuerza revisión manual', () => {
  const out = needsManualReview({ status: 'cancelled', status_detail: 'cancelled_by_seller' });
  assert.equal(out.manual, false);
  assert.equal(getCancelDetail({ status_detail: 'cancelled_by_seller' }), null);
});

test('status_detail objeto sí se lee como motivo (algunos flujos de ML lo mandan ahí)', () => {
  const detail = getCancelDetail({ status_detail: { requested_by: 'SELLER', code: 'Out_Of_Stock' } });
  assert.deepEqual(detail, { requestedBy: 'seller', code: 'out_of_stock', group: null, description: null });
  assert.equal(needsManualReview({ status_detail: { requested_by: 'SELLER' } }).manual, true);
});
