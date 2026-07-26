/**
 * Tests del motor de cálculo de precios (lib/pricing.js).
 *
 * El fixture `pricing.fixtures.json` sale de la planilla REAL del usuario (`Febrero 2026.xlsx`):
 *   - `ml`: 131 filas (valor_final → precio ML) de las 9 pestañas de proveedores.
 *   - `puntoCero`: 49 filas (precio_bulto + cantidad → valor_final) de la pestaña Punto Cero.
 *
 * Estrategia:
 *   1. FIDELIDAD — en modo 'legacy', reproducir el ML del Excel al peso en las 131 filas.
 *      Prueba que el port de la fórmula es exacto, no aproximado.
 *   2. CADENA DE COSTO — reproducir el valor_final de Punto Cero desde el bulto (desc 25%+5%, gan 100%).
 *   3. CORRECCIÓN — en modo 'correct' (default), el vendedor netea ≥ el valor_final pedido en las 131.
 *   4. Propiedades del redondeo, tramos y despeje inverso.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  computePrices,
  computeUnitCostFromBulk,
  computeValorFinal,
  computeMlPrice,
  computeTnPrices,
  mlNetReceived,
  pickFixedFee,
  roundUp,
  DEFAULT_SETTINGS,
} from '../src/lib/pricing.js';

const fixtures = JSON.parse(readFileSync(new URL('./pricing.fixtures.json', import.meta.url)));

test('roundUp: hacia arriba al múltiplo, y al entero si step ≤ 1', () => {
  assert.equal(roundUp(19593, 50), 19600);
  assert.equal(roundUp(8036, 50), 8050);
  assert.equal(roundUp(3342, 50), 3350);
  assert.equal(roundUp(14100, 50), 14100); // ya es múltiplo → no sube
  assert.equal(roundUp(2600, 50), 2600);
  assert.equal(roundUp(1665.1, 1), 1666);
  assert.equal(roundUp(1665, 1), 1665);
});

test('FIDELIDAD: modo legacy reproduce el ML del Excel en las 131 filas', () => {
  let checked = 0;
  for (const row of fixtures.ml) {
    const got = computeMlPrice(row.vf, DEFAULT_SETTINGS, 'legacy');
    assert.equal(got, row.mlExcel, `${row.sheet} vf=${row.vf}: esperaba ${row.mlExcel}, dio ${got}`);
    checked++;
  }
  assert.equal(checked, 131);
});

test('CADENA DE COSTO: valor_final de Punto Cero desde el bulto (desc 25% + 5%, gan 100%)', () => {
  let checked = 0;
  for (const row of fixtures.puntoCero) {
    const unitCost = computeUnitCostFromBulk({
      bulkPrice: row.bulkPrice,
      bulkQty: row.bulkQty,
      discount1: 25,
      discount2: 5,
    });
    const vf = computeValorFinal(unitCost, row.margin);
    assert.equal(vf, row.vfExcel, `${row.code}: esperaba VF ${row.vfExcel}, dio ${vf}`);
    checked++;
  }
  assert.equal(checked, 49);
});

test('CORRECCIÓN: en modo correct el vendedor netea ≥ el valor_final pedido (131 filas)', () => {
  for (const row of fixtures.ml) {
    const price = computeMlPrice(row.vf, DEFAULT_SETTINGS, 'correct');
    const net = mlNetReceived(price, DEFAULT_SETTINGS);
    assert.ok(net >= row.vf - 1e-6, `${row.sheet} vf=${row.vf}: netea ${net.toFixed(2)} < ${row.vf}`);
    // y no de más: el redondeo a 50 no debería regalar más de ~1 paso de margen.
    assert.ok(net <= row.vf + DEFAULT_SETTINGS.roundStep, `${row.sheet} vf=${row.vf}: netea de más (${net.toFixed(2)})`);
  }
});

test('CORRECCIÓN vs legacy: arriba del umbral, el corregido cobra más (cubre la comisión del envío)', () => {
  const vf = 29880; // fila real de Agendas que cruza el umbral
  const legacy = computeMlPrice(vf, DEFAULT_SETTINGS, 'legacy');
  const correct = computeMlPrice(vf, DEFAULT_SETTINGS, 'correct');
  assert.ok(correct > legacy, `corregido ${correct} debería superar legacy ${legacy}`);
  // el legacy netea de menos; el corregido no.
  assert.ok(mlNetReceived(legacy, DEFAULT_SETTINGS) < vf);
  assert.ok(mlNetReceived(correct, DEFAULT_SETTINGS) >= vf - 1e-6);
});

test('CONSISTENCIA: la fija que ML cobra al precio final reproduce el neteo pedido (131 filas)', () => {
  // El precio corregido es un punto fijo: la comisión fija del TRAMO del precio publicado, más el
  // envío si corresponde, tiene que dejar netear ≥ valor_final. Esto valida que la elección de
  // tramo no sea inconsistente (usar fija 0 en un precio que ML cobra a 2810, como hacía el Excel).
  for (const row of fixtures.ml) {
    const price = computeMlPrice(row.vf, DEFAULT_SETTINGS, 'correct');
    const tier = DEFAULT_SETTINGS.tiers.find((t) => price <= t.maxPrice);
    const shipping = price > DEFAULT_SETTINGS.freeShippingThreshold ? DEFAULT_SETTINGS.shippingCost : 0;
    const net = price - 0.15 * price - 300 - tier.fixedFee - shipping;
    assert.ok(net >= row.vf - 1e-6, `${row.sheet} vf=${row.vf}: precio ${price} netea solo ${net.toFixed(2)}`);
  }
});

test('los límites de tramo son múltiplos del paso de redondeo (no reintroducen circularidad)', () => {
  for (const tier of DEFAULT_SETTINGS.tiers) {
    if (!Number.isFinite(tier.maxPrice)) continue;
    assert.equal(tier.maxPrice % DEFAULT_SETTINGS.roundStep, 0, `límite ${tier.maxPrice} no es múltiplo de ${DEFAULT_SETTINGS.roundStep}`);
  }
});

test('ZONA MUERTA: pasado el umbral, el precio salta a envío gratis (no hay precio intermedio)', () => {
  // VF=24940 cierra justo en el cap de $33.000; un peso más ya no cabe y salta a la región de envío.
  const enCap = computeMlPrice(24940, DEFAULT_SETTINGS, 'correct');
  assert.ok(enCap <= DEFAULT_SETTINGS.freeShippingThreshold, `esperaba ≤33000, dio ${enCap}`);
  const saltado = computeMlPrice(24941, DEFAULT_SETTINGS, 'correct');
  assert.ok(saltado > 33000 + DEFAULT_SETTINGS.shippingCost * 0.5, `esperaba un salto grande, dio ${saltado}`);
  // aún así, el que saltó sigue neteando lo pedido.
  assert.ok(mlNetReceived(saltado, DEFAULT_SETTINGS) >= 24941 - 1e-6);
});

test('computeTnPrices: transferencia y lista, ambos redondeados a 50', () => {
  const { transfer, list } = computeTnPrices(14054, DEFAULT_SETTINGS);
  assert.equal(transfer, 14100); // ceil50(14054)
  assert.equal(list, 18350);     // ceil50(14100 × 1,3) = ceil50(18330)
});

test('computePrices: orquesta una fila completa de Punto Cero (30700)', () => {
  const out = computePrices(
    { bulkPrice: 70400, bulkQty: 8, discount1: 25, discount2: 5, marginPct: 100 },
    DEFAULT_SETTINGS,
  );
  assert.equal(out.unitCost, 6270);
  assert.equal(out.valorFinal, 12540);
  assert.equal(out.tn.transfer, 12550);
  assert.equal(out.tn.list, 16350); // ceil50(12550 × 1,3 = 16315)
  assert.equal(out.ml, computeMlPrice(12540, DEFAULT_SETTINGS));
  assert.ok(out.mlNet >= out.valorFinal - 1e-6);
});

test('computePrices: acepta costo unitario directo (proveedores sin lista)', () => {
  const out = computePrices({ unitCost: 3200, marginPct: 100 }, DEFAULT_SETTINGS);
  assert.equal(out.valorFinal, 6400);
  assert.equal(out.tn.transfer, 6400);
  assert.equal(out.tn.list, 8350); // ceil50(6400 × 1,3 = 8320) = 8350
});

test('sin descuentos: computeUnitCostFromBulk con 0/0 devuelve el costo por bulto ÷ cantidad', () => {
  assert.equal(computeUnitCostFromBulk({ bulkPrice: 8000, bulkQty: 8, discount1: 0, discount2: 0 }), 1000);
});

test('ganancia configurable: mayor margen ⇒ mayor valor final', () => {
  const c = computeUnitCostFromBulk({ bulkPrice: 70400, bulkQty: 8, discount1: 25, discount2: 5 });
  assert.equal(computeValorFinal(c, 100), 12540);
  assert.equal(computeValorFinal(c, 50), 9405); // round(6270 × 1,5)
});

test('settings configurables: cambiar la comisión mueve el precio de ML', () => {
  const base = computeMlPrice(10000, DEFAULT_SETTINGS);
  const higher = computeMlPrice(10000, { ...DEFAULT_SETTINGS, commissionPct: 20 });
  assert.ok(higher > base, 'más comisión ⇒ hay que publicar más caro para netear lo mismo');
});
