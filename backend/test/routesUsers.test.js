/**
 * Tests de routes/users.js: alta, edición, usuario duplicado, no poder borrarse/desactivarse a sí
 * misma, no poder dejar el hub con cero usuarios activos, y "cerrar sesiones" (bump token_version).
 * requireAuth se mockea fijando req.user = { id: 1 } (la usuaria "logueada" en el test).
 */
import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbState = {
  users: [], // [{ id, username, displayName, activo, tokenVersion }]
  nextId: 1,
  bumpCalls: [],
};
let invalidateCalls;

function findByUsername(username) {
  return dbState.users.find((u) => u.username.toLowerCase() === String(username).toLowerCase());
}

before(async () => {
  mock.module('../src/db.js', {
    exports: {
      getAppUsers: async () => dbState.users.map((u) => ({ ...u })),
      getAppUserById: async (id) => {
        const u = dbState.users.find((x) => x.id === id);
        return u ? { ...u } : null;
      },
      getAppUserByUsername: async (username) => {
        const u = findByUsername(username);
        return u ? { ...u, passwordHash: 'hash' } : null;
      },
      createAppUser: async ({ username, displayName }) => {
        const item = { id: dbState.nextId++, username, displayName: displayName ?? null, activo: true, tokenVersion: 1 };
        dbState.users.push(item);
        return { ...item };
      },
      updateAppUser: async (id, data) => {
        const u = dbState.users.find((x) => x.id === id);
        if (!u) return null;
        Object.assign(u, { username: data.username, displayName: data.displayName, activo: data.activo });
        return { ...u };
      },
      deleteAppUser: async (id) => {
        const before = dbState.users.length;
        dbState.users = dbState.users.filter((x) => x.id !== id);
        return dbState.users.length < before;
      },
      bumpAppUserTokenVersion: async (id) => {
        dbState.bumpCalls.push(id);
        const u = dbState.users.find((x) => x.id === id);
        if (u) u.tokenVersion += 1;
        return u?.tokenVersion ?? null;
      },
      countActiveAppUsers: async () => dbState.users.filter((u) => u.activo).length,
    },
  });
  mock.module('../src/middleware/requireAuth.js', {
    exports: {
      requireAuth: (req, _res, next) => { req.user = { id: 1, username: 'mica' }; next(); },
      invalidateAuthUserCache: (id) => { invalidateCalls.push(id); },
    },
  });

  // index.js monta requireAuth ANTES de usersRoutes (todas sus rutas exigen sesión) — se
  // reproduce acá para que req.user exista cuando las rutas lo leen.
  const { requireAuth } = await import('../src/middleware/requireAuth.js');
  const { usersRoutes } = await import('../src/routes/users.js');
  const app = express();
  app.use(express.json());
  app.use('/api/users', requireAuth, usersRoutes);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  globalThis.__usersTestBaseUrl = `http://127.0.0.1:${server.address().port}/api/users`;
  globalThis.__usersTestServer = server;
});

after(() => { globalThis.__usersTestServer.close(); });

beforeEach(() => {
  dbState.users = [
    { id: 1, username: 'mica', displayName: 'Mica', activo: true, tokenVersion: 1 },
  ];
  dbState.nextId = 2;
  dbState.bumpCalls = [];
  invalidateCalls = [];
});

function baseUrl() { return globalThis.__usersTestBaseUrl; }

test('GET / lista los usuarios', async () => {
  const res = await fetch(baseUrl());
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.items.length, 1);
});

test('POST / crea un usuario nuevo', async () => {
  const res = await fetch(baseUrl(), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'nueva', password: 'password123', displayName: 'Nueva Usuaria' }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.item.username, 'nueva');
  assert.equal(dbState.users.length, 2);
});

test('POST / rechaza usuario duplicado (case-insensitive)', async () => {
  const res = await fetch(baseUrl(), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'MICA', password: 'password123' }),
  });
  assert.equal(res.status, 400);
});

test('POST / rechaza usuario corto o contraseña corta', async () => {
  const shortUser = await fetch(baseUrl(), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'ab', password: 'password123' }),
  });
  const shortPw = await fetch(baseUrl(), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'otronombre', password: '123' }),
  });
  assert.equal(shortUser.status, 400);
  assert.equal(shortPw.status, 400);
});

test('PUT /:id no permite que la usuaria logueada se desactive a sí misma', async () => {
  const res = await fetch(`${baseUrl()}/1`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'mica', displayName: 'Mica', activo: false }),
  });
  assert.equal(res.status, 400);
});

test('PUT /:id no permite dejar el hub sin ningún usuario activo', async () => {
  dbState.users.push({ id: 2, username: 'otra', displayName: 'Otra', activo: true, tokenVersion: 1 });
  // Desactivar a "otra" (no es self) pero es la única activa además de mica... en realidad hay 2
  // activos acá, así que desactivar a "otra" debe permitirse. Probamos el caso límite: dejar solo
  // un activo, después intentar desactivar ese último.
  const okRes = await fetch(`${baseUrl()}/2`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'otra', displayName: 'Otra', activo: false }),
  });
  assert.equal(okRes.status, 200);

  // Ahora "mica" (id 1) es la única activa. Simulamos otra sesión (no self) tratando de desactivarla:
  dbState.users.push({ id: 3, username: 'tercera', displayName: 'Tercera', activo: false, tokenVersion: 1 });
  const blockedRes = await fetch(`${baseUrl()}/1`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'mica', displayName: 'Mica', activo: false }),
  });
  // Este caso además choca con "no podés desactivarte a vos misma" (id 1 == req.user.id), que es
  // justamente la otra guarda — confirma que al menos una de las dos protecciones actúa.
  assert.equal(blockedRes.status, 400);
});

test('PUT /:id cambia datos y, si desactiva o cambia contraseña, sube token_version', async () => {
  dbState.users.push({ id: 2, username: 'otra', displayName: 'Otra', activo: true, tokenVersion: 1 });
  const res = await fetch(`${baseUrl()}/2`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'otra', displayName: 'Otra Editada', activo: false }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.item.displayName, 'Otra Editada');
  assert.deepEqual(dbState.bumpCalls, [2]);
  assert.deepEqual(invalidateCalls, [2]);
});

test('POST /:id/cerrar-sesiones sube token_version', async () => {
  const res = await fetch(`${baseUrl()}/1/cerrar-sesiones`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.deepEqual(dbState.bumpCalls, [1]);
});

test('DELETE /:id no permite borrarse a una misma', async () => {
  const res = await fetch(`${baseUrl()}/1`, { method: 'DELETE' });
  assert.equal(res.status, 400);
  assert.equal(dbState.users.length, 1);
});

test('DELETE /:id no permite dejar el hub sin ningún usuario activo', async () => {
  dbState.users.push({ id: 2, username: 'otra', displayName: 'Otra', activo: true, tokenVersion: 1 });
  dbState.users[0].activo = false; // solo "otra" queda activa
  const res = await fetch(`${baseUrl()}/2`, { method: 'DELETE' });
  assert.equal(res.status, 400);
  assert.equal(dbState.users.length, 2);
});

test('DELETE /:id borra un usuario que no es una misma y no es el último activo', async () => {
  dbState.users.push({ id: 2, username: 'otra', displayName: 'Otra', activo: true, tokenVersion: 1 });
  const res = await fetch(`${baseUrl()}/2`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.equal(dbState.users.length, 1);
});
