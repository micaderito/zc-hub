/**
 * Tests de lib/mlFees.js. El parseo y la construcción de tramos son puros y se testean con
 * respuestas de ejemplo de la API. fetchFeeConfig se testea con getListingPrices mockeado (sin red).
 */
import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// Respuestas de listing_prices por precio, controladas por el test.
const mlState = { byPrice: {}, calls: [] };
before(() => {
  mock.module('../src/lib/mercadolibre.js', {
    exports: {
      getListingPrices: async (_token, { price }) => {
        mlState.calls.push(price);
        const r = mlState.byPrice[price];
        if (!r) throw new Error(`sin respuesta para ${price}`);
        return r;
      },
    },
  });
});

let fees;
before(async () => { fees = await import('../src/lib/mlFees.js'); });
beforeEach(() => { mlState.byPrice = {}; mlState.calls = []; fees.clearFeeCache(); });

/** Arma una respuesta de listing_prices como la de la doc de ML. */
function resp({ price, pct = 13, fixed = 0 }) {
  return {
    currency_id: 'ARS',
    listing_type_id: 'gold_special',
    sale_fee_amount: price * (pct / 100) + fixed,
    sale_fee_details: {
      percentage_fee: pct,
      meli_percentage_fee: pct,
      fixed_fee: fixed,
      financing_add_on_fee: 0,
    },
  };
}

test('parseSaleFee: saca comisión y cargo fijo del sale_fee_details', () => {
  const fee = fees.parseSaleFee(resp({ price: 5000, pct: 13, fixed: 200 }), 5000);
  assert.equal(fee.meliPercentageFee, 13);
  assert.equal(fee.fixedFee, 200);
  assert.equal(fee.saleFeeAmount, 5000 * 0.13 + 200);
});

test('parseSaleFee: null si la respuesta no trae desglose', () => {
  assert.equal(fees.parseSaleFee({}, 5000), null);
  assert.equal(fees.parseSaleFee(null, 5000), null);
});

test('parseSaleFee: forma ARRAY (cuando se pasa listing_type_id) — prioriza el tipo pedido', () => {
  // ML devuelve un array con una entrada por tipo de publicación cuando se manda listing_type_id.
  const arr = [
    { listing_type_id: 'gold_pro', sale_fee_amount: 999, sale_fee_details: { meli_percentage_fee: 20, fixed_fee: 500 } },
    { listing_type_id: 'gold_special', sale_fee_amount: 2810, sale_fee_details: { meli_percentage_fee: 13, fixed_fee: 1250 } },
  ];
  const fee = fees.parseSaleFee(arr, 12000, 'gold_special');
  assert.equal(fee.meliPercentageFee, 13);
  assert.equal(fee.fixedFee, 1250);
  assert.equal(fee.saleFeeAmount, 2810);
  // sin listingTypeId, toma la primera entrada
  assert.equal(fees.parseSaleFee(arr, 12000).meliPercentageFee, 20);
});

test('tiersFromProbes: cada cambio de fixedFee abre un tramo, el último sin tope', () => {
  const tiers = fees.tiersFromProbes([
    { price: 3000, fixedFee: 1115 },
    { price: 12000, fixedFee: 1115 },
    { price: 18000, fixedFee: 2300 },
    { price: 24000, fixedFee: 2810 },
    { price: 40000, fixedFee: 0 },
  ]);
  assert.deepEqual(tiers, [
    { maxPrice: 12000, fixedFee: 1115 },
    { maxPrice: 18000, fixedFee: 2300 },
    { maxPrice: 24000, fixedFee: 2810 },
    { maxPrice: null, fixedFee: 0 },
  ]);
});

test('tiersFromProbes: un solo valor de fija ⇒ un solo tramo sin tope', () => {
  assert.deepEqual(
    fees.tiersFromProbes([{ price: 1000, fixedFee: 500 }, { price: 9000, fixedFee: 500 }]),
    [{ maxPrice: null, fixedFee: 500 }],
  );
});

test('tiersFromProbes: sin sondeos ⇒ sin tramos', () => {
  assert.deepEqual(fees.tiersFromProbes([]), []);
});

test('fetchFeeConfig: sondea los precios y arma comisión + tramos', async () => {
  mlState.byPrice = {
    3000: resp({ price: 3000, pct: 13, fixed: 1115 }),
    8000: resp({ price: 8000, pct: 13, fixed: 1115 }),
    12000: resp({ price: 12000, pct: 13, fixed: 1115 }),
    18000: resp({ price: 18000, pct: 13, fixed: 2300 }),
    24000: resp({ price: 24000, pct: 13, fixed: 2810 }),
    30000: resp({ price: 30000, pct: 13, fixed: 2810 }),
    40000: resp({ price: 40000, pct: 13, fixed: 0 }),
    60000: resp({ price: 60000, pct: 13, fixed: 0 }),
  };
  const cfg = await fees.fetchFeeConfig('tok');
  assert.equal(cfg.commissionPct, 13);
  assert.equal(cfg.source, 'api');
  assert.equal(cfg.tiers[cfg.tiers.length - 1].maxPrice, null);
  assert.ok(cfg.tiers.some((t) => t.fixedFee === 2300));
  assert.ok(cfg.tiers.some((t) => t.fixedFee === 2810));
});

test('fetchFeeConfig: cachea (no vuelve a sondear dentro del TTL) y force lo salta', async () => {
  mlState.byPrice = { 3000: resp({ price: 3000, fixed: 100 }) };
  await fees.fetchFeeConfig('tok', { probePrices: [3000] });
  const n = mlState.calls.length;
  await fees.fetchFeeConfig('tok', { probePrices: [3000] }); // cacheado
  assert.equal(mlState.calls.length, n, 'no debería volver a llamar');
  await fees.fetchFeeConfig('tok', { probePrices: [3000], force: true });
  assert.ok(mlState.calls.length > n, 'force debe volver a sondear');
});

test('fetchFeeConfig: sin token, error claro', async () => {
  await assert.rejects(() => fees.fetchFeeConfig('', { probePrices: [3000] }), /Sin token/);
});
