/**
 * Tests de las funciones de categorías (para el selector al crear producto):
 *  - ML: getSiteCategories, getCategory, getCategoryAttributes, predictCategory.
 *  - TN: getCategories (paginado).
 *
 * Mockeamos `node-fetch` con mock.module (igual que mercadolibre.test.js) e inspeccionamos
 * la URL/params que arma cada función, sin tocar la red.
 */
import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const state = { responder: null, calls: [] };

async function mockFetch(url, opts = {}) {
  state.calls.push({ url, method: opts.method || 'GET', headers: opts.headers || {} });
  return state.responder(url, opts);
}

function makeRes({ status = 200, json = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => json,
    text: async () => JSON.stringify(json ?? {}),
  };
}

const TOKEN = 'test-token';

let ml;
let tn;
before(async () => {
  mock.module('node-fetch', { exports: { default: mockFetch } });
  ml = await import('../src/lib/mercadolibre.js');
  tn = await import('../src/lib/tiendanube.js');
});
beforeEach(() => {
  state.calls = [];
  state.responder = null;
});

/* ───────────────────────── Mercado Libre ───────────────────────── */

test('getSiteCategories: GET /sites/MLA/categories y devuelve el array', async () => {
  const roots = [{ id: 'MLA1367', name: 'Arte, Librería y Mercería' }];
  state.responder = () => makeRes({ json: roots });

  const out = await ml.getSiteCategories(TOKEN, 'MLA');
  assert.deepEqual(out, roots);
  assert.match(state.calls[0].url, /\/sites\/MLA\/categories$/);
});

test('getCategory: GET /categories/{id} con children y path_from_root', async () => {
  const cat = { id: 'MLA388307', name: 'Cuadernos', children_categories: [], path_from_root: [] };
  state.responder = () => makeRes({ json: cat });

  const out = await ml.getCategory(TOKEN, 'MLA388307');
  assert.equal(out.id, 'MLA388307');
  assert.ok(state.calls[0].url.endsWith('/categories/MLA388307'));
});

test('getCategoryAttributes: GET /categories/{id}/attributes', async () => {
  const attrs = [{ id: 'BRAND', name: 'Marca', value_type: 'string', tags: { required: true } }];
  state.responder = () => makeRes({ json: attrs });

  const out = await ml.getCategoryAttributes(TOKEN, 'MLA388307');
  assert.deepEqual(out, attrs);
  assert.ok(state.calls[0].url.endsWith('/categories/MLA388307/attributes'));
});

test('predictCategory: arma q + limit y pega al domain_discovery', async () => {
  const preds = [{ category_id: 'MLA388307', category_name: 'Cuadernos', attributes: [] }];
  state.responder = () => makeRes({ json: preds });

  const out = await ml.predictCategory(TOKEN, 'cuaderno rayado a5', 'MLA', 5);
  assert.deepEqual(out, preds);
  const url = state.calls[0].url;
  assert.match(url, /\/sites\/MLA\/domain_discovery\/search\?/);
  assert.match(url, /q=cuaderno\+rayado\+a5/);
  assert.match(url, /limit=5/);
});

test('getCategory: devuelve null si ML responde error (no throw)', async () => {
  state.responder = () => makeRes({ status: 404 });
  const out = await ml.getCategory(TOKEN, 'MLA000');
  assert.equal(out, null);
});

/* ───────────────────────── Tienda Nube ───────────────────────── */

test('getCategories (TN): pagina /categories hasta una página incompleta', async () => {
  const page1 = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, name: { es: `Cat ${i + 1}` } }));
  const page2 = [{ id: 201, name: { es: 'Última' } }];
  state.responder = (url) => makeRes({ json: url.includes('page=1') ? page1 : page2 });

  const out = await tn.getCategories(TOKEN, '12345');
  assert.equal(out.length, 201);
  // Debe haber pedido al menos 2 páginas y cortar en la incompleta.
  const pages = state.calls.filter((c) => c.url.includes('/categories?'));
  assert.equal(pages.length, 2);
  assert.match(state.calls[0].url, /\/v1\/12345\/categories\?page=1/);
});

test('getCategories (TN): manda header Authentication bearer y User-Agent', async () => {
  state.responder = () => makeRes({ json: [] });
  await tn.getCategories(TOKEN, '12345');
  const h = state.calls[0].headers;
  assert.equal(h.Authentication, `bearer ${TOKEN}`);
  assert.ok(h['User-Agent']);
});
