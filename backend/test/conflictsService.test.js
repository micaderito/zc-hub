/**
 * Tests de conflictsService.js (getAnalysis): cruza publicaciones de ML y TN por SKU para
 * detectar coincidencias, solo-ML, solo-TN, sin SKU y SKU duplicados.
 *
 * Mockeamos:
 * - '../src/store.js' (tokens, getMlToken, tryRefreshMlToken, setMlTokenKnownInvalid,
 *   setTnTokenKnownInvalid, setResolutionFromAnalysis) — no hay tokens reales.
 * - '../src/db.js' (hasDatabase, getAnalysisSnapshot, setAnalysisSnapshot) — no hay Postgres real.
 * - '../src/lib/mercadolibre.js' (fetchWith429Retry) — conflictsService pega directo a la API
 *   de búsqueda/multiget de ML con esta función, sin pasar por getItem/getItems.
 * - '../src/lib/tiendanube.js' (getProducts) — TN devuelve productos con variants/images embebidos.
 */
import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const storeState = {
  tokens: {
    mercadolibre: { access_token: null, user_id: null },
    tiendanube: { access_token: null, store_id: null }
  },
  mlToken: null,
  refreshedToken: null,
  setMlInvalidCalls: [],
  setTnInvalidCalls: [],
  resolutionCalls: [],
};

const dbState = { hasDb: false, snapshot: null, setSnapshotCalls: [] };

const mlState = { responder: null, getItemImpl: null };
const tnState = { getProductsImpl: null };

function makeRes({ status = 200, json = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => json,
    text: async () => JSON.stringify(json ?? {}),
  };
}

let conflictsService;
before(async () => {
  mock.module('../src/store.js', {
    exports: {
      tokens: storeState.tokens,
      getMlToken: async () => storeState.mlToken,
      tryRefreshMlToken: async () => storeState.refreshedToken,
      setMlTokenKnownInvalid: (v) => storeState.setMlInvalidCalls.push(v),
      setTnTokenKnownInvalid: (v) => storeState.setTnInvalidCalls.push(v),
      setResolutionFromAnalysis: (ml, tn) => storeState.resolutionCalls.push({ ml, tn }),
    },
  });
  mock.module('../src/db.js', {
    exports: {
      hasDatabase: () => dbState.hasDb,
      getAnalysisSnapshot: async () => dbState.snapshot,
      setAnalysisSnapshot: async (d) => { dbState.setSnapshotCalls.push(d); dbState.snapshot = { at: Date.now(), data: d }; },
      invalidateAnalysisCache: async () => { dbState.snapshot = null; },
    },
  });
  mock.module('../src/lib/mercadolibre.js', {
    exports: {
      fetchWith429Retry: async (url, opts, ctx) => mlState.responder(url, opts, ctx),
      getItem: async (token, itemId) => (mlState.getItemImpl ? mlState.getItemImpl(itemId) : null),
    },
  });
  mock.module('../src/lib/tiendanube.js', {
    exports: {
      getProducts: async (token, storeId) => tnState.getProductsImpl(token, storeId),
    },
  });
  conflictsService = await import('../src/services/conflictsService.js');
});

beforeEach(() => {
  storeState.tokens.mercadolibre = { access_token: null, user_id: null };
  storeState.tokens.tiendanube = { access_token: null, store_id: null };
  storeState.mlToken = null;
  storeState.refreshedToken = null;
  storeState.setMlInvalidCalls = [];
  storeState.setTnInvalidCalls = [];
  storeState.resolutionCalls = [];
  dbState.hasDb = false;
  dbState.snapshot = null;
  dbState.setSnapshotCalls = [];
  mlState.responder = null;
  mlState.getItemImpl = null;
  tnState.getProductsImpl = null;
  conflictsService.__resetSnapshotCacheForTests();
});

test('ni ML ni TN conectados: mlConnected/tnConnected false, listas vacías', async () => {
  const result = await conflictsService.getAnalysis();
  assert.equal(result.mlConnected, false);
  assert.equal(result.tnConnected, false);
  assert.deepEqual(result.matched, []);
  assert.deepEqual(result.summary.totalML, 0);
});

test('ML conectado sin user_id: no intenta buscar, mlRows vacío', async () => {
  storeState.mlToken = 'tok';
  storeState.tokens.mercadolibre.user_id = null;
  let called = false;
  mlState.responder = () => { called = true; return makeRes({ json: {} }); };
  const result = await conflictsService.getAnalysis();
  assert.equal(result.mlConnected, true);
  assert.equal(called, false);
  assert.deepEqual(result.mlRows, undefined); // no se expone directo, solo vía summary
  assert.equal(result.summary.totalML, 0);
});

test('ML: trae ítems (uno con variantes, otro simple) vía search + multiget', async () => {
  storeState.mlToken = 'tok';
  storeState.tokens.mercadolibre.user_id = 999;
  mlState.responder = (url) => {
    if (url.includes('/items/search')) {
      return makeRes({ json: { results: ['MLA1', 'MLA2'], paging: { total: 2 } } });
    }
    if (url.includes('/items?ids=')) {
      return makeRes({
        json: [
          {
            code: 200,
            body: {
              id: 'MLA1',
              title: 'Cuaderno',
              catalog_listing: false,
              variations: [
                { id: 10, seller_sku: 'SKU-A', price: 100, available_quantity: 5 },
              ],
            },
          },
          {
            code: 200,
            body: { id: 'MLA2', title: 'Lapicera', catalog_listing: false, seller_sku: 'SKU-B', price: 50, available_quantity: 2 },
          },
        ],
      });
    }
    throw new Error('URL inesperada ' + url);
  };
  const result = await conflictsService.getAnalysis();
  assert.equal(result.summary.totalML, 2);
  assert.equal(result.onlyML.length, 2); // sin TN conectado, todo cae en onlyML
});

test('ML: paginación scan sigue el scroll_id hasta agotar resultados', async () => {
  storeState.mlToken = 'tok';
  storeState.tokens.mercadolibre.user_id = 999;
  const scrollsSeen = [];
  let call = 0;
  mlState.responder = (url) => {
    if (url.includes('/items/search')) {
      assert.ok(url.includes('search_type=scan'), 'debe usar search_type=scan');
      const u = new URL(url);
      scrollsSeen.push(u.searchParams.get('scroll_id'));
      call++;
      if (call === 1) return makeRes({ json: { results: Array.from({ length: 100 }, (_, i) => `MLA${i}`), paging: { total: 150 }, scroll_id: 'SCROLL-1' } });
      if (call === 2) return makeRes({ json: { results: Array.from({ length: 50 }, (_, i) => `MLB${i}`), scroll_id: 'SCROLL-1' } });
      return makeRes({ json: { results: [], scroll_id: 'SCROLL-1' } });
    }
    if (url.includes('/items?ids=')) return makeRes({ json: [] });
    throw new Error('URL inesperada ' + url);
  };
  await conflictsService.getAnalysis();
  assert.equal(scrollsSeen[0], null, 'la primera llamada no manda scroll_id');
  assert.equal(scrollsSeen[1], 'SCROLL-1', 'la segunda reenvía el scroll_id');
  assert.ok(call >= 3, 'sigue paginando hasta que results viene vacío');
});

test('ML: 401 en la búsqueda dispara refresh de token y reintenta', async () => {
  storeState.mlToken = 'old-tok';
  storeState.tokens.mercadolibre.user_id = 999;
  storeState.refreshedToken = 'new-tok';
  let usedTokens = [];
  mlState.responder = (url, opts) => {
    const auth = opts.headers.Authorization;
    usedTokens.push(auth);
    if (url.includes('/items/search')) {
      if (auth.includes('old-tok')) return makeRes({ status: 401, json: { message: 'invalid token' } });
      return makeRes({ json: { results: [], paging: { total: 0 } } });
    }
    return makeRes({ json: [] });
  };
  const result = await conflictsService.getAnalysis();
  assert.equal(result.mlAuthError, false);
  assert.ok(usedTokens.some((t) => t.includes('new-tok')));
});

test('ML: 401 persiste incluso tras refrescar → mlAuthError true y marca token inválido', async () => {
  storeState.mlToken = 'old-tok';
  storeState.tokens.mercadolibre.user_id = 999;
  storeState.refreshedToken = null; // no se pudo refrescar
  mlState.responder = (url) => {
    if (url.includes('/items/search')) return makeRes({ status: 401, json: { message: 'invalid token' } });
    return makeRes({ json: [] });
  };
  const result = await conflictsService.getAnalysis();
  assert.equal(result.mlAuthError, true);
  assert.deepEqual(storeState.setMlInvalidCalls, [true]);
});

test('TN: conectado trae productos con variantes e imágenes', async () => {
  storeState.tokens.tiendanube = { access_token: 'tn-tok', store_id: '55' };
  tnState.getProductsImpl = async () => [
    {
      id: 1,
      name: { es: 'Cuaderno' },
      images: [{ id: 1, src: 'http://img/1.jpg' }],
      variants: [{ id: 10, sku: 'SKU-A', price: '100', stock: 3, image_id: 1, values: [{ es: 'Grande' }] }],
    },
  ];
  const result = await conflictsService.getAnalysis();
  assert.equal(result.summary.totalTN, 1);
  assert.equal(result.onlyTN.length, 1);
  assert.equal(result.onlyTN[0].thumbnail, 'https://img/1.jpg', 'debe forzar https');
});

test('TN: error con status 401 marca token TN inválido y no lanza', async () => {
  storeState.tokens.tiendanube = { access_token: 'tn-tok', store_id: '55' };
  tnState.getProductsImpl = async () => { const e = new Error('unauthorized'); e.status = 401; throw e; };
  const result = await conflictsService.getAnalysis();
  assert.equal(result.summary.totalTN, 0);
  assert.deepEqual(storeState.setTnInvalidCalls, [true]);
});

test('ML y TN con el mismo SKU quedan matched; SKU duplicado en ML se agrupa aparte', async () => {
  storeState.mlToken = 'tok';
  storeState.tokens.mercadolibre.user_id = 999;
  storeState.tokens.tiendanube = { access_token: 'tn-tok', store_id: '55' };
  mlState.responder = (url) => {
    if (url.includes('/items/search')) return makeRes({ json: { results: ['MLA1', 'MLA2', 'MLA3'], paging: { total: 3 } } });
    if (url.includes('/items?ids=')) {
      return makeRes({
        json: [
          { code: 200, body: { id: 'MLA1', title: 'A', catalog_listing: false, seller_sku: 'SKU-MATCH', price: 10, available_quantity: 1 } },
          { code: 200, body: { id: 'MLA2', title: 'B', catalog_listing: false, seller_sku: 'DUP', price: 10, available_quantity: 1 } },
          { code: 200, body: { id: 'MLA3', title: 'C', catalog_listing: false, seller_sku: 'DUP', price: 10, available_quantity: 1 } },
        ],
      });
    }
    throw new Error('URL inesperada ' + url);
  };
  tnState.getProductsImpl = async () => [
    { id: 1, name: 'X', images: [], variants: [{ id: 10, sku: 'SKU-MATCH', price: 10, stock: 1 }] },
  ];
  const result = await conflictsService.getAnalysis();
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].sku, 'SKU-MATCH');
  assert.equal(result.duplicateSkuML.length, 1);
  assert.equal(result.duplicateSkuML[0].sku, 'DUP');
  assert.equal(result.mappings.length, 1);
  assert.deepEqual(storeState.resolutionCalls.length, 1);
});

test('ítems sin SKU van a noSkuML / noSkuTN', async () => {
  storeState.mlToken = 'tok';
  storeState.tokens.mercadolibre.user_id = 999;
  mlState.responder = (url) => {
    if (url.includes('/items/search')) return makeRes({ json: { results: ['MLA1'], paging: { total: 1 } } });
    if (url.includes('/items?ids=')) {
      return makeRes({ json: [{ code: 200, body: { id: 'MLA1', title: 'Sin sku', catalog_listing: false, price: 1, available_quantity: 1 } }] });
    }
    throw new Error('URL inesperada ' + url);
  };
  const result = await conflictsService.getAnalysis();
  assert.equal(result.noSkuML.length, 1);
});

test('getAnalysis con snapshot: computa desde las filas del snapshot sin llamar a ML/TN', async () => {
  dbState.hasDb = true;
  dbState.snapshot = {
    at: Date.now(),
    data: {
      mlRows: [{ type: 'ml', itemId: 'MLA1', variationId: null, title: 'X', sku: 'S1', hasSku: true, price: 1, stock: 1 }],
      tnRows: [],
      mlConnected: true,
      tnConnected: false,
    },
  };
  storeState.mlToken = 'tok';
  storeState.tokens.mercadolibre.user_id = 999;
  let called = false;
  mlState.responder = () => { called = true; return makeRes({ json: {} }); };
  const result = await conflictsService.getAnalysis();
  assert.equal(result.summary.totalML, 1);
  assert.equal(result.onlyML.length, 1);
  assert.equal(called, false, 'no debe pegarle a ML si hay snapshot');
});

test('getAnalysis sin snapshot pero con DB: corre el crawl y guarda el snapshot', async () => {
  dbState.hasDb = true;
  dbState.snapshot = null;
  const result = await conflictsService.getAnalysis();
  assert.equal(result.mlConnected, false);
  assert.equal(dbState.setSnapshotCalls.length, 1);
  assert.ok(Array.isArray(dbState.setSnapshotCalls[0].mlRows), 'el snapshot guarda filas crudas mlRows');
});

test('getAnalysis({ force }) ignora el snapshot y vuelve a crawlear', async () => {
  dbState.hasDb = true;
  dbState.snapshot = { at: Date.now(), data: { mlRows: [{ type: 'ml', itemId: 'OLD', variationId: null, title: 'viejo', sku: 'S', hasSku: true, price: 1, stock: 1 }], tnRows: [], mlConnected: true } };
  let searchCalled = false;
  storeState.mlToken = 'tok';
  storeState.tokens.mercadolibre.user_id = 999;
  mlState.responder = (url) => {
    if (url.includes('/items/search')) { searchCalled = true; return makeRes({ json: { results: [], paging: { total: 0 } } }); }
    return makeRes({ json: [] });
  };
  await conflictsService.getAnalysis({ force: true });
  assert.equal(searchCalled, true, 'con force debe re-crawlear aunque haya snapshot');
});

test('getAnalysis: llamadas concurrentes sin caché comparten la misma ejecución (dedup in-flight)', async () => {
  storeState.mlToken = 'tok';
  storeState.tokens.mercadolibre.user_id = 999;
  let searchCalls = 0;
  mlState.responder = async (url) => {
    if (url.includes('/items/search')) {
      searchCalls++;
      await new Promise((r) => setTimeout(r, 20));
      return makeRes({ json: { results: [], paging: { total: 0 } } });
    }
    return makeRes({ json: [] });
  };
  const [a, b] = await Promise.all([conflictsService.getAnalysis(), conflictsService.getAnalysis()]);
  assert.equal(searchCalls, 1, 'las dos llamadas concurrentes deben compartir el mismo crawl en curso');
  assert.deepEqual(a, b);
});

// ─── Parches puntuales del snapshot ──────────────────────────────────────────

function snapshotWithMlVariations() {
  return {
    at: Date.now(),
    data: {
      mlRows: [
        { type: 'ml', itemId: 'MLA1', variationId: '10', title: 'X', sku: 'A', hasSku: true, price: 100, stock: 5 },
        { type: 'ml', itemId: 'MLA1', variationId: '11', title: 'X', sku: 'B', hasSku: true, price: 100, stock: 3 },
      ],
      tnRows: [],
      mlConnected: true,
    },
  };
}

test('patchMlPrice: aplica el precio a TODAS las filas del ítem (variaciones legacy)', async () => {
  dbState.hasDb = true;
  dbState.snapshot = snapshotWithMlVariations();
  await conflictsService.patchMlPrice('MLA1', 250);
  const result = await conflictsService.getAnalysis();
  assert.deepEqual(result.onlyML.map((r) => r.price), [250, 250]);
});

test('patchMlStock: actualiza solo la variación indicada', async () => {
  dbState.hasDb = true;
  dbState.snapshot = snapshotWithMlVariations();
  await conflictsService.patchMlStock('MLA1', '10', 99);
  const result = await conflictsService.getAnalysis();
  const byVar = Object.fromEntries(result.onlyML.map((r) => [r.variationId, r.stock]));
  assert.equal(byVar['10'], 99);
  assert.equal(byVar['11'], 3, 'la otra variación no cambia');
});

test('patchMlStock: devuelve el stock previo y el SKU, para que el historial cuente el cambio', async () => {
  dbState.hasDb = true;
  dbState.snapshot = snapshotWithMlVariations();
  const before = await conflictsService.patchMlStock('MLA1', '10', 99);
  assert.deepEqual(before, { stockBefore: 5, sku: 'A' });
});

test('patchMlStock: devuelve el previo aunque el stock no cambie (mismo valor)', async () => {
  dbState.hasDb = true;
  dbState.snapshot = snapshotWithMlVariations();
  const before = await conflictsService.patchMlStock('MLA1', '10', 5);
  assert.deepEqual(before, { stockBefore: 5, sku: 'A' });
});

test('patchMlStock: fila inexistente en el snapshot → null (no inventa un stock previo)', async () => {
  dbState.hasDb = true;
  dbState.snapshot = snapshotWithMlVariations();
  const before = await conflictsService.patchMlStock('MLA-INEXISTENTE', null, 7);
  assert.equal(before, null);
});

test('patchMlSku: cambiar el SKU re-clasifica en la próxima lectura (matchea con TN)', async () => {
  dbState.hasDb = true;
  dbState.snapshot = {
    at: Date.now(),
    data: {
      mlRows: [{ type: 'ml', itemId: 'MLA1', variationId: null, title: 'X', sku: 'VIEJO', hasSku: true, price: 1, stock: 1 }],
      tnRows: [{ type: 'tn', productId: 5, variantId: 50, productName: 'X', sku: 'NUEVO', hasSku: true, price: 1, stock: 1 }],
      mlConnected: true, tnConnected: true,
    },
  };
  let r = await conflictsService.getAnalysis();
  assert.equal(r.matched.length, 0, 'antes del patch no matchean');
  await conflictsService.patchMlSku('MLA1', null, 'NUEVO');
  r = await conflictsService.getAnalysis();
  assert.equal(r.matched.length, 1, 'tras igualar el SKU quedan matched');
});

test('patchTnSku no se pierde si un crawl de reconcile termina después del parche', async () => {
  // Reproduce el bug: el snapshot está viejo (> SNAPSHOT_STALE_MS), así que getAnalysis()
  // dispara un reconcile en background. fetchRawRows() tarda (sin lock) y devuelve el estado
  // DE ANTES de la edición del usuario. Si el parche no espera ese crawl, el crawl termina
  // después y pisa el SKU recién editado con el valor viejo.
  dbState.hasDb = true;
  const staleAt = Date.now() - 7 * 60 * 60 * 1000; // > 6h
  dbState.snapshot = {
    at: staleAt,
    data: {
      mlRows: [{ type: 'ml', itemId: 'MLA1', variationId: null, title: 'X', sku: 'NUEVO', hasSku: true, price: 1, stock: 1 }],
      tnRows: [{ type: 'tn', productId: 5, variantId: 50, productName: 'X', sku: 'VIEJO', hasSku: true, price: 1, stock: 1 }],
      mlConnected: true, tnConnected: true,
    },
  };
  storeState.mlToken = 'tok';
  storeState.tokens.mercadolibre.user_id = 999;
  mlState.responder = async (url) => {
    if (url.includes('/items/search')) {
      await new Promise((r) => setTimeout(r, 30));
      return makeRes({ json: { results: ['MLA1'], paging: { total: 1 } } });
    }
    if (url.includes('/items?ids=')) {
      return makeRes({
        json: [{ code: 200, body: { id: 'MLA1', title: 'X', catalog_listing: false, seller_sku: 'NUEVO', price: 1, available_quantity: 1 } }],
      });
    }
    return makeRes({ json: [] });
  };
  tnState.getProductsImpl = async () => {
    await new Promise((r) => setTimeout(r, 30));
    // El crawl "ve" el catálogo de TN de antes de la edición del usuario.
    return [{ id: 5, name: { es: 'X' }, variants: [{ id: 50, sku: 'VIEJO', stock: 1, price: '1' }], images: [] }];
  };
  storeState.tokens.tiendanube = { access_token: 'tok', store_id: 1 };

  // getAnalysis() sirve del snapshot viejo y dispara el reconcile en background (no lo espera).
  await conflictsService.getAnalysis();
  // El usuario edita el SKU de TN mientras el crawl de arriba sigue en vuelo.
  await conflictsService.patchTnSku(5, 50, 'NUEVO');
  // Deja tiempo de sobra a que el crawl en background (delay de 30ms simulado arriba) termine
  // de escribir, para comprobar el estado FINAL (no si el parche ganó una carrera de timing).
  await new Promise((r) => setTimeout(r, 100));

  const result = await conflictsService.getAnalysis();
  assert.equal(result.matched.length, 1, 'el parche debe ganarle al crawl que empezó antes');
  assert.equal(result.matched[0].tn.sku, 'NUEVO');
});

test('invalidateSnapshot: descarta el snapshot (memoria + DB)', async () => {
  dbState.hasDb = true;
  dbState.snapshot = snapshotWithMlVariations();
  await conflictsService.invalidateSnapshot();
  assert.equal(dbState.snapshot, null);
});

test('refreshMlItemInSnapshot: reemplaza las filas del ítem con lo que trae getItem', async () => {
  dbState.hasDb = true;
  dbState.snapshot = snapshotWithMlVariations();
  mlState.getItemImpl = (id) => (id === 'MLA1'
    ? { id: 'MLA1', title: 'X', catalog_listing: false, seller_sku: 'SOLO', price: 999, available_quantity: 7 }
    : null);
  await conflictsService.refreshMlItemInSnapshot('tok', 'MLA1');
  const result = await conflictsService.getAnalysis();
  // Las 2 variaciones viejas se reemplazan por 1 fila simple con el nuevo precio/stock.
  assert.equal(result.onlyML.length, 1);
  assert.equal(result.onlyML[0].price, 999);
  assert.equal(result.onlyML[0].stock, 7);
});
