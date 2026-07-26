/**
 * Tests del generador de SEO (Gemini). Mockeamos el `fetch` global para no pegarle a la API real:
 * cubre el parseo del JSON (incluido el envuelto en ```json), el recorte a los límites de TN
 * (70 / 320) y los errores (falta de API key, respuesta inesperada, HTTP no OK).
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateSeo, isLlmConfigured, SEO_TITLE_MAX, SEO_DESCRIPTION_MAX } from '../src/lib/llm.js';

const realFetch = globalThis.fetch;
const realKey = process.env.LLM_API_KEY;

/** Respuesta con forma de la API de Gemini, con el texto que devuelve el modelo. */
function geminiRes(text, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
    text: async () => text
  };
}

beforeEach(() => {
  process.env.LLM_API_KEY = 'test-key';
  process.env.LLM_MODEL = 'gemini-3.1-flash-lite';
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.LLM_API_KEY;
  else process.env.LLM_API_KEY = realKey;
});

test('isLlmConfigured: refleja si hay LLM_API_KEY', () => {
  assert.equal(isLlmConfigured(), true);
  delete process.env.LLM_API_KEY;
  assert.equal(isLlmConfigured(), false);
});

test('generateSeo: parsea el JSON del modelo y devuelve título y descripción', async () => {
  globalThis.fetch = async () =>
    geminiRes('{"seo_title":"Cuaderno A4 | Zona Cuaderno","seo_description":"Cuaderno premium de tapa dura."}');
  const seo = await generateSeo({ name: 'Cuaderno A4', brand: 'Zona Cuaderno' });
  assert.equal(seo.seoTitle, 'Cuaderno A4 | Zona Cuaderno');
  assert.equal(seo.seoDescription, 'Cuaderno premium de tapa dura.');
});

test('generateSeo: devuelve las tags como string separado por comas (formato de TN)', async () => {
  globalThis.fetch = async () =>
    geminiRes('{"seo_title":"T","seo_description":"D","tags":["cuaderno a4","tapa dura","escolar"]}');
  const seo = await generateSeo({ name: 'Cuaderno A4' });
  assert.equal(seo.tags, 'cuaderno a4, tapa dura, escolar');
});

test('generateSeo: normaliza las tags (minúscula, sin duplicados ni vacías, máx 8)', async () => {
  const many = ['Cuaderno', 'cuaderno', '  ', 'A4', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
  globalThis.fetch = async () =>
    geminiRes(JSON.stringify({ seo_title: 'T', seo_description: 'D', tags: many }));
  const seo = await generateSeo({ name: 'Cuaderno A4' });
  const tags = seo.tags.split(', ');
  assert.equal(tags.length, 8); // tope
  assert.equal(tags[0], 'cuaderno');
  // 'Cuaderno' y 'cuaderno' colapsan en una sola; no hay vacías.
  assert.equal(new Set(tags).size, tags.length);
  assert.ok(!tags.includes(''));
});

test('generateSeo: si el modelo no devuelve tags, quedan vacías (no rompe)', async () => {
  globalThis.fetch = async () => geminiRes('{"seo_title":"T","seo_description":"D"}');
  const seo = await generateSeo({ name: 'Cuaderno A4' });
  assert.equal(seo.tags, '');
});

test('generateSeo: parsea aunque el modelo envuelva el JSON en ```json', async () => {
  globalThis.fetch = async () =>
    geminiRes('```json\n{"seo_title":"Titulo","seo_description":"Desc"}\n```');
  const seo = await generateSeo({ name: 'Cuaderno A4' });
  assert.equal(seo.seoTitle, 'Titulo');
  assert.equal(seo.seoDescription, 'Desc');
});

test('generateSeo: recorta a los límites de TN (70 / 320) sin cortar palabras al medio', async () => {
  const longTitle = 'Cuaderno '.repeat(20).trim(); // >70
  const longDesc = 'Descripción larguísima '.repeat(40).trim(); // >320
  globalThis.fetch = async () =>
    geminiRes(JSON.stringify({ seo_title: longTitle, seo_description: longDesc }));
  const seo = await generateSeo({ name: 'Cuaderno A4' });
  assert.ok(seo.seoTitle.length <= SEO_TITLE_MAX, `title ${seo.seoTitle.length} > ${SEO_TITLE_MAX}`);
  assert.ok(seo.seoDescription.length <= SEO_DESCRIPTION_MAX);
  // No termina cortado a mitad de palabra.
  assert.ok(!seo.seoTitle.endsWith('Cuader'));
});

test('generateSeo: sin LLM_API_KEY lanza 503', async () => {
  delete process.env.LLM_API_KEY;
  await assert.rejects(() => generateSeo({ name: 'Cuaderno' }), (e) => e.statusCode === 503);
});

test('generateSeo: sin nombre lanza 400', async () => {
  await assert.rejects(() => generateSeo({ name: '   ' }), (e) => e.statusCode === 400);
});

test('generateSeo: si la API responde error lanza 502', async () => {
  globalThis.fetch = async () => geminiRes('quota exceeded', { ok: false, status: 429 });
  await assert.rejects(() => generateSeo({ name: 'Cuaderno' }), (e) => e.statusCode === 502);
});

test('generateSeo: si el modelo no devuelve JSON lanza 502', async () => {
  globalThis.fetch = async () => geminiRes('no soy json');
  await assert.rejects(() => generateSeo({ name: 'Cuaderno' }), (e) => e.statusCode === 502);
});
