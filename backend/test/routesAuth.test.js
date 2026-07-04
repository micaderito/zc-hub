/**
 * Tests de routes/auth.js: conexión/desconexión OAuth de ML y TN, callbacks y /status.
 * Mismo patrón Express + fetch nativo que el resto de los tests de rutas.
 */
import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const storeState = {
  tokens: { mercadolibre: {}, tiendanube: {} },
  clearMlCalls: 0,
  clearTnCalls: 0,
  persistCalls: 0,
  persistAsyncCalls: 0,
  mlToken: null,
  tnKnownInvalid: false,
  setMlInvalidCalls: [],
  setTnInvalidCalls: [],
};

const mlState = { authUrlError: null, exchangeResult: null, exchangeError: null };
const tnState = { authUrlError: null, exchangeResult: null, exchangeError: null, registerWebhooksResult: [], registerWebhooksError: null };

let app, server, baseUrl;

before(async () => {
  mock.module('../src/store.js', {
    exports: {
      tokens: storeState.tokens,
      persistTokens: () => { storeState.persistCalls++; },
      persistTokensAsync: async () => { storeState.persistAsyncCalls++; },
      clearMlTokens: () => { storeState.clearMlCalls++; },
      clearTnTokens: () => { storeState.clearTnCalls++; },
      getMlToken: async () => storeState.mlToken,
      isTnTokenKnownInvalid: () => storeState.tnKnownInvalid,
      setMlTokenKnownInvalid: (v) => storeState.setMlInvalidCalls.push(v),
      setTnTokenKnownInvalid: (v) => storeState.setTnInvalidCalls.push(v),
    },
  });
  mock.module('../src/lib/mercadolibre.js', {
    exports: {
      getAuthUrl: async () => { if (mlState.authUrlError) throw mlState.authUrlError; return 'https://ml.example/auth'; },
      exchangeCodeForToken: async () => { if (mlState.exchangeError) throw mlState.exchangeError; return mlState.exchangeResult; },
    },
  });
  mock.module('../src/lib/tiendanube.js', {
    exports: {
      getAuthUrl: async () => { if (tnState.authUrlError) throw tnState.authUrlError; return 'https://tn.example/auth'; },
      exchangeCodeForToken: async () => { if (tnState.exchangeError) throw tnState.exchangeError; return tnState.exchangeResult; },
      registerOrderWebhooks: async () => { if (tnState.registerWebhooksError) throw tnState.registerWebhooksError; return tnState.registerWebhooksResult; },
    },
  });

  const { authRoutes } = await import('../src/routes/auth.js');
  app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/auth`;
});

after(() => { server.close(); });

beforeEach(() => {
  storeState.tokens.mercadolibre = {};
  storeState.tokens.tiendanube = {};
  storeState.clearMlCalls = 0;
  storeState.clearTnCalls = 0;
  storeState.persistCalls = 0;
  storeState.persistAsyncCalls = 0;
  storeState.mlToken = null;
  storeState.tnKnownInvalid = false;
  storeState.setMlInvalidCalls = [];
  storeState.setTnInvalidCalls = [];
  mlState.authUrlError = null;
  mlState.exchangeResult = null;
  mlState.exchangeError = null;
  tnState.authUrlError = null;
  tnState.exchangeResult = null;
  tnState.exchangeError = null;
  tnState.registerWebhooksResult = [];
  tnState.registerWebhooksError = null;
  delete process.env.WEBHOOK_BASE_URL;
});

test('POST /mercadolibre/disconnect: borra tokens ML', async () => {
  const res = await fetch(`${baseUrl}/mercadolibre/disconnect`, { method: 'POST' });
  const body = await res.json();
  assert.deepEqual(body, { ok: true });
  assert.equal(storeState.clearMlCalls, 1);
});

test('GET /mercadolibre/url: devuelve la url de autorización', async () => {
  const res = await fetch(`${baseUrl}/mercadolibre/url`);
  const body = await res.json();
  assert.equal(body.url, 'https://ml.example/auth');
});

test('GET /mercadolibre/url: si falla, 500', async () => {
  mlState.authUrlError = new Error('boom');
  const res = await fetch(`${baseUrl}/mercadolibre/url`);
  assert.equal(res.status, 500);
});

test('GET /mercadolibre/callback: sin code redirige al frontend', async () => {
  const res = await fetch(`${baseUrl}/mercadolibre/callback`, { redirect: 'manual' });
  assert.equal(res.status, 302);
});

test('GET /mercadolibre/callback: con code exitoso, guarda tokens y redirige con ml_connected=1', async () => {
  mlState.exchangeResult = { access_token: 'a', refresh_token: 'r', user_id: 1, expires_in: 3600 };
  const res = await fetch(`${baseUrl}/mercadolibre/callback?code=abc`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /ml_connected=1/);
  assert.equal(storeState.tokens.mercadolibre.access_token, 'a');
  assert.equal(storeState.persistAsyncCalls, 1);
});

test('GET /mercadolibre/callback: exchangeCodeForToken falla, redirige con ml_error', async () => {
  mlState.exchangeError = new Error('token inválido');
  const res = await fetch(`${baseUrl}/mercadolibre/callback?code=abc`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /ml_error=/);
});

test('POST /tiendanube/disconnect: borra tokens TN', async () => {
  const res = await fetch(`${baseUrl}/tiendanube/disconnect`, { method: 'POST' });
  const body = await res.json();
  assert.deepEqual(body, { ok: true });
  assert.equal(storeState.clearTnCalls, 1);
});

test('GET /tiendanube/url: devuelve la url de autorización', async () => {
  const res = await fetch(`${baseUrl}/tiendanube/url`);
  const body = await res.json();
  assert.equal(body.url, 'https://tn.example/auth');
});

test('GET /tiendanube/url: si falla, 500', async () => {
  tnState.authUrlError = new Error('boom');
  const res = await fetch(`${baseUrl}/tiendanube/url`);
  assert.equal(res.status, 500);
});

test('GET /tiendanube/callback: sin code redirige con tn_error', async () => {
  const res = await fetch(`${baseUrl}/tiendanube/callback`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /tn_error=/);
});

test('GET /tiendanube/callback: con code exitoso guarda tokens y redirige con tn_connected=1', async () => {
  tnState.exchangeResult = { access_token: 'a', user_id: '5' };
  const res = await fetch(`${baseUrl}/tiendanube/callback?code=abc`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /tn_connected=1/);
  assert.equal(storeState.tokens.tiendanube.access_token, 'a');
});

test('GET /tiendanube/callback: con WEBHOOK_BASE_URL registra webhooks', async () => {
  process.env.WEBHOOK_BASE_URL = 'https://example.com';
  tnState.exchangeResult = { access_token: 'a', user_id: '5' };
  tnState.registerWebhooksResult = [{ event: 'order/paid', id: 1 }];
  const res = await fetch(`${baseUrl}/tiendanube/callback?code=abc`, { redirect: 'manual' });
  assert.equal(res.status, 302);
});

test('GET /tiendanube/callback: falla exchangeCodeForToken, redirige con tn_error', async () => {
  tnState.exchangeError = new Error('token TN inválido');
  const res = await fetch(`${baseUrl}/tiendanube/callback?code=abc`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /tn_error=/);
});

test('GET /status: sin tokens guardados, todo desconectado', async () => {
  const res = await fetch(`${baseUrl}/status`);
  const body = await res.json();
  assert.deepEqual(body, {
    mercadolibre: false, mercadolibreExpired: false,
    tiendanube: false, tiendanubeExpired: false,
  });
});

test('GET /status: ML con token vigente, TN conectado', async () => {
  storeState.tokens.mercadolibre = { access_token: 'x', refresh_token: 'y' };
  storeState.tokens.tiendanube = { access_token: 'z' };
  storeState.mlToken = 'x';
  const res = await fetch(`${baseUrl}/status`);
  const body = await res.json();
  assert.equal(body.mercadolibre, true);
  assert.equal(body.tiendanube, true);
});

test('GET /status: ML con refresh_token guardado pero getMlToken null → expirado', async () => {
  storeState.tokens.mercadolibre = { access_token: null, refresh_token: 'y' };
  storeState.mlToken = null;
  const res = await fetch(`${baseUrl}/status`);
  const body = await res.json();
  assert.equal(body.mercadolibre, false);
  assert.equal(body.mercadolibreExpired, true);
});

test('GET /status: TN guardado pero marcado inválido → expirado', async () => {
  storeState.tokens.tiendanube = { access_token: 'z' };
  storeState.tnKnownInvalid = true;
  const res = await fetch(`${baseUrl}/status`);
  const body = await res.json();
  assert.equal(body.tiendanube, false);
  assert.equal(body.tiendanubeExpired, true);
});
