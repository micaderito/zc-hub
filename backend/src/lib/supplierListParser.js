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
 */

/** `$ 8.800,00` + `8` + `$ 70.400,00` — el corazón del formato. */
const PRICE_TRIPLET = /\$\s*([\d.]+,\d{2})\s*(\d+)\s*\$\s*([\d.]+,\d{2})/g;

/**
 * Un código: 3-6 dígitos, con prefijo FULL/REP opcional y grupos separados por `/` o `-`
 * (ej. `39021/22/33/34/38`, `39024-39025`, `FULL 30700`, `REP50001`).
 */
const CODE = /(?:FULL\s*\d{3,6}|REP\s*\d{3,6}|\d{3,6}(?:\s*[/\-]\s*\d{1,6})*)/g;

/**
 * Encabezados de sección (`CUADERNO A5`, `MINI BIBLIORATOS A4`, …). En el texto crudo quedan
 * pegados al código que sigue (`CUADERNO A5` + `30700` = `CUADERNO A530700`), y el `5` del `A5` se
 * confundiría con el primer dígito del código. Se les mete un salto de línea antes del número.
 * `FULL`/`REP` se excluyen a propósito: son prefijos de código, no encabezados.
 */
const SECTION_HEADER = /((?!REP\s*\d)[A-ZÁÉÍÓÚÑ]{3,}(?:\s+[A-ZÁÉÍÓÚÑ]{2,})*(?:\s+A[45])?)(?=\d)/g;

/** `8.800,00` (es-AR: punto de miles, coma decimal) → 8800. */
export function parseArNumber(raw) {
  if (raw == null) return null;
  const clean = String(raw).trim().replace(/\$/g, '').replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
  if (clean === '') return null; // `Number('')` es 0, que acá sería un precio falso de $0
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

/**
 * Separa "código + descripción" de un bloque de texto.
 *
 * El código es el que ARRANCA la última línea, no cualquiera del bloque:
 *  - No puede ser el último número del bloque, porque las descripciones traen números
 *    (`Hjs.250g`, `de 90 g`, `x40 hojas`) y se elegiría uno de esos.
 *  - No puede ser el primero del bloque, porque antes puede haber basura de la fila anterior o del
 *    encabezado del PDF (`... NOVIEMBRE 2025 ... CÓDIGO ...`).
 * Meterle un salto de línea a los encabezados de sección (SECTION_HEADER) deja el código real
 * arrancando la última línea, que es donde empieza la fila de verdad.
 *
 * Devuelve `{ code: null }` cuando el bloque no tiene código propio (ej. los colores de los
 * biblioratos, que heredan el de arriba).
 */
export function splitCodeAndDescription(chunk) {
  const cleaned = chunk.replace(/^[\s*]+/, '').replace(SECTION_HEADER, '$1\n');
  const lastLine = cleaned.slice(cleaned.lastIndexOf('\n') + 1).trim();

  const leading = new RegExp(`^(${CODE.source})`).exec(lastLine);
  if (!leading) return { code: null, description: lastLine };

  const code = leading[1].replace(/\s*([/\-])\s*/g, '$1').replace(/\s+/g, ' ').trim();
  const description = lastLine.slice(leading[1].length).trim();
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
    // El `*` justo después del triplete significa "no se fracciona" (venta solo por pack).
    const fractionable = text[lastEnd] !== '*';

    let { code, description } = splitCodeAndDescription(chunk);
    let inheritedCode = false;
    if (!code && lastCode) {
      // Filas sin código propio (los colores de los biblioratos): heredan el de arriba.
      code = lastCode;
      inheritedCode = true;
    }
    if (code && !inheritedCode) lastCode = code;

    const issues = [];
    if (!code) issues.push('sin código');
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
