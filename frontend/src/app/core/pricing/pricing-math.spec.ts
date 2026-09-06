import {
  DEFAULT_SETTINGS,
  computeMlPrice,
  computePrices,
  computeTnPrices,
  computeUnitCostFromBulk,
  computeValorFinal,
  mlNetReceived,
  roundUp,
  tiersFromConfig,
  tnNetReceived
} from './pricing-math';

/**
 * Replica los casos ya verificados contra la planilla real en `backend/test/pricing.test.js`, para
 * detectar si este puerto a TypeScript se separa del motor del backend (`backend/src/lib/pricing.js`).
 */
describe('pricing-math (puerto del motor de precios)', () => {
  describe('roundUp()', () => {
    it('redondea hacia arriba al múltiplo del paso', () => {
      expect(roundUp(19593, 50)).toBe(19600);
      expect(roundUp(8036, 50)).toBe(8050);
      expect(roundUp(3342, 50)).toBe(3350);
      expect(roundUp(14100, 50)).toBe(14100); // ya es múltiplo → no sube
    });

    it('redondea al entero si step ≤ 1', () => {
      expect(roundUp(1665.1, 1)).toBe(1666);
      expect(roundUp(1665, 1)).toBe(1665);
    });
  });

  it('computeUnitCostFromBulk + computeValorFinal reproducen la fila 30700 de Punto Cero', () => {
    const unitCost = computeUnitCostFromBulk({ bulkPrice: 70400, bulkQty: 8, discount1: 25, discount2: 5 });
    expect(unitCost).toBe(6270);
    expect(computeValorFinal(unitCost, 100)).toBe(12540);
  });

  it('computeTnPrices(14054): transferencia y lista redondeadas a 50', () => {
    const { transfer, list } = computeTnPrices(14054, DEFAULT_SETTINGS);
    expect(transfer).toBe(14100); // ceil50(14054)
    expect(list).toBe(18350); // ceil50(14100 × 1,3) = ceil50(18330)
  });

  it('tnNetReceived() es el inverso exacto de list/cardMultiplier (list ya viene redondeado a 50)', () => {
    const { transfer, list } = computeTnPrices(14054, DEFAULT_SETTINGS);
    expect(tnNetReceived(list, DEFAULT_SETTINGS)).toBeCloseTo(list / DEFAULT_SETTINGS.cardMultiplier, 6);
    // Por el redondeo ↑ del precio de lista, el neto queda por encima de la transferencia original.
    expect(tnNetReceived(list, DEFAULT_SETTINGS)).toBeGreaterThanOrEqual(transfer);
  });

  it('computePrices(): orquesta la fila completa de Punto Cero (30700)', () => {
    const out = computePrices({ bulkPrice: 70400, bulkQty: 8, discount1: 25, discount2: 5, marginPct: 100 }, DEFAULT_SETTINGS);
    expect(out.unitCost).toBe(6270);
    expect(out.valorFinal).toBe(12540);
    expect(out.tn.transfer).toBe(12550);
    expect(out.tn.list).toBe(16350); // ceil50(12550 × 1,3 = 16315)
    expect(out.ml).toBe(computeMlPrice(12540, DEFAULT_SETTINGS));
    expect(out.mlNet).toBeGreaterThanOrEqual(out.valorFinal - 1e-6);
  });

  it('mlNetReceived(): el vendedor netea al menos el valor final pedido (varios tramos)', () => {
    for (const vf of [8000, 14000, 20000, 29880, 24940, 24941]) {
      const price = computeMlPrice(vf, DEFAULT_SETTINGS);
      const net = mlNetReceived(price, DEFAULT_SETTINGS);
      expect(net).toBeGreaterThanOrEqual(vf - 1e-6);
      expect(net).toBeLessThanOrEqual(vf + DEFAULT_SETTINGS.roundStep);
    }
  });

  it('ZONA MUERTA: pasado el umbral, el precio salta a la región de envío gratis', () => {
    const enCap = computeMlPrice(24940, DEFAULT_SETTINGS);
    expect(enCap).toBeLessThanOrEqual(DEFAULT_SETTINGS.freeShippingThreshold);
    const saltado = computeMlPrice(24941, DEFAULT_SETTINGS);
    expect(saltado).toBeGreaterThan(33000 + DEFAULT_SETTINGS.shippingCost * 0.5);
  });

  describe('tiersFromConfig()', () => {
    it('convierte maxPrice: null (como llega de la API, Infinity no sobrevive a JSON) a Infinity', () => {
      const tiers = tiersFromConfig([
        { maxPrice: 15000, fixedFee: 1115 },
        { maxPrice: null, fixedFee: 0 }
      ]);
      expect(tiers[1].maxPrice).toBe(Infinity);
    });

    it('cae a los tramos default si no hay tramos configurados', () => {
      expect(tiersFromConfig(undefined)).toEqual(DEFAULT_SETTINGS.tiers);
      expect(tiersFromConfig([])).toEqual(DEFAULT_SETTINGS.tiers);
    });
  });
});
