/**
 * Tests del parser de listas de proveedor (lib/supplierListParser.js).
 *
 * El fixture `pdfPuntoCero.fixture.txt` es el texto REAL extraído del PDF de Punto Cero
 * (noviembre 2025). El PDF sale como un bloque continuo sin separadores entre columnas, así que
 * estos tests son la red que sostiene un parseo que de otro modo sería frágil.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseSupplierList, parseSupplierCsv, parseArNumber, splitCodeAndDescription,
} from '../src/lib/supplierListParser.js';

const pdfText = readFileSync(new URL('./pdfPuntoCero.fixture.txt', import.meta.url), 'utf8');
const parsed = parseSupplierList(pdfText);
const byCode = (code) => parsed.rows.find((r) => r.code === code);

test('parseArNumber: formato argentino (punto de miles, coma decimal)', () => {
  assert.equal(parseArNumber('8.800,00'), 8800);
  assert.equal(parseArNumber('$ 153.000,00'), 153000);
  assert.equal(parseArNumber('1.250,50'), 1250.5);
  assert.equal(parseArNumber('712,50'), 712.5);
  assert.equal(parseArNumber(''), null);
  assert.equal(parseArNumber(null), null);
});

test('PDF real: parsea las 72 filas y TODAS pasan la validación de precios', () => {
  assert.equal(parsed.stats.total, 72);
  assert.equal(parsed.stats.flagged, 0, `filas marcadas: ${JSON.stringify(parsed.flagged)}`);
  assert.equal(parsed.stats.valid, 72);
});

test('PDF real: la validación unitario × cantidad = bulto se cumple en todas', () => {
  for (const row of parsed.valid) {
    assert.ok(
      Math.abs(row.unitPrice * row.bulkQty - row.bulkPrice) <= 1,
      `${row.code}: ${row.unitPrice} × ${row.bulkQty} ≠ ${row.bulkPrice}`,
    );
  }
});

test('PDF real: una fila simple sale completa y bien', () => {
  const row = byCode('30700');
  assert.ok(row, 'no encontró el código 30700');
  assert.equal(row.unitPrice, 8800);
  assert.equal(row.bulkQty, 8);
  assert.equal(row.bulkPrice, 70400);
  assert.match(row.description, /Removible/);
  assert.equal(row.fractionable, false); // lleva `*`: no se fracciona
});

test('PDF real: el prefijo FULL no se confunde con un encabezado', () => {
  const row = byCode('FULL 30700');
  assert.ok(row, 'no encontró FULL 30700');
  assert.equal(row.unitPrice, 12600);
  assert.equal(row.bulkPrice, 100800);
  assert.ok(byCode('FULL 39000'), 'no encontró FULL 39000');
});

test('PDF real: el prefijo REP tampoco', () => {
  const row = byCode('REP50001');
  assert.ok(row, 'no encontró REP50001');
  assert.equal(row.unitPrice, 1250);
  assert.equal(row.bulkQty, 1);
});

test('PDF real: códigos múltiples se conservan enteros', () => {
  assert.ok(byCode('39021/22/33/34/38/134/135/136/137/138'), 'multi-código con / no se conservó');
  assert.ok(byCode('39024-39025'), 'multi-código con - no se conservó');
  assert.ok(byCode('39039/40/139/140/141'), 'multi-código mixto no se conservó');
});

test('PDF real: un número en la descripción NO se confunde con el código', () => {
  // "…x diseño Hjs.250g Pack x8 unid." — el 250 de "250g" no debe ganarle al código real.
  const row = byCode('30709');
  assert.ok(row, 'no encontró 30709 (probablemente tomó el 250 de "Hjs.250g")');
  assert.match(row.description, /Separador Solapas/);
  assert.equal(parsed.rows.filter((r) => r.code === '250').length, 0);
});

test('PDF real: el encabezado de sección no se pega al código', () => {
  // "CUADERNO A5" + "30700" quedan pegados como "CUADERNO A530700" en el texto crudo.
  for (const row of parsed.rows) {
    assert.ok(!/^A[45]/.test(row.code), `el código ${row.code} arrastró el encabezado de sección`);
  }
  assert.ok(byCode('50000'), 'no encontró 50000 (encabezado MINI CUADERNITOS pegado)');
  assert.ok(byCode('39650'), 'no encontró 39650 (encabezado MINI BIBLIORATOS A4 pegado)');
});

test('PDF real: las filas sin código propio heredan el de arriba', () => {
  const inherited = parsed.rows.filter((r) => r.inheritedCode);
  // Los 5 colores de biblioratos A4 (39650) y los 5 de A5 (30650).
  assert.equal(inherited.length, 10);
  assert.equal(inherited.filter((r) => r.code === '39650').length, 5);
  assert.equal(inherited.filter((r) => r.code === '30650').length, 5);
  assert.match(inherited[0].description, /ROSA/);
});

test('PDF real: "no se fracciona" (*) se detecta por fila', () => {
  assert.equal(byCode('30700').fractionable, false);      // lleva *
  assert.equal(byCode('39650').fractionable, true);       // los biblioratos no llevan *
  assert.equal(byCode('REP50001').fractionable, true);    // los repuestos mini tampoco
});

test('PDF real: las filas "A COTIZAR" (sin precio) no generan filas', () => {
  // 30000/30001 son exhibidores a cotizar: no tienen triplete de precios.
  assert.equal(byCode('30000'), undefined);
  assert.equal(byCode('30001'), undefined);
});

test('splitCodeAndDescription: casos sueltos', () => {
  assert.deepEqual(
    splitCodeAndDescription('*30702Repuesto Cuadric. x 80hjs'),
    { code: '30702', description: 'Repuesto Cuadric. x 80hjs' },
  );
  assert.deepEqual(
    splitCodeAndDescription('CUADERNO A530700A5 T/D'),
    { code: '30700', description: 'A5 T/D' },
  );
  // Sin código propio: lo resuelve el que llama, heredando el anterior.
  assert.equal(splitCodeAndDescription('A4 ROSA Dos anillos diámetro 60 ').code, null);
});

test('marca (no descarta) una fila cuando los números no cierran', () => {
  const bad = parseSupplierList('12345Producto trucho$ 1.000,005 $ 9.999,00');
  assert.equal(bad.stats.total, 1);
  assert.equal(bad.stats.flagged, 1);
  assert.equal(bad.rows[0].valid, false);
  assert.match(bad.rows[0].issues[0], /no cierra/);
});

test('texto vacío o basura no rompe', () => {
  assert.equal(parseSupplierList('').stats.total, 0);
  assert.equal(parseSupplierList(null).stats.total, 0);
  assert.equal(parseSupplierList('sin precios acá').stats.total, 0);
});

// ── CSV ────────────────────────────────────────────────────────────────────

test('CSV: parsea con ; y mapea columnas por encabezado', () => {
  const csv = [
    'Codigo;Descripcion;Precio unitario;Cant x bulto;Precio x bulto',
    '30700;Cuaderno A5;8.800,00;8;70.400,00',
    '39001;Repuesto A4;5.800,00;8;46.400,00',
  ].join('\n');
  const r = parseSupplierCsv(csv);
  assert.equal(r.stats.total, 2);
  assert.equal(r.stats.flagged, 0);
  assert.equal(r.rows[0].code, '30700');
  assert.equal(r.rows[0].unitPrice, 8800);
  assert.equal(r.rows[0].bulkPrice, 70400);
});

test('CSV: también marca las filas que no cierran', () => {
  const csv = 'Codigo;Precio unitario;Cant x bulto;Precio x bulto\n999;1.000,00;5;9.999,00';
  const r = parseSupplierCsv(csv);
  assert.equal(r.stats.flagged, 1);
  assert.match(r.rows[0].issues[0], /no cierra/);
});

// ── Las 3 listas de julio 2026 (texto extraído con pdfjs, igual que el front) ─────────────────
// Be Positive y Escolar traen códigos con letras. Hasta 2026-10-14 `BP700V` se leía como `700` y
// las filas siguientes lo heredaban: 46 productos con el mismo código, ninguno marcado.

const bePositive = parseSupplierList(readFileSync(new URL('./pdfBePositive.fixture.txt', import.meta.url), 'utf8'));
const escolar = parseSupplierList(readFileSync(new URL('./pdfEscolar.fixture.txt', import.meta.url), 'utf8'));
const puntoCeroJulio = parseSupplierList(readFileSync(new URL('./pdfPuntoCeroJulio2026.fixture.txt', import.meta.url), 'utf8'));
const codesOf = (p) => p.rows.map((r) => r.code);

test('Be Positive: 46 filas, cada una con su código BP (sin heredar nada)', () => {
  assert.equal(bePositive.stats.total, 46);
  assert.equal(bePositive.stats.flagged, 0);
  assert.equal(bePositive.rows.filter((r) => r.inheritedCode).length, 0);
  assert.ok(bePositive.rows.every((r) => /^BP\d/.test(r.code)), `códigos: ${codesOf(bePositive)}`);
  assert.equal(new Set(codesOf(bePositive)).size, 46, 'no puede haber códigos repetidos');
});

test('Be Positive: sufijo V, minúsculas y rangos', () => {
  const codes = codesOf(bePositive);
  assert.equal(codes[0], 'BP700V');
  assert.ok(codes.includes('BP1000'), 'la C de "Cuaderno" no es sufijo');
  assert.ok(codes.includes('BP1201'), 'bp1201 se guarda en mayúsculas');
  assert.ok(codes.includes('BP1551V'));
  assert.ok(codes.includes('BP3505-3507'));
  const row = bePositive.rows.find((r) => r.code === 'BP1000');
  assert.equal(row.bulkPrice, 40800);
  assert.equal(row.fractionable, false, 'el * viene con un espacio antes');
  assert.equal(bePositive.rows.find((r) => r.code === 'BP700V').fractionable, true);
});

test('Escolar: 63 filas, códigos V/R/LV con encabezados de sección pegados', () => {
  assert.equal(escolar.stats.total, 63);
  assert.equal(escolar.stats.flagged, 0);
  assert.equal(escolar.rows.filter((r) => r.inheritedCode).length, 0);
  const codes = codesOf(escolar);
  for (const c of ['V4900', 'V100', 'V1550', 'V600', 'V8000', 'V15700', 'R15000', 'R15000V', 'LV010', '449/499', '100900', '4992']) {
    assert.ok(codes.includes(c), `falta ${c}`);
  }
  assert.equal(codes.filter((c) => c === '100').length, 0, '"CARPETASV100" no puede dejar el código 100');
  assert.equal(new Set(codes).size, 63);
});

test('Mi Punto Cero julio 2026: sigue igual (39000 y FULL 39000)', () => {
  assert.equal(puntoCeroJulio.stats.total, 70);
  assert.equal(puntoCeroJulio.stats.flagged, 0);
  const row = puntoCeroJulio.rows.find((r) => r.code === '39000');
  assert.equal(row.bulkPrice, 119200);
  assert.ok(codesOf(puntoCeroJulio).includes('FULL 39000'));
  assert.equal(puntoCeroJulio.rows.filter((r) => r.inheritedCode).length, 10); // colores de biblioratos
});

test('una fila que arranca con un código no reconocido se marca, no hereda el de arriba', () => {
  const r = parseSupplierList('30700Cuaderno$ 1.000,008 $ 8.000,00*Kx12345 Algo raro$ 1.000,002 $ 2.000,00');
  assert.equal(r.rows[1].code, null);
  assert.equal(r.rows[1].inheritedCode, false);
  assert.equal(r.rows[1].valid, false);
  assert.match(r.rows[1].issues[0], /código no reconocido/);
});

test('splitCodeAndDescription: códigos con letras', () => {
  assert.equal(splitCodeAndDescription('BULTOBP700V Cuaderno').code, 'BP700V');
  assert.equal(splitCodeAndDescription('CARPETASV100 Carpeta').code, 'V100');
  assert.equal(splitCodeAndDescription('CARTULINASv15700Cartulinas').code, 'V15700');
  assert.equal(splitCodeAndDescription(' *LV010Libreta').code, 'LV010');
  assert.equal(splitCodeAndDescription('BP1000Cuaderno').code, 'BP1000');
});
