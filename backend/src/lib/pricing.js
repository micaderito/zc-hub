/**
 * Motor de cálculo de precios — PURO: sin I/O, sin red, sin DB. Entra un costo + reglas,
 * sale el precio para Tienda Nube y Mercado Libre. Es el corazón de la sección de Precios y
 * se testea contra las 131 filas de la planilla real del usuario (ver test/pricing.test.js).
 *
 * La cadena (verificada al peso contra el Excel `Febrero 2026.xlsx`):
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
 *
 * Sobre el despeje de ML: la comisión de ML se cobra sobre el precio FINAL publicado, no sobre
 * la ganancia. Por eso se divide por (1 − comisión) en vez de sumar la comisión. El Excel original
 * sumaba el envío gratis DESPUÉS de dividir, lo que hacía pagar al vendedor el 15% del envío
 * (~$1.147/venta); acá el envío entra ANTES de dividir (modo 'correct', el default). El modo
 * 'legacy' reproduce el Excel exacto y existe solo para los tests de fidelidad.
 */

/** Un tramo de comisión fija de ML: hasta `maxPrice` (precio publicado), la fija es `fixedFee`. */
export const DEFAULT_ML_TIERS = [
  { maxPrice: 15000, fixedFee: 1115 },
  { maxPrice: 25000, fixedFee: 2300 },
  { maxPrice: 33000, fixedFee: 2810 },
  { maxPrice: Infinity, fixedFee: 0 },
];

/** Valores fijos por default — los que usa la planilla. Todos configurables desde Ajustes. */
export const DEFAULT_SETTINGS = {
  commissionPct: 15,          // comisión por vender de ML
  taxes: 300,                 // impuestos por venta (la API de ML no lo sabe; siempre a mano)
  shippingCost: 6500,         // costo del envío que paga el vendedor arriba del umbral
  freeShippingThreshold: 33000, // desde este precio, envío gratis obligatorio
  cardMultiplier: 1.3,        // recargo de tarjeta sobre la transferencia
  roundStep: 50,              // redondeo hacia arriba a este múltiplo
  tiers: DEFAULT_ML_TIERS,
};

/** Redondea `value` hacia arriba al múltiplo `step`. step ≤ 1 ⇒ redondeo al entero. */
export function roundUp(value, step = 50) {
  if (!(step > 1)) return Math.ceil(value - 1e-9);
  return Math.ceil(value / step - 1e-9) * step;
}

/**
 * Costo unitario a partir del precio por bulto y los descuentos de la compra.
 * Los descuentos se aplican en cadena (primero d1, después d2 sobre el resultado).
 */
export function computeUnitCostFromBulk({ bulkPrice, bulkQty, discount1 = 0, discount2 = 0 }) {
  if (!(bulkQty > 0)) throw new Error(`bulkQty inválido: ${bulkQty}`);
  const net = bulkPrice * (1 - discount1 / 100) * (1 - discount2 / 100);
  return net / bulkQty;
}

/** Valor final = round(costo × (1 + ganancia%)). Es lo que el vendedor quiere netear. */
export function computeValorFinal(unitCost, marginPct = 100) {
  return Math.round(unitCost * (1 + marginPct / 100));
}

/** Elige la comisión fija de ML según el valor final, replicando el despeje del Excel. */
export function pickFixedFee(valorFinal, settings = DEFAULT_SETTINGS) {
  const { commissionPct, taxes, tiers } = { ...DEFAULT_SETTINGS, ...settings };
  const comm = commissionPct / 100;
  for (const tier of tiers) {
    // El precio publicado cae en este tramo ⟺ valor_final ≤ max×(1−comm) − fija − impuestos.
    // (es el despeje de: (valor_final + fija + impuestos)/(1−comm) ≤ max)
    if (valorFinal <= tier.maxPrice * (1 - comm) - tier.fixedFee - taxes) return tier.fixedFee;
  }
  return 0;
}

/**
 * Precio de Mercado Libre a partir del valor final.
 * @param {number} valorFinal
 * @param {object} settings
 * @param {'correct'|'legacy'} [mode='correct'] 'legacy' reproduce el Excel (envío después de
 *   dividir, redondeo al entero); 'correct' mete el envío antes de dividir y redondea con roundStep.
 */
export function computeMlPrice(valorFinal, settings = DEFAULT_SETTINGS, mode = 'correct') {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const comm = s.commissionPct / 100;

  if (mode === 'legacy') {
    // Reproducción fiel del Excel: la fija se elige por valor_final y el envío se suma DESPUÉS
    // de dividir (por eso el vendedor termina pagando la comisión del envío).
    const fixed = pickFixedFee(valorFinal, s);
    const base = (valorFinal + fixed + s.taxes) / (1 - comm);
    if (base <= s.freeShippingThreshold) return Math.ceil(base - 1e-9);
    return Math.ceil(base + s.shippingCost - 1e-9);
  }

  // Correcto: la comisión fija que cobra ML depende del PRECIO publicado, no del valor final, así
  // que la elección del tramo es un punto fijo (el precio determina el tramo que determina el
  // precio). Se recorren los tramos de menor a mayor y se acepta el primero cuya fija produzca un
  // precio que efectivamente cae dentro del rango de ese tramo. Eso garantiza consistencia con lo
  // que ML realmente cobra y neteo ≥ valor_final. Los VF que no cierran en ningún tramo por debajo
  // del umbral caen en la región de envío gratis (fija 0 + el vendedor absorbe el envío): es la
  // "zona muerta" real: no hay precio publicable entre el umbral y ese salto.
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
export function mlNetReceived(mlPrice, settings = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const comm = s.commissionPct / 100;
  // ML cobra la fija según el PRECIO publicado (no un valor final reconstruido): el tramo se
  // elige directo por `mlPrice ≤ maxPrice`.
  const fixed = (s.tiers.find((t) => mlPrice <= t.maxPrice) ?? { fixedFee: 0 }).fixedFee;
  const shipping = mlPrice > s.freeShippingThreshold ? s.shippingCost : 0;
  return mlPrice - comm * mlPrice - s.taxes - fixed - shipping;
}

/** Precios de Tienda Nube. Se publica `list`; `transfer` es referencia (la tienda descuenta sola). */
export function computeTnPrices(valorFinal, settings = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const transfer = roundUp(valorFinal, s.roundStep);
  const list = roundUp(transfer * s.cardMultiplier, s.roundStep);
  return { transfer, list };
}

/**
 * Orquestador: de un costo (por bulto o unitario) + reglas de la compra a todos los precios.
 * @param {object} input
 * @param {number} [input.bulkPrice]  precio por bulto (si el costo viene por bulto)
 * @param {number} [input.bulkQty]    unidades por bulto
 * @param {number} [input.unitCost]   costo unitario directo (alternativa a bulkPrice/bulkQty)
 * @param {number} [input.discount1]  descuento 1 de la compra (%)
 * @param {number} [input.discount2]  descuento 2 de la compra (%)
 * @param {number} [input.marginPct]  ganancia (%), default 100
 * @param {object} [settings]         valores fijos (comisión, impuestos, envío, tarifa, redondeo)
 * @returns {{ unitCost, valorFinal, tn:{transfer,list}, ml, mlNet }}
 */
export function computePrices(input, settings = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const { unitCost: directCost, bulkPrice, bulkQty, discount1 = 0, discount2 = 0, marginPct = 100 } = input;

  const unitCost = directCost != null
    ? directCost
    : computeUnitCostFromBulk({ bulkPrice, bulkQty, discount1, discount2 });

  const valorFinal = computeValorFinal(unitCost, marginPct);
  const ml = computeMlPrice(valorFinal, s);
  return {
    unitCost,
    valorFinal,
    tn: computeTnPrices(valorFinal, s),
    ml,
    mlNet: mlNetReceived(ml, s),
  };
}
