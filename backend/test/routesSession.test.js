/**
 * Tests de routes/session.js: login (credenciales OK/malas/usuario inactivo, mismo mensaje para
 * los tres, freno de fuerza bruta), /me (renovación deslizante), /logout, /password.
 * requireAuth.js se mockea como passthrough con req.user fijo — ya está cubierto aparte en
 * requireAuth.test.js — así este archivo prueba solo la lógica de session.js.
 */
import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { hashPassword } from '../src/lib/authTokens.js';

process.env.AUTH_JWT_SECRET = 'test-secret-routesSession';

const PASSWORD = 'correcta123';
const dbState = {
  usersByUsername: {},
  usersById: {},
  lastLoginCalls: [],
  bumpCalls: [],
  updateCalls: [],
};
let invalidateCalls;
let currentUser; // usuario que "está logueado" para las rutas protegidas del test

function baseUser(overrides = {}) {
  return {
    id: 1, username: 'mica', displayName: 'Mica', activo: true, tokenVersion: 1,
    passwordHash: hashPassword(PASSWORD),
    ...overrides,
  };
}

let app, server, baseUrl;

before(async () => {
  mock.module('../src/db.js', {
    exports: {
      getAppUserByUsername: async (username) => {
        const u = dbState.usersByUsername[String(username).toLowerCase()];
        return u ? { ...u } : null;
      },
      getAppUserById: async (id) => {
        const u = dbState.usersById[id];
        return u ? { id: u.id, username: u.username, displayName: u.displayName, activo: u.activo, tokenVersion: u.tokenVersion } : null;
      },
      touchAppUserLastLogin: async (id) => { dbState.lastLoginCalls.push(id); },
      bumpAppUserTokenVersion: async (id) => {
        dbState.bumpCalls.push(id);
        const u = dbState.usersById[id];
        if (u) u.tokenVersion += 1;
        return u?.tokenVersion ?? null;
      },
      updateAppUser: async (id, data) => {
        dbState.updateCalls.push({ id, ...data });
        const u = dbState.usersById[id];
        if (u && data.passwordHash) u.passwordHash = data.passwordHash;
        return u ?? null;
      },
    },
  });
  mock.module('../src/middleware/requireAuth.js', {
    exports: {
      requireAuth: (req, res, next) => {
        if (!currentUser) return res.status(401).json({ error: 'No autenticado' });
        req.user = { id: currentUser.id, username: currentUser.username };
        req.authPayload = { expiresAt: currentUser.expiresAt ?? Date.now() + 20 * 24 * 60 * 60 * 1000 };
        next();
      },
      invalidateAuthUserCache: (id) => { invalidateCalls.push(id); },
    },
  });

  const { sessionRoutes } = await import('../src/routes/session.js');
  app = express();
  app.use(express.json());
  app.use('/api/session', sessionRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/session`;
});

after(() => { server.close(); });

beforeEach(() => {
  const user = baseUser();
  dbState.usersByUsername = { mica: user };
  dbState.usersById = { 1: user };
  dbState.lastLoginCalls = [];
  dbState.bumpCalls = [];
  dbState.updateCalls = [];
  invalidateCalls = [];
  currentUser = { id: 1, username: 'mica' };
});

test('login con credenciales correctas devuelve token y datos públicos del usuario', async () => {
  const res = await fetch(`${baseUrl}/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'mica', password: PASSWORD }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(body.token);
  assert.equal(body.user.username, 'mica');
  assert.equal(body.user.passwordHash, undefined);
  assert.deepEqual(dbState.lastLoginCalls, [1]);
});

test('login con usuario inexistente da el mismo mensaje que contraseña incorrecta', async () => {
  const resNoUser = await fetch(`${baseUrl}/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'no-existe', password: 'algo12345' }),
  });
  const resBadPw = await fetch(`${baseUrl}/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'mica', password: 'incorrecta' }),
  });
  const bodyNoUser = await resNoUser.json();
  const bodyBadPw = await resBadPw.json();
  assert.equal(resNoUser.status, 401);
  assert.equal(resBadPw.status, 401);
  assert.equal(bodyNoUser.error, bodyBadPw.error);
});

test('login con usuario desactivado da el mismo mensaje genérico (no dice "está desactivado")', async () => {
  dbState.usersByUsername.mica.activo = false;
  const res = await fetch(`${baseUrl}/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'mica', password: PASSWORD }),
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error, 'Usuario o contraseña incorrectos');
});

test('freno de fuerza bruta: 5 intentos fallidos bloquean el 6to con 429', async () => {
  const attempt = () => fetch(`${baseUrl}/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'freno-test-user', password: 'mala' }),
  });
  let last;
  for (let i = 0; i < 5; i++) last = await attempt();
  assert.equal(last.status, 401);
  const blocked = await attempt();
  assert.equal(blocked.status, 429);
});

test('GET /me sin sesión → 401 (requireAuth mockeado deniega)', async () => {
  currentUser = null;
  const res = await fetch(`${baseUrl}/me`);
  assert.equal(res.status, 401);
});

test('GET /me con token que le queda mucho tiempo no reemite token', async () => {
  const res = await fetch(`${baseUrl}/me`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.user.username, 'mica');
  assert.equal(body.token, undefined);
});

test('GET /me con token por vencer (renovación deslizante) reemite un token nuevo', async () => {
  currentUser = { id: 1, username: 'mica', expiresAt: Date.now() + 2 * 24 * 60 * 60 * 1000 };
  const res = await fetch(`${baseUrl}/me`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(body.token);
});

test('POST /logout devuelve ok sin tocar nada del lado servidor', async () => {
  const res = await fetch(`${baseUrl}/logout`, { method: 'POST' });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(dbState.bumpCalls, []);
});

test('POST /password con la contraseña actual mal → 400, no toca nada', async () => {
  const res = await fetch(`${baseUrl}/password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actual: 'no-es-esta', nueva: 'nuevaClave123' }),
  });
  assert.equal(res.status, 400);
  assert.deepEqual(dbState.bumpCalls, []);
});

test('POST /password OK: sube token_version, invalida caché y devuelve un token nuevo', async () => {
  const res = await fetch(`${baseUrl}/password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actual: PASSWORD, nueva: 'nuevaClave123' }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(body.token);
  assert.deepEqual(dbState.bumpCalls, [1]);
  assert.deepEqual(invalidateCalls, [1]);
});
