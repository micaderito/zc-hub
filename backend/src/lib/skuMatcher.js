/**
 * Escalera de coincidencia SKU del hub ↔ código del proveedor. PURO: sin I/O ni red.
 *
 * El mapeo se hace UNA vez: lo que se confirma se guarda en `sku_code_map` y no se vuelve a
 * preguntar en las listas siguientes. Por eso acá solo se resuelve el caso "código nuevo".
 *
 * Escalones (de más a menos confiable):
 *   1. exact  — el SKU es igual al código.                          → se aplica solo
 *   2. saved  — ya lo confirmaste antes.                            → se aplica solo
 *   3. base   — tu `30700-ROSA` contra el `30700` de la lista.      → PROPONE
 *   4. group  — tu `39033` dentro de `39021/22/33/34/38/…`.         → PROPONE
 *   5. text   — parecido de descripción, último recurso.            → PROPONE
 *
 * Del escalón 3 en adelante nunca se aplica solo: el costo de equivocarse es publicar un precio
 * mal en ML, así que el default es preguntar, no adivinar.
 */

/** Confianza de cada escalón, para ordenar y para decidir si se auto-aplica. */
const SOURCE_SCORE = { exact: 1, saved: 1, base: 0.87, group: 0.8, text: 0 };
/** Los que se aplican solos; el resto queda "sugerido, a confirmar". */
const AUTO_SOURCES = new Set(['exact', 'saved']);

/** Normaliza para comparar: sin acentos, mayúsculas, sin separadores. */
export function normalizeCode(raw) {
  return String(raw ?? '')
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '');
}

/**
 * Expande un código múltiple a la lista de códigos que representa.
 * Las partes siguientes a la primera son abreviadas: reemplazan los últimos dígitos de la base.
 *   `39021/22/33`            → 39021, 39022, 39033
 *   `39039/40/139/140/141`   → 39039, 39040, 39139, 39140, 39141
 *   `39024-39025`            → 39024, 39025
 */
export function expandCode(code) {
  const raw = String(code ?? '').trim();
  if (!raw) return [];
  const parts = raw.split(/[/\-]/).map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) return [raw];

  const base = parts[0];
  const baseDigits = base.replace(/\D/g, '');
  const out = [base];
  for (const part of parts.slice(1)) {
    if (!/^\d+$/.test(part)) { out.push(part); continue; }
    out.push(part.length >= baseDigits.length
      ? part
      : baseDigits.slice(0, baseDigits.length - part.length) + part);
  }
  return out;
}

/** Quita sufijos que agregás vos al SKU: `30700-ROSA` → `30700`, `39001_A` → `39001`. */
export function baseCodeOf(sku) {
  const m = normalizeCode(sku).match(/^([A-Z]*\d{3,6})(?:[^0-9A-Z].*|[A-Z]{2,}.*)?$/);
  return m ? m[1] : null;
}

/** Tokens significativos de una descripción, para comparar por texto. */
function tokens(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2),
  );
}

/** Parecido de Jaccard entre dos descripciones (0..1). */
export function textSimilarity(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/**
 * Sugiere el código del proveedor para un SKU.
 *
 * @param {{ sku: string, label?: string }} product
 * @param {Array<{ code: string, description?: string }>} codes catálogo del proveedor
 * @param {{ savedCode?: string, minTextScore?: number }} [opts]
 * @returns {{ code, matchSource, score, auto } | null}
 */
export function suggestMatch(product, codes, opts = {}) {
  const sku = product?.sku;
  if (!sku) return null;
  const minTextScore = opts.minTextScore ?? 0.5;

  // 2. Ya confirmado: manda sobre todo lo demás.
  if (opts.savedCode) {
    return { code: opts.savedCode, matchSource: 'saved', score: 1, auto: true };
  }

  const nSku = normalizeCode(sku);

  // 1. Igualdad exacta con el código (o con uno de los que expande un código múltiple).
  for (const entry of codes) {
    const nCode = normalizeCode(entry.code);
    if (nCode === nSku) return { code: entry.code, matchSource: 'exact', score: 1, auto: true };
    if (expandCode(entry.code).some((c) => normalizeCode(c) === nSku)) {
      return { code: entry.code, matchSource: 'exact', score: 1, auto: true };
    }
  }

  // 3. Código base: el SKU tiene un sufijo tuyo (`-ROSA`, ` GRANDE`, …).
  const base = baseCodeOf(sku);
  if (base && base !== nSku) {
    for (const entry of codes) {
      if (normalizeCode(entry.code) === base) {
        return { code: entry.code, matchSource: 'base', score: SOURCE_SCORE.base, auto: false };
      }
    }
  }

  // 4. Dentro de un código múltiple, comparando por el código base.
  if (base) {
    for (const entry of codes) {
      if (expandCode(entry.code).some((c) => normalizeCode(c) === base)) {
        return { code: entry.code, matchSource: 'group', score: SOURCE_SCORE.group, auto: false };
      }
    }
  }

  // 5. Último recurso: parecido de descripción.
  if (product.label) {
    let best = null;
    for (const entry of codes) {
      const score = textSimilarity(product.label, entry.description);
      if (score >= minTextScore && (!best || score > best.score)) {
        best = { code: entry.code, matchSource: 'text', score: Math.round(score * 100) / 100, auto: false };
      }
    }
    if (best) return best;
  }

  return null;
}

/**
 * Sugerencias para una tanda de productos.
 * @param {Array<{ sku, label? }>} products
 * @param {Array<{ code, description? }>} codes
 * @param {Record<string,string>} savedMap sku → código ya confirmado
 * @returns {{ auto: Array, review: Array, unmatched: Array }}
 */
export function buildMappingSuggestions(products, codes, savedMap = {}) {
  const auto = [];
  const review = [];
  const unmatched = [];

  for (const product of products) {
    const suggestion = suggestMatch(product, codes, { savedCode: savedMap[product.sku] });
    if (!suggestion) {
      unmatched.push({ ...product, suggestion: null });
    } else if (suggestion.auto) {
      auto.push({ ...product, suggestion });
    } else {
      review.push({ ...product, suggestion });
    }
  }
  return { auto, review, unmatched };
}
