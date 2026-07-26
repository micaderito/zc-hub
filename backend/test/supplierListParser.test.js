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
