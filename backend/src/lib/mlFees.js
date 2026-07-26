/**
 * Trae los costos de venta de ML (comisión + cargo fijo por tramo) desde la API oficial
 * (`GET /sites/MLA/listing_prices`) y los deja en la forma que consume el motor de precios.
 *
 * Por qué existe: hoy el 15% y los tramos 1115/2300/2810 están cargados a mano (del Excel). ML los
 * puede cambiar por anuncio. Esta capa los sincroniza desde la API — y si la API no está (sin token,
 * WAF, etc.), no rompe nada: los valores quedan como estaban, editables a mano.
 *
 * El parseo (parseSaleFee, tiersFromProbes) es PURO y se testea sin red. La parte con red
 * (fetchFeeConfig) sondea unos pocos precios y arma los tramos a partir de dónde cae el fixed_fee.
 */

import { getListingPrices } from './mercadolibre.js';

/** Cache en proceso: los tarifarios cambian por anuncio, no continuamente. */
const CACHE_TTL_MS = Number(process.env.ML_FEES_TTL_MS) || 24 * 60 * 60 * 1000;
let cache = null; // { at, data }

/**
 * Normaliza la respuesta de listing_prices al desglose que nos importa. Puro.
 *
 * ML devuelve un OBJETO cuando no se pasa listing_type_id, pero un ARRAY (una entrada por tipo de
 * publicación) cuando sí se pasa. Se contemplan las dos formas: si es array, se prioriza la entrada
 * del `listingTypeId` pedido y si no, la primera.
 *
 * @returns {{ price, percentageFee, meliPercentageFee, fixedFee, saleFeeAmount } | null}
 */
export function parseSaleFee(resp, price, listingTypeId) {
  const entry = Array.isArray(resp)
    ? (resp.find((x) => x?.listing_type_id === listingTypeId) ?? resp[0])
    : resp;
  const d = entry?.sale_fee_details;
  if (!d) return null;
  const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    price,
    // meli_percentage_fee es la comisión pura (sin el add-on de cuotas): es nuestro "15%".
    meliPercentageFee: num(d.meli_percentage_fee) ?? num(d.percentage_fee),
    percentageFee: num(d.percentage_fee),
    fixedFee: num(d.fixed_fee) ?? 0,
    saleFeeAmount: num(entry.sale_fee_amount),
  };
}

/**
 * Arma los tramos de cargo fijo a partir de varios sondeos (precio → fixedFee). Puro.
 *
 * ML cobra la fija por tramo de precio; sondeando precios crecientes se ve dónde cambia el valor.
 * Cada cambio de fixedFee abre un tramo nuevo, cuyo `maxPrice` es el último precio donde todavía
 * valía el valor anterior (aproximado al precio sondeado). El último tramo va sin tope.
 *
 * @param {Array<{price:number, fixedFee:number}>} probes ordenados o no
 * @returns {Array<{maxPrice:number|null, fixedFee:number}>}
 */
export function tiersFromProbes(probes) {
  const clean = (probes || [])
    .filter((p) => p && Number.isFinite(p.price) && Number.isFinite(p.fixedFee))
    .sort((a, b) => a.price - b.price);
  if (clean.length === 0) return [];

  const tiers = [];
  let currentFee = clean[0].fixedFee;
  for (let i = 1; i < clean.length; i++) {
    if (clean[i].fixedFee !== currentFee) {
      // El tramo del valor anterior termina en el último precio donde todavía regía.
      tiers.push({ maxPrice: clean[i - 1].price, fixedFee: currentFee });
      currentFee = clean[i].fixedFee;
    }
  }
  tiers.push({ maxPrice: null, fixedFee: currentFee }); // último tramo, sin tope
  return tiers;
}

/** Precios de sondeo por default: cubren de barato a caro para detectar los saltos de fija. */
export const DEFAULT_PROBE_PRICES = [3000, 8000, 12000, 18000, 24000, 30000, 40000, 60000];

/**
 * Sondea la API y devuelve la config de comisiones lista para el motor: comisión % + tramos.
 * Cacheada. Si algo falla, propaga el error (el que llama decide si degradar a lo cargado a mano).
 *
 * @param {string} accessToken
 * @param {{ listingTypeId?, categoryId?, probePrices?, extraParams?, force? }} [opts]
 */
export async function fetchFeeConfig(accessToken, opts = {}) {
  if (!opts.force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  if (!accessToken) throw new Error('Sin token de ML');

  const prices = opts.probePrices ?? DEFAULT_PROBE_PRICES;
  const probes = [];
  let commissionPct = null;

  for (const price of prices) {
    const resp = await getListingPrices(accessToken, {
      price,
      listingTypeId: opts.listingTypeId,
      categoryId: opts.categoryId,
      extraParams: opts.extraParams,
    });
    const fee = parseSaleFee(resp, price, opts.listingTypeId);
    if (!fee) continue;
    probes.push({ price, fixedFee: fee.fixedFee });
    // La comisión % es la misma para todos los precios del mismo tipo/categoría: tomamos la primera.
    if (commissionPct == null && fee.meliPercentageFee != null) commissionPct = fee.meliPercentageFee;
  }

  if (probes.length === 0) throw new Error('listing_prices no devolvió sale_fee_details');

  const data = {
    commissionPct,
    tiers: tiersFromProbes(probes),
    probes,
    fetchedAt: new Date().toISOString(),
    source: 'api',
  };
  cache = { at: Date.now(), data };
  return data;
}

/** Para tests: limpia el cache en proceso. */
export function clearFeeCache() {
  cache = null;
}
