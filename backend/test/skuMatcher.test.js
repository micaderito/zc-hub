/**
 * Tests de la escalera de coincidencia SKU ↔ código del proveedor (lib/skuMatcher.js).
 *
 * Lo importante que verifican: qué se aplica SOLO y qué solo se PROPONE. Equivocarse acá significa
 * publicar un precio mal en Mercado Libre, así que del escalón "base" en adelante nada puede
 * auto-aplicarse.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  suggestMatch, buildMappingSuggestions, expandCode, baseCodeOf, textSimilarity, normalizeCode,
} from '../src/lib/skuMatcher.js';

/** Catálogo chico con los casos reales del PDF de Punto Cero. */
const codes = [
  { code: '30700', description: 'A5 T/Dx80hjs.Removible c/elástico. Pack x8 unid. surt.' },
  { code: 'FULL 30700', description: 'A5 T/Dx80hjs.Removible c/elástico + Extras Pack x8 unid.' },
  { code: '39001', description: 'Repuesto Rayado x80hjs de 90g. Pack x8 unid.' },
  { code: '39021/22/33/34/38/134/135/136/137/138', description: 'Paneles, block x40 hojas de 90 g.' },
  { code: '39024-39025', description: 'Kit tiras A4, 3 blocks x40 hjs. de 90 g.' },
  { code: 'REP50001', description: 'Repuesto Mini Cuadernitos hojas blancas.' },
];

test('normalizeCode: saca acentos, espacios y mayúsculas', () => {
  assert.equal(normalizeCode(' full 30700 '), 'FULL30700');
  assert.equal(normalizeCode('30700-rosa'), '30700-ROSA');
});

test('expandCode: los códigos múltiples se expanden completando la base', () => {
  assert.deepEqual(expandCode('39021/22/33'), ['39021', '39022', '39033']);
  assert.deepEqual(expandCode('39039/40/139/140/141'), ['39039', '39040', '39139', '39140', '39141']);
  assert.deepEqual(expandCode('39024-39025'), ['39024', '39025']);
  assert.deepEqual(expandCode('30700'), ['30700']);
  assert.deepEqual(expandCode(''), []);
});

test('baseCodeOf: quita los sufijos que agregás vos al SKU', () => {
  assert.equal(baseCodeOf('30700-ROSA'), '30700');
  assert.equal(baseCodeOf('39001_A'), '39001');
  assert.equal(baseCodeOf('30700'), '30700');
  assert.equal(baseCodeOf('LAPICERA-GEL'), null);
});

test('escalón 1 (exact): el SKU igual al código se aplica SOLO', () => {
  const m = suggestMatch({ sku: '30700' }, codes);
  assert.equal(m.code, '30700');
  assert.equal(m.matchSource, 'exact');
  assert.equal(m.auto, true);
});

test('escalón 1 (exact): un SKU que cae dentro de un código múltiple también es exacto', () => {
  const m = suggestMatch({ sku: '39033' }, codes);
  assert.equal(m.code, '39021/22/33/34/38/134/135/136/137/138');
  assert.equal(m.matchSource, 'exact');
  assert.equal(m.auto, true);
});

test('escalón 2 (saved): un mapeo ya confirmado le gana a todo y se aplica SOLO', () => {
  const m = suggestMatch({ sku: '30700' }, codes, { savedCode: '39001' });
  assert.equal(m.code, '39001');
  assert.equal(m.matchSource, 'saved');
  assert.equal(m.auto, true);
});

test('escalón 3 (base): SKU con sufijo propio PROPONE, no aplica solo', () => {
  const m = suggestMatch({ sku: '30700-ROSA' }, codes);
  assert.equal(m.code, '30700');
  assert.equal(m.matchSource, 'base');
  assert.equal(m.auto, false, 'nunca debe auto-aplicarse');
});

test('escalón 4 (group): SKU con sufijo que cae en un código múltiple PROPONE', () => {
  const m = suggestMatch({ sku: '39134-AZUL' }, codes);
  assert.equal(m.code, '39021/22/33/34/38/134/135/136/137/138');
  assert.equal(m.matchSource, 'group');
  assert.equal(m.auto, false);
});

test('escalón 5 (text): sin código parecido, cae en similitud de descripción y PROPONE', () => {
  const m = suggestMatch(
    { sku: 'MINI-BLANCAS', label: 'Repuesto Mini Cuadernitos hojas blancas' },
    codes,
  );
  assert.equal(m.code, 'REP50001');
  assert.equal(m.matchSource, 'text');
  assert.equal(m.auto, false);
});

test('un SKU sin ninguna relación no devuelve sugerencia', () => {
  assert.equal(suggestMatch({ sku: 'LAPICERA-GEL-X6', label: 'Lapicera gel pastel' }, codes), null);
});

test('textSimilarity: 1 para idénticos, 0 para nada que ver', () => {
  assert.equal(textSimilarity('Repuesto Rayado 90g', 'Repuesto Rayado 90g'), 1);
  assert.equal(textSimilarity('Cuaderno A5', 'Mochila Everlast'), 0);
});

test('buildMappingSuggestions: separa lo automático de lo que hay que confirmar', () => {
  const products = [
    { sku: '30700' },                                   // exact  → auto
    { sku: '39001', label: 'Repuesto A4' },             // exact  → auto
    { sku: '30700-ROSA' },                              // base   → review
    { sku: 'YA-MAPEADO' },                              // saved  → auto
    { sku: 'OTRA-MARCA', label: 'Washi tape' },         // nada   → unmatched
  ];
  const { auto, review, unmatched } = buildMappingSuggestions(products, codes, { 'YA-MAPEADO': '39001' });

  assert.deepEqual(auto.map((p) => p.sku).sort(), ['30700', '39001', 'YA-MAPEADO']);
  assert.deepEqual(review.map((p) => p.sku), ['30700-ROSA']);
  assert.deepEqual(unmatched.map((p) => p.sku), ['OTRA-MARCA']);
});

test('ningún escalón dudoso queda marcado como automático', () => {
  const products = [{ sku: '30700-ROSA' }, { sku: '39134-AZUL' }, { sku: 'X', label: 'Repuesto Rayado x80hjs de 90g' }];
  const { auto, review } = buildMappingSuggestions(products, codes, {});
  assert.equal(auto.length, 0, 'nada dudoso puede aplicarse solo');
  assert.equal(review.length, 3);
  for (const r of review) assert.equal(r.suggestion.auto, false);
});
