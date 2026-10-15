/**
 * Parser de listas de precios de proveedor. PURO: entra texto, salen filas. Sin I/O ni red.
 *
 * El PDF de Punto Cero se extrae como un bloque continuo SIN separadores entre columnas:
 *
 *   30700A5  T/Dx80hjs.Removible c/elástico. Pack x8 unid. surt.$ 8.800,008 $ 70.400,00*
 *   └code┘└──────────────── descripción ────────────────────┘└unit─┘│└─bulto─┘│
 *                                                                   └ cantidad └ "no se fracciona"
 *
 * La estrategia es anclarse en lo único rígido del formato: el patrón de precios en moneda
 * argentina (`$ X.XXX,XX`). Se buscan todos los tripletes (unitario + cantidad + bulto) y el texto
 * entre uno y otro es "código + descripción" de esa fila.
 *
 * El parseo SE VALIDA SOLO: si `precio_unitario × cantidad ≠ precio_bulto`, la fila se marca y no
 * se usa. Eso convierte un parseo frágil en uno que falla ruidosamente en vez de en silencio.
 *
 * Se usa con las 3 listas de la usuaria (Mi Punto Cero, Escolar, Be Positive). Las dos últimas
 * traen códigos con letras (`BP700V`, `bp1201`, `V600`, `R15000V`, `LV010`, `BP3505-3507`): hasta
 * 2026-10-14 el código solo admitía dígitos, así que `BP700V` se leía como `700` y todas las filas
 * siguientes, "sin código", lo HEREDABAN — 46 productos con el mismo código y ninguno marcado.
 */

/** `$ 8.800,00` + `8` + `$ 70.400,00` — el corazón del formato. */
const PRICE_TRIPLET = /\$\s*([\d.]+,\d{2})\s*(\d+)\s*\$\s*([\d.]+,\d{2})/g;

/** Prefijos de letras de los códigos (`FULL 30700`, `REP50001`, `BP700V`, `BPN2650`, `LV010`, `V600`, `R15000`). */
const PREFIX = String.raw`(?:FULL\s*|REP\s*|[Bb][Pp][Nn]?|[Ll][Vv]|[Vv]|[Rr])`;

/**
 * Un código: prefijo opcional + 3-6 dígitos + `V` final opcional (`BP700V`; solo si después viene
 * un espacio o una palabra, para no comerse la `V` de una descripción) + grupos separados por `/`
 * o `-` (`39021/22/33`, `39024-39025`, `BP3505-3507`).
 */
const CODE = String.raw`${PREFIX}?\d{3,6}(?:V(?=\s|[A-ZÁÉÍÓÚÑ][a-záéíóúñ]|$))?(?:\s*[/\-]\s*${PREFIX}?\d{1,6})*`;
const LEADING_CODE = new RegExp(`^(${CODE})`);

/**
 * Encabezados de sección (`CUADERNO A5`, `CARPETAS`, `MINI BIBLIORATOS A4`, …) pegados al código
 * que sigue (`CUADERNO A530700`, `CARPETASV100`): se les mete un salto de línea antes del código.
 * El encabezado es lo más CORTO posible (`CARPETAS` + `V100`, no `CARPETASV` + `100`) y tiene que
 * ir pegado al código: `TAPA DURA 100 Hojas` es descripción, no encabezado. Tampoco puede
 * arrancar donde arranca un código (si no, `BULTOBP700V` partiría también `BP` | `700V`).
 */
const SECTION_HEADER = new RegExp(
  String.raw`(?!${CODE})((?:[A-ZÁÉÍÓÚÑ]{2,}\s+)*?[A-ZÁÉÍÓÚÑ]{2,}?(?:\s*A[45])?)(?=${CODE})`,
  'g',
);

/** Algo que empieza como un código (`XX123`) aunque no sea uno reconocido: no se hereda el de arriba. */
const CODE_LIKE = /^[A-Za-z]{0,4}\d{3,}/;

/** `8.800,00` (es-AR: punto de miles, coma decimal) → 8800. */
export function parseArNumber(raw) {
  if (raw == null) return null;
  const clean = String(raw).trim().replace(/\$/g, '').replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
  if (clean === '') return null; // `Number('')` es 0, que acá sería un precio falso de $0
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

/** Forma canónica de un código: mayúsculas, sin espacios alrededor de `/`/`-`, `FULL 30700` con un espacio. */
export function canonicalCode(raw) {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/\s*([/\-])\s*/g, '$1')
    .replace(/^FULL\s*/, 'FULL ')
    .replace(/^REP\s*/, 'REP')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Separa "código + descripción" de un bloque de texto.
 *
 * Si el bloque ARRANCA con un código, ese es (el caso normal: la fila viene justo después del
 * precio de la anterior). Si no, el código es el que arranca la última línea, no cualquiera:
 *  - No puede ser el último número del bloque, porque las descripciones traen números
 *    (`Hjs.250g`, `de 90 g`, `x40 hojas`) y se elegiría uno de esos.
 *  - No puede ser el primero del bloque, porque antes puede haber basura del encabezado del PDF
 *    (`... JULIO 2026 ... CÓDIGO ...`) o un encabezado de sección.
 * Meterle un salto de línea a los encabezados de sección (SECTION_HEADER) deja el código real
 * arrancando la última línea, que es donde empieza la fila de verdad.
 *
 * Devuelve `{ code: null }` cuando el bloque no tiene código propio (ej. los colores de los
 * biblioratos, que heredan el de arriba); `codeLike: true` si igual arranca con algo que parece un
 * código — esa fila NO debe heredar.
 */
export function splitCodeAndDescription(chunk) {
  const stripped = chunk.replace(/^[\s*]+/, '');
  let line = stripped;
  if (!LEADING_CODE.test(stripped)) {
    const cleaned = stripped.replace(SECTION_HEADER, '$1\n');
    line = cleaned.slice(cleaned.lastIndexOf('\n') + 1).trim();
  }

  const leading = LEADING_CODE.exec(line);
  if (!leading) return { code: null, description: line.trim(), codeLike: CODE_LIKE.test(line) };

  const code = canonicalCode(leading[1]);
  const description = line.slice(leading[1].length).trim();
  return { code, description };
}

/**
 * Parsea el texto de una lista (extraído de un PDF o pegado a mano).
 *
 * @param {string} text
 * @param {{ tolerance?: number }} [opts] tolerancia absoluta en pesos para la validación
 *   `unitario × cantidad = bulto` (default 1, para absorber redondeos del proveedor).
 * @returns {{ rows: Array, valid: Array, flagged: Array, stats: object }}
 *   Cada fila: { code, description, unitPrice, bulkQty, bulkPrice, fractionable, inheritedCode,
 *   valid, issues[] }.
 */
export function parseSupplierList(text, opts = {}) {
  const tolerance = opts.tolerance ?? 1;
  const rows = [];
  if (!text || typeof text !== 'string') {
    return { rows, valid: [], flagged: [], stats: { total: 0, valid: 0, flagged: 0 } };
  }

  let lastEnd = 0;
  let lastCode = null;
  PRICE_TRIPLET.lastIndex = 0;

  for (const m of text.matchAll(PRICE_TRIPLET)) {
    const chunk = text.slice(lastEnd, m.index);
    lastEnd = m.index + m[0].length;

    const unitPrice = parseArNumber(m[1]);
    const bulkQty = Number(m[2]);
    const bulkPrice = parseArNumber(m[3]);
    // El `*` después del triplete significa "no se fracciona" (venta solo por pack). Según cómo se
    // extraiga el PDF puede venir con un espacio antes (`$ 40.800,00 *`).
    const fractionable = !/^\s*\*/.test(text.slice(lastEnd, lastEnd + 4));

    const split = splitCodeAndDescription(chunk);
    let { code } = split;
    const { description } = split;
    let inheritedCode = false;
    if (!code && lastCode && !split.codeLike) {
      // Filas sin código propio (los colores de los biblioratos): heredan el de arriba. Una fila que
      // arranca con algo parecido a un código que no se reconoce NO hereda: se marca.
      code = lastCode;
      inheritedCode = true;
    }
    if (code && !inheritedCode) lastCode = code;

    const issues = [];
    if (!code) issues.push(split.codeLike ? 'código no reconocido' : 'sin código');
    if (!(unitPrice > 0)) issues.push('precio unitario inválido');
    if (!(bulkQty > 0)) issues.push('cantidad por bulto inválida');
    if (!(bulkPrice > 0)) issues.push('precio por bulto inválido');
    // La validación que hace que el parseo falle ruidosamente en vez de en silencio.
    if (unitPrice > 0 && bulkQty > 0 && bulkPrice > 0) {
      const expected = unitPrice * bulkQty;
      if (Math.abs(expected - bulkPrice) > tolerance) {
        issues.push(`no cierra: ${unitPrice} × ${bulkQty} = ${expected}, la lista dice ${bulkPrice}`);
      }
    }

    rows.push({
      code,
      description: description || null,
      unitPrice,
      bulkQty,
      bulkPrice,
      fractionable,
      inheritedCode,
      valid: issues.length === 0,
      issues,
    });
  }

  const valid = rows.filter((r) => r.valid);
  const flagged = rows.filter((r) => !r.valid);
  return {
    rows,
    valid,
    flagged,
    stats: { total: rows.length, valid: valid.length, flagged: flagged.length },
  };
}

/**
 * Parsea una lista en CSV/TSV. Alternativa al PDF: cubre el caso de que el proveedor cambie el
 * formato o de que otra marca mande la lista en planilla. Detecta el separador y mapea las
 * columnas por nombre de encabezado (tolerante a mayúsculas/acentos).
 */
export function parseSupplierCsv(text) {
  const rows = [];
  if (!text || typeof text !== 'string') {
    return { rows, valid: [], flagged: [], stats: { total: 0, valid: 0, flagged: 0 } };
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return { rows, valid: [], flagged: [], stats: { total: 0, valid: 0, flagged: 0 } };

  const sep = (lines[0].match(/;/g)?.length ?? 0) >= (lines[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  const norm = (s) => (s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const headers = lines[0].split(sep).map(norm);

  /**
   * Busca la columna por nombre, salteando las ya asignadas. El orden importa: "cant x bulto" y
   * "precio x bulto" comparten la palabra "bulto", así que la cantidad se resuelve primero y su
   * índice queda excluido para que el precio no se la robe.
   */
  const used = new Set();
  const findCol = (...names) => {
    const idx = headers.findIndex((h, i) => !used.has(i) && names.some((n) => h.includes(n)));
    if (idx >= 0) used.add(idx);
    return idx;
  };
  const iCode = findCol('codigo', 'code', 'sku');
  const iDesc = findCol('descripcion', 'detalle', 'producto', 'description');
  const iUnit = findCol('precio unitario', 'unitario', 'precio x unidad');
  const iQty = findCol('cant', 'unidades');
  const iBulk = findCol('precio x bulto', 'precio bulto', 'por bulto', 'bulto');

  for (const line of lines.slice(1)) {
    const cells = line.split(sep);
    const code = iCode >= 0 ? (cells[iCode] || '').trim() : null;
    const unitPrice = iUnit >= 0 ? parseArNumber(cells[iUnit]) : null;
    const bulkQty = iQty >= 0 ? Number(String(cells[iQty] || '').trim()) : null;
    const bulkPrice = iBulk >= 0 ? parseArNumber(cells[iBulk]) : null;
    if (!code && unitPrice == null && bulkPrice == null) continue;

    const issues = [];
    if (!code) issues.push('sin código');
    if (!(unitPrice > 0) && !(bulkPrice > 0)) issues.push('sin precio');
    if (unitPrice > 0 && bulkQty > 0 && bulkPrice > 0 && Math.abs(unitPrice * bulkQty - bulkPrice) > 1) {
      issues.push(`no cierra: ${unitPrice} × ${bulkQty} ≠ ${bulkPrice}`);
    }

    rows.push({
      code: code || null,
      description: iDesc >= 0 ? (cells[iDesc] || '').trim() || null : null,
      unitPrice,
      bulkQty: Number.isFinite(bulkQty) && bulkQty > 0 ? bulkQty : null,
      bulkPrice,
      fractionable: true,
      inheritedCode: false,
      valid: issues.length === 0,
      issues,
    });
  }

  const valid = rows.filter((r) => r.valid);
  const flagged = rows.filter((r) => !r.valid);
  return {
    rows,
    valid,
    flagged,
    stats: { total: rows.length, valid: valid.length, flagged: flagged.length },
  };
}
