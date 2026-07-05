/**
 * Tests del ciclo de vida de tokens OAuth en store.js: carga desde archivo/DB, persistencia,
 * refresh de ML (con dedup de refreshes concurrentes) y desconexión.
 *
 * store.test.js cubre la resolución SKU↔canal en memoria (no necesita mocks). Este archivo cubre
 * la otra mitad de store.js: todo lo que toca `fs` (data/tokens.json), `./db.js` (oauth_tokens en
 * Postgres) y `./lib/mercadolibre.js` (refresh/getMe) — se mockean los tres para no tocar disco
 * real ni pegarle a la API de ML.
 */
import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';

const fsState = { files: new Map(), throwOnWrite: false, throwOnRead: false };
const dbState = { hasDb: false, oauthTokens: null, setOAuthCalls: [] };
const mlState = { refreshResult: null, refreshError: null, getMeResult: null };

const TOKENS_FILE = path.join(process.cwd(), 'data', 'tokens.json');

const fakeFs = {
  existsSync: (p) => fsState.files.has(p),
  readFileSync: (p) => {
    if (fsState.throwOnRead) throw new Error('read error');
    if (!fsState.files.has(p)) throw new Error('ENOENT');
    return fsState.files.get(p);
  },
  writeFileSync: (p, data) => {
    if (fsState.throwOnWrite) throw new Error('write error');
    fsState.files.set(p, data);
  },
  mkdirSync: () => {},
};

let store;

before(async () => {
  mock.module('fs', { exports: { default: fakeFs, ...fakeFs } });
  mock.module('../src/db.js', {
    exports: {
      hasDatabase: () => dbState.hasDb,
      getOAuthTokens: async () => dbState.oauthTokens,
      setOAuthTokens: async (payload) => { dbState.setOAuthCalls.push(payload); return true; },
    },
  });
  mock.module('../src/lib/mercadolibre.js', {
    exports: {
      refreshAccessToken: async () => {
        if (mlState.refreshError) throw mlState.refreshError;
        return mlState.refreshResult;
      },
      getMe: async () => mlState.getMeResult,
    },
  });
  store = await import('../src/store.js');
});

beforeEach(() => {
  fsState.files = new Map();
  fsState.throwOnWrite = false;
  fsState.throwOnRead = false;
  dbState.hasDb = false;
  dbState.oauthTokens = null;
  dbState.setOAuthCalls = [];
  mlState.refreshResult = null;
  mlState.refreshError = null;
  mlState.getMeResult = null;
  Object.assign(store.tokens.mercadolibre, { access_token: null, refresh_token: null, user_id: null, expires_at: null });
  Object.assign(store.tokens.tiendanube, { access_token: null, store_id: null });
  store.setMlTokenKnownInvalid(false);
  store.setTnTokenKnownInvalid(false);
});

// ─── loadTokensFromFile / loadTokens ────────────────────────────────────────

test('loadTokensFromFile: sin archivo no hace nada (no lanza)', () => {
  store.loadTokensFromFile();
  assert.equal(store.tokens.mercadolibre.access_token, null);
});

test('loadTokensFromFile: carga tokens válidos desde el archivo', () => {
  fsState.files.set(TOKENS_FILE, JSON.stringify({
    mercadolibre: { access_token: 'ml-tok', refresh_token: 'r', user_id: 1, expires_at: 123 },
    tiendanube: { access_token: 'tn-tok', store_id: '5' },
    mlTokenKnownInvalid: true,
  }));
  store.loadTokensFromFile();
  assert.equal(store.tokens.mercadolibre.access_token, 'ml-tok');
  assert.equal(store.tokens.tiendanube.access_token, 'tn-tok');
  assert.equal(store.isMlTokenKnownInvalid(), true);
});

test('loadTokensFromFile: JSON corrupto no lanza (catch + warn)', () => {
  fsState.files.set(TOKENS_FILE, '{not json');
  store.loadTokensFromFile();
  assert.equal(store.tokens.mercadolibre.access_token, null);
});

test('loadTokens: con DB y datos válidos, los usa (no lee archivo)', async () => {
  dbState.hasDb = true;
  dbState.oauthTokens = { mercadolibre: { access_token: 'from-db' }, tiendanube: {} };
  await store.loadTokens();
  assert.equal(store.tokens.mercadolibre.access_token, 'from-db');
});

test('loadTokens: con DB pero sin datos útiles, cae a archivo', async () => {
  dbState.hasDb = true;
  dbState.oauthTokens = null;
  fsState.files.set(TOKENS_FILE, JSON.stringify({ mercadolibre: { access_token: 'from-file' } }));
  await store.loadTokens();
  assert.equal(store.tokens.mercadolibre.access_token, 'from-file');
});

test('loadTokens: sin DB, carga directo del archivo', async () => {
  dbState.hasDb = false;
  fsState.files.set(TOKENS_FILE, JSON.stringify({ tiendanube: { access_token: 'tn-only' } }));
  await store.loadTokens();
  assert.equal(store.tokens.tiendanube.access_token, 'tn-only');
});

// ─── persistTokens / persistTokensAsync ─────────────────────────────────────

test('persistTokens: escribe el archivo y, sin DB, no llama a setOAuthTokens', () => {
  dbState.hasDb = false;
  store.persistTokens();
  assert.ok(fsState.files.has(TOKENS_FILE));
  assert.equal(dbState.setOAuthCalls.length, 0);
});

test('persistTokens: con DB, dispara setOAuthTokens (fire and forget)', async () => {
  dbState.hasDb = true;
  store.persistTokens();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(dbState.setOAuthCalls.length, 1);
});

test('persistTokens: si falla la escritura a disco, no lanza (catch + error log)', () => {
  fsState.throwOnWrite = true;
  store.persistTokens();
});

test('persistTokensAsync: escribe archivo y espera la DB', async () => {
  dbState.hasDb = true;
  await store.persistTokensAsync();
  assert.equal(dbState.setOAuthCalls.length, 1);
  assert.ok(fsState.files.has(TOKENS_FILE));
});


// ─── getMlToken / tryRefreshMlToken ─────────────────────────────────────────

test('getMlToken: sin access_token devuelve null', async () => {
  const token = await store.getMlToken();
  assert.equal(token, null);
});

test('getMlToken: access_token vigente (no necesita refresh) y con user_id, lo devuelve directo', async () => {
  Object.assign(store.tokens.mercadolibre, { access_token: 'valid', refresh_token: 'r', user_id: 1, expires_at: Date.now() + 5 * 60 * 60 * 1000 });
  const token = await store.getMlToken();
  assert.equal(token, 'valid');
});

test('getMlToken: sin user_id, lo completa vía getMe y persiste', async () => {
  Object.assign(store.tokens.mercadolibre, { access_token: 'valid', refresh_token: 'r', user_id: null, expires_at: Date.now() + 5 * 60 * 60 * 1000 });
  mlState.getMeResult = { id: 555 };
  const token = await store.getMlToken();
  assert.equal(token, 'valid');
  assert.equal(store.tokens.mercadolibre.user_id, 555);
});

test('getMlToken: getMe devuelve null → no setea user_id pero tampoco lanza', async () => {
  Object.assign(store.tokens.mercadolibre, { access_token: 'valid', refresh_token: 'r', user_id: null, expires_at: Date.now() + 5 * 60 * 60 * 1000 });
  mlState.getMeResult = null;
  const token = await store.getMlToken();
  assert.equal(token, 'valid');
  assert.equal(store.tokens.mercadolibre.user_id, null);
});

test('getMlToken: expirado y con refresh_token, refresca y devuelve el nuevo access_token', async () => {
  Object.assign(store.tokens.mercadolibre, { access_token: 'old', refresh_token: 'r1', user_id: 1, expires_at: Date.now() - 1000 });
  mlState.refreshResult = { access_token: 'new', refresh_token: 'r2', expires_in: 3600 };
  const token = await store.getMlToken();
  assert.equal(token, 'new');
  assert.equal(store.tokens.mercadolibre.refresh_token, 'r2');
});

test('getMlToken: expirado sin refresh_token → refresh no se intenta, sigue con el token actual', async () => {
  Object.assign(store.tokens.mercadolibre, { access_token: 'old', refresh_token: null, user_id: 1, expires_at: Date.now() - 1000 });
  const token = await store.getMlToken();
  assert.equal(token, 'old');
});

test('getMlToken: refresh falla → tryRefreshMlToken devuelve null → getMlToken devuelve null', async () => {
  Object.assign(store.tokens.mercadolibre, { access_token: 'old', refresh_token: 'r1', user_id: 1, expires_at: Date.now() - 1000 });
  mlState.refreshError = new Error('invalid_grant');
  const token = await store.getMlToken();
  assert.equal(token, null);
  assert.equal(store.isMlTokenKnownInvalid(), true);
});

test('tryRefreshMlToken: sin refresh_token devuelve null', async () => {
  Object.assign(store.tokens.mercadolibre, { refresh_token: null });
  const token = await store.tryRefreshMlToken();
  assert.equal(token, null);
});

test('tryRefreshMlToken: refreshes concurrentes comparten la misma promesa (dedup)', async () => {
  Object.assign(store.tokens.mercadolibre, { access_token: 'old', refresh_token: 'r1', expires_at: Date.now() - 1000 });
  mlState.refreshResult = { access_token: 'new-concurrent', expires_in: 3600 };
  const p1 = store.tryRefreshMlToken();
  const p2 = store.tryRefreshMlToken();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, 'new-concurrent');
  assert.equal(r2, 'new-concurrent');
});

// ─── clearMlTokens / clearTnTokens ──────────────────────────────────────────

test('clearMlTokens: borra tokens ML y resetea mlTokenKnownInvalid', () => {
  Object.assign(store.tokens.mercadolibre, { access_token: 'x', refresh_token: 'y', user_id: 1, expires_at: 1 });
  store.setMlTokenKnownInvalid(true);
  store.clearMlTokens();
  assert.equal(store.tokens.mercadolibre.access_token, null);
  assert.equal(store.isMlTokenKnownInvalid(), false);
});

test('clearTnTokens: borra tokens TN y resetea tnTokenKnownInvalid', () => {
  Object.assign(store.tokens.tiendanube, { access_token: 'x', store_id: '5' });
  store.setTnTokenKnownInvalid(true);
  store.clearTnTokens();
  assert.equal(store.tokens.tiendanube.access_token, null);
  assert.equal(store.isTnTokenKnownInvalid(), false);
});

// ─── setMlTokenKnownInvalid / setTnTokenKnownInvalid getters ────────────────

test('setMlTokenKnownInvalid / isMlTokenKnownInvalid reflejan el estado seteado', () => {
  store.setMlTokenKnownInvalid(true);
  assert.equal(store.isMlTokenKnownInvalid(), true);
  store.setMlTokenKnownInvalid(false);
  assert.equal(store.isMlTokenKnownInvalid(), false);
});

test('setTnTokenKnownInvalid / isTnTokenKnownInvalid reflejan el estado seteado', () => {
  store.setTnTokenKnownInvalid(true);
  assert.equal(store.isTnTokenKnownInvalid(), true);
});
