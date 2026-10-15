/**
 * Tests de la escalera de coincidencia SKU ↔ código del proveedor (lib/skuMatcher.js).
 *
 * Lo importante que verifican: qué se aplica SOLO y qué solo se PROPONE. Equivocarse acá significa
 * publicar un precio mal en Mercado Libre: lo que coincide EXACTO con un código (el SKU entero o su
 * base `CODIGO-variante`) se aplica solo; el parecido por descripción solo se propone.
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
  assert.equal(baseCodeOf('39000-corazones'), '39000');
  assert.equal(baseCodeOf('BP700V-ROSA'), 'BP700V');
  assert.equal(baseCodeOf('30700 ROSA'), '30700');
});

test('expandCode: un rango con prefijo de letras conserva el prefijo', () => {
  assert.deepEqual(expandCode('BP3505-3507'), ['BP3505', 'BP3507']);
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

test('escalón 3 (base): CODIGO-variante se aplica SOLO (convención de la usuaria)', () => {
  const m = suggestMatch({ sku: '30700-ROSA' }, codes);
  assert.equal(m.code, '30700');
  assert.equal(m.matchSource, 'base');
  assert.equal(m.auto, true);
  const bp = suggestMatch({ sku: 'BP700V-LILA' }, [{ code: 'BP700V' }]);
  assert.equal(bp.code, 'BP700V');
  assert.equal(bp.auto, true);
});

test('escalón 4 (group): CODIGO-variante dentro de un código múltiple también se aplica solo', () => {
  const m = suggestMatch({ sku: '39134-AZUL' }, codes);
  assert.equal(m.code, '39021/22/33/34/38/134/135/136/137/138');
  assert.equal(m.matchSource, 'group');
  assert.equal(m.auto, true);
});

test('un SKU de un rango con prefijo matchea exacto', () => {
  const m = suggestMatch({ sku: 'BP3507' }, [{ code: 'BP3505-3507' }]);
  assert.equal(m.matchSource, 'exact');
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
    { sku: '30700-ROSA' },                              // base   → auto
    { sku: 'YA-MAPEADO' },                              // saved  → auto
    { sku: 'X', label: 'Repuesto Rayado x80hjs de 90g' }, // text → review
    { sku: 'OTRA-MARCA', label: 'Washi tape' },         // nada   → unmatched
  ];
  const { auto, review, unmatched } = buildMappingSuggestions(products, codes, { 'YA-MAPEADO': '39001' });

  assert.deepEqual(auto.map((p) => p.sku).sort(), ['30700', '30700-ROSA', '39001', 'YA-MAPEADO']);
  assert.deepEqual(review.map((p) => p.sku), ['X']);
  assert.deepEqual(unmatched.map((p) => p.sku), ['OTRA-MARCA']);
});

test('el parecido por descripción nunca queda marcado como automático', () => {
  const { auto, review } = buildMappingSuggestions([{ sku: 'X', label: 'Repuesto Rayado x80hjs de 90g' }], codes, {});
  assert.equal(auto.length, 0);
  assert.equal(review[0].suggestion.auto, false);
});

test('buildMappingSuggestions: dos packs con el MISMO sku no se pisan el mapeo guardado', () => {
  const products = [
    { key: 'pack:1', sku: '39000', isPack: true },
    { key: 'pack:2', sku: '39000', isPack: true },
  ];
  const { auto } = buildMappingSuggestions(products, [{ code: '39000' }], { 'pack:1': '39000' });
  const byKey = Object.fromEntries(auto.map((e) => [e.key, e.suggestion.matchSource]));
  assert.equal(byKey['pack:1'], 'saved');
  assert.equal(byKey['pack:2'], 'exact', 'el segundo pack tiene que salir como nuevo, para guardarse');
});
