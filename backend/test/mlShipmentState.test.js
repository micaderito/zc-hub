/**
 * Tests de lib/mlShipmentState.js: la regla que decide si una orden cancelada de ML puede
 * restaurar stock sola o si hay que esperar a que la usuaria confirme que la mercadería volvió.
 *
 * El punto central es el DEFAULT: la lista es de estados seguros (nunca despachado), así que
 * cualquier estado desconocido cae del lado de "no restaurar". Un estado nuevo en la API de ML
 * no puede volver a producir el bug del 2026-07-21 (stock restaurado con el paquete en viaje).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeToAutoRestore, getShipmentIdFromOrder } from '../src/lib/mlShipmentState.js';

test('envíos que nunca salieron del depósito: se puede restaurar solo', () => {
  for (const status of ['pending', 'handling', 'ready_to_ship', 'to_be_agreed', 'cancelled']) {
    assert.equal(isSafeToAutoRestore({ status }).safe, true, `${status} debería ser seguro`);
  }
});

test('envíos que ya salieron: NO se puede restaurar solo', () => {
  for (const status of ['shipped', 'delivered', 'not_delivered']) {
    assert.equal(isSafeToAutoRestore({ status }).safe, false, `${status} no debería ser seguro`);
  }
});

test('entrega fallida volviendo al vendedor (el caso de prod): no es seguro', () => {
  const out = isSafeToAutoRestore({ status: 'not_delivered', substatus: 'returning_to_sender' });
  assert.equal(out.safe, false);
  assert.match(out.reason, /la mercadería salió/);
});

test('el substatus de devolución manda aunque el status principal parezca seguro', () => {
  // ML a veces deja el envío en `cancelled` con un substatus que delata que el paquete ya salió.
  assert.equal(isSafeToAutoRestore({ status: 'cancelled', substatus: 'returning_to_sender' }).safe, false);
  assert.equal(isSafeToAutoRestore({ status: 'cancelled', substatus: 'not_delivered' }).safe, false);
});

test('un substatus normal de preparación no bloquea la restauración', () => {
  assert.equal(isSafeToAutoRestore({ status: 'ready_to_ship', substatus: 'printed' }).safe, true);
  assert.equal(isSafeToAutoRestore({ status: 'handling', substatus: 'regular' }).safe, true);
});

test('estado desconocido o envío no consultable: default conservador (no restaurar)', () => {
  assert.equal(isSafeToAutoRestore(null).safe, false);
  assert.equal(isSafeToAutoRestore(undefined).safe, false);
  assert.equal(isSafeToAutoRestore({}).safe, false);
  assert.equal(isSafeToAutoRestore({ status: '' }).safe, false);
  assert.equal(isSafeToAutoRestore({ status: 'un_estado_que_ml_agregue_manana' }).safe, false);
});

test('el status se compara sin importar mayúsculas ni espacios', () => {
  assert.equal(isSafeToAutoRestore({ status: '  READY_TO_SHIP ' }).safe, true);
  assert.equal(isSafeToAutoRestore({ status: 'NOT_DELIVERED' }).safe, false);
});

test('getShipmentIdFromOrder lee shipping.id y tolera órdenes sin envío', () => {
  assert.equal(getShipmentIdFromOrder({ shipping: { id: 44557 } }), '44557');
  assert.equal(getShipmentIdFromOrder({ shipping_id: 998 }), '998');
  assert.equal(getShipmentIdFromOrder({ shipping: {} }), null);
  assert.equal(getShipmentIdFromOrder({}), null);
  assert.equal(getShipmentIdFromOrder(null), null);
});
