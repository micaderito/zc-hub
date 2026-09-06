/**
 * Motor de cálculo de precios — puerto a TypeScript de `backend/src/lib/pricing.js` (el mismo
 * motor que usa la sección Precios). Se porta acá en vez de llamar a un endpoint porque el número
 * tiene que actualizarse MIENTRAS se tipea el precio en crear-producto, y un round-trip por tecla
 * es justo el tipo de problema de performance que se está arreglando en esa página.
 *
 * MANTENER EN SINCRO con `backend/src/lib/pricing.js` — hay tests (`pricing-math.spec.ts`) que
 * replican los mismos casos que `backend/test/pricing.test.js` para detectar si se separan.
 *
 * La cadena (ver docs/PLAN-PRECIOS.md):
 *
 *   costo_bulto_neto = precio_bulto × (1 − desc1) × (1 − desc2)
 *   costo_unitario   = costo_bulto_neto ÷ cant_x_bulto        (ó costo unitario cargado directo)
 *   valor_final      = round(costo_unitario × (1 + ganancia))  ← lo que se quiere netear
 *
 *   TN:  transferencia = ceil50(valor_final)                   (referencia)
 *        precio_lista  = ceil50(transferencia × mult_tarjeta)  ← el que se publica
 *
 *   ML:  fija = comisión fija por TRAMO de precio (no por producto)
 *        precio = ceil50( (valor_final + fija + impuestos + envío) / (1 − comisión) )
 *        envío entra solo si el precio supera el umbral de envío gratis
 */

/** Un tramo de comisión fija de ML: hasta `maxPrice` (precio publicado), la fija es `fixedFee`. */
export interface PricingTier {
  maxPrice: number;
  fixedFee: number;
}

export interface PricingSettings {
  commissionPct: number;
  taxes: number;
  shippingCost: number;
  freeShippingThreshold: number;
  cardMultiplier: number;
  roundStep: number;
  tiers: PricingTier[];
}

export const DEFAULT_ML_TIERS: PricingTier[] = [
  { maxPrice: 15000, fixedFee: 1115 },
  { maxPrice: 25000, fixedFee: 2300 },
  { maxPrice: 33000, fixedFee: 2810 },
  { maxPrice: Infinity, fixedFee: 0 }
];

/** Valores fijos por default — los que usa la planilla. Todos configurables desde Ajustes. */
export const DEFAULT_SETTINGS: PricingSettings = {
  commissionPct: 15,
  taxes: 300,
  shippingCost: 6500,
  freeShippingThreshold: 33000,
  cardMultiplier: 1.3,
  roundStep: 50,
  tiers: DEFAULT_ML_TIERS
};

/**
 * Convierte los tramos que llegan de `GET /api/pricing/config` (donde el tramo superior viaja
 * como `maxPrice: null` porque `Infinity` no sobrevive a JSON) al formato que usa este motor.
 */
export function tiersFromConfig(tiers: { maxPrice: number | null; fixedFee: number }[] | undefined): PricingTier[] {
  if (!tiers || !tiers.length) return DEFAULT_ML_TIERS;
  return tiers.map((t) => ({ maxPrice: t.maxPrice == null ? Infinity : t.maxPrice, fixedFee: t.fixedFee }));
}

/** Redondea `value` hacia arriba al múltiplo `step`. step ≤ 1 ⇒ redondeo al entero. */
export function roundUp(value: number, step = 50): number {
  if (!(step > 1)) return Math.ceil(value - 1e-9);
  return Math.ceil(value / step - 1e-9) * step;
}

export interface UnitCostFromBulkInput {
  bulkPrice: number;
  bulkQty: number;
  discount1?: number;
  discount2?: number;
}

/**
 * Costo unitario a partir del precio por bulto y los descuentos de la compra.
 * Los descuentos se aplican en cadena (primero d1, después d2 sobre el resultado).
 */
export function computeUnitCostFromBulk({ bulkPrice, bulkQty, discount1 = 0, discount2 = 0 }: UnitCostFromBulkInput): number {
  if (!(bulkQty > 0)) throw new Error(`bulkQty inválido: ${bulkQty}`);
  const net = bulkPrice * (1 - discount1 / 100) * (1 - discount2 / 100);
  return net / bulkQty;
}

/** Valor final = round(costo × (1 + ganancia%)). Es lo que el vendedor quiere netear. */
export function computeValorFinal(unitCost: number, marginPct = 100): number {
  return Math.round(unitCost * (1 + marginPct / 100));
}

/** Elige la comisión fija de ML según el valor final, replicando el despeje del Excel. */
export function pickFixedFee(valorFinal: number, settings: PricingSettings = DEFAULT_SETTINGS): number {
  const { commissionPct, taxes, tiers } = { ...DEFAULT_SETTINGS, ...settings };
  const comm = commissionPct / 100;
  for (const tier of tiers) {
    if (valorFinal <= tier.maxPrice * (1 - comm) - tier.fixedFee - taxes) return tier.fixedFee;
  }
  return 0;
}

/**
 * Precio de Mercado Libre a partir del valor final. La comisión fija que cobra ML depende del
 * PRECIO publicado, no del valor final, así que la elección del tramo es un punto fijo: se
 * recorren los tramos de menor a mayor y se acepta el primero cuya fija produzca un precio que
 * efectivamente cae dentro del rango de ese tramo. Los VF que no cierran en ningún tramo por
 * debajo del umbral caen en la "zona muerta": no hay precio publicable entre el umbral y el salto.
 */
export function computeMlPrice(valorFinal: number, settings: PricingSettings = DEFAULT_SETTINGS): number {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const comm = s.commissionPct / 100;
  let lo = 0;
  for (const tier of s.tiers) {
    const freeShip = tier.maxPrice > s.freeShippingThreshold;
    const shipping = freeShip ? s.shippingCost : 0;
    const price = roundUp((valorFinal + tier.fixedFee + s.taxes + shipping) / (1 - comm), s.roundStep);
    if (price > lo && price <= tier.maxPrice) return price;
    lo = tier.maxPrice;
  }
  // Salvaguarda (no debería alcanzarse: el último tramo tiene maxPrice Infinity).
  return roundUp((valorFinal + s.taxes + s.shippingCost) / (1 - comm), s.roundStep);
}

/** Lo que realmente le queda al vendedor si publica a `mlPrice` (para mostrar "te quedan $X"). */
export function mlNetReceived(mlPrice: number, settings: PricingSettings = DEFAULT_SETTINGS): number {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const comm = s.commissionPct / 100;
  // ML cobra la fija según el PRECIO publicado (no un valor final reconstruido): el tramo se
  // elige directo por `mlPrice ≤ maxPrice`.
  const fixed = (s.tiers.find((t) => mlPrice <= t.maxPrice) ?? { fixedFee: 0 }).fixedFee;
  const shipping = mlPrice > s.freeShippingThreshold ? s.shippingCost : 0;
  return mlPrice - comm * mlPrice - s.taxes - fixed - shipping;
}

/** Precios de Tienda Nube. Se publica `list`; `transfer` es referencia (la tienda descuenta sola). */
export function computeTnPrices(valorFinal: number, settings: PricingSettings = DEFAULT_SETTINGS): { transfer: number; list: number } {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const transfer = roundUp(valorFinal, s.roundStep);
  const list = roundUp(transfer * s.cardMultiplier, s.roundStep);
  return { transfer, list };
}

/** Lo que le queda al vendedor si publica `tnListPrice` en TN (inverso de `computeTnPrices`). */
export function tnNetReceived(tnListPrice: number, settings: PricingSettings = DEFAULT_SETTINGS): number {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  return tnListPrice / s.cardMultiplier;
}

export interface ComputePricesInput {
  unitCost?: number | null;
  bulkPrice?: number | null;
  bulkQty?: number | null;
  discount1?: number;
  discount2?: number;
  marginPct?: number;
}

export interface ComputedPrices {
  unitCost: number;
  valorFinal: number;
  tn: { transfer: number; list: number };
  ml: number;
  mlNet: number;
}

/** Orquestador: de un costo (por bulto o unitario) + reglas de la compra a todos los precios. */
export function computePrices(input: ComputePricesInput, settings: PricingSettings = DEFAULT_SETTINGS): ComputedPrices {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const { unitCost: directCost, bulkPrice, bulkQty, discount1 = 0, discount2 = 0, marginPct = 100 } = input;

  const unitCost =
    directCost != null
      ? directCost
      : computeUnitCostFromBulk({ bulkPrice: bulkPrice ?? 0, bulkQty: bulkQty ?? 0, discount1, discount2 });

  const valorFinal = computeValorFinal(unitCost, marginPct);
  const ml = computeMlPrice(valorFinal, s);
  return {
    unitCost,
    valorFinal,
    tn: computeTnPrices(valorFinal, s),
    ml,
    mlNet: mlNetReceived(ml, s)
  };
}
