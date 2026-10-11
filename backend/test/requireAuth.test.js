/**
 * Tests del middleware requireAuth: token ausente/inválido, usuario inactivo o con token_version
 * viejo, la caché de 60s sobre getAppUserById y su invalidación, y el 503 sin base de datos.
 */
import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.AUTH_JWT_SECRET = 'test-secret-requireAuth';

const dbState = { hasDb: true, users: {}, getByIdCalls: 0 };

let requireAuth, requireAdmin, invalidateAuthUserCache, signToken;

before(async () => {
  mock.module('../src/db.js', {
    exports: {
      hasDatabase: () => dbState.hasDb,
      getAppUserById: async (id) => {
        dbState.getByIdCalls++;
        return dbState.users[id] ?? null;
      },
    },
  });
  ({ requireAuth, requireAdmin, invalidateAuthUserCache } = await import('../src/middleware/requireAuth.js'));
  ({ signToken } = await import('../src/lib/authTokens.js'));
});

beforeEach(() => {
  dbState.hasDb = true;
  dbState.users = { 1: { id: 1, activo: true, tokenVersion: 1 } };
  dbState.getByIdCalls = 0;
  // La caché del middleware vive a nivel de módulo, así que hay que vaciarla entre tests para
  // que el estado de dbState de un test no se filtre al siguiente vía la ventana de 60s.
  invalidateAuthUserCache(1);
  invalidateAuthUserCache(2);
});

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function run(req) {
  const res = fakeRes();
  let nextCalled = false;
  await requireAuth(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

test('sin header Authorization → 401', async () => {
  const { res, nextCalled } = await run({ headers: {} });
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test('token inválido / basura → 401', async () => {
  const { res, nextCalled } = await run({ headers: { authorization: 'Bearer no-es-un-token' } });
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test('sin base de datos → 503, ni siquiera intenta verificar el token', async () => {
  dbState.hasDb = false;
  const { res, nextCalled } = await run({ headers: { authorization: 'Bearer lo-que-sea' } });
  assert.equal(res.statusCode, 503);
  assert.equal(nextCalled, false);
});

test('token válido de un usuario inactivo → 401', async () => {
  dbState.users[1] = { id: 1, activo: false, tokenVersion: 1 };
  const token = signToken({ id: 1, username: 'mica', tokenVersion: 1 });
  const { res, nextCalled } = await run({ headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test('token válido pero con token_version vieja (revocado) → 401', async () => {
  const token = signToken({ id: 1, username: 'mica', tokenVersion: 1 });
  dbState.users[1] = { id: 1, activo: true, tokenVersion: 2 }; // se subió después de emitido el token
  const { res, nextCalled } = await run({ headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test('token válido, usuario activo, misma token_version → pasa y setea req.user', async () => {
  const token = signToken({ id: 1, username: 'mica', tokenVersion: 1 });
  const req = { headers: { authorization: `Bearer ${token}` } };
  const { res, nextCalled } = await run(req);
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
  assert.deepEqual(req.user, { id: 1, username: 'mica', role: 'admin' });
});

test('la caché evita un segundo SELECT dentro de la ventana de 60s', async () => {
  const token = signToken({ id: 1, username: 'mica', tokenVersion: 1 });
  await requireAuth({ headers: { authorization: `Bearer ${token}` } }, fakeRes(), () => {});
  await requireAuth({ headers: { authorization: `Bearer ${token}` } }, fakeRes(), () => {});
  assert.equal(dbState.getByIdCalls, 1);
});

test('invalidateAuthUserCache fuerza a releer la base en la próxima request', async () => {
  const token = signToken({ id: 1, username: 'mica', tokenVersion: 1 });
  await requireAuth({ headers: { authorization: `Bearer ${token}` } }, fakeRes(), () => {});
  invalidateAuthUserCache(1);
  await requireAuth({ headers: { authorization: `Bearer ${token}` } }, fakeRes(), () => {});
  assert.equal(dbState.getByIdCalls, 2);
});

// ── Roles ────────────────────────────────────────────────────────────────

function asUser(id, role, method, url) {
  dbState.users[id] = { id, activo: true, tokenVersion: 1, role };
  const token = signToken({ id, username: `u${id}`, tokenVersion: 1 });
  return run({ headers: { authorization: `Bearer ${token}` }, method, originalUrl: url });
}

test('lectura: un GET pasa y req.user lleva el rol', async () => {
  const req = { headers: {}, method: 'GET', originalUrl: '/api/deposito' };
  dbState.users[2] = { id: 2, activo: true, tokenVersion: 1, role: 'lectura' };
  req.headers.authorization = `Bearer ${signToken({ id: 2, username: 'vista', tokenVersion: 1 })}`;
  const res = fakeRes();
  let nextCalled = false;
  await requireAuth(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req.user.role, 'lectura');
});

test('lectura: POST / PUT / PATCH / DELETE de escritura → 403 read_only', async () => {
  for (const [method, url] of [
    ['POST', '/api/deposito'], ['PUT', '/api/deposito/3'], ['PATCH', '/api/deposito/3/ajustar'],
    ['DELETE', '/api/orders/4'], ['POST', '/api/products/drafts/1/publish'], ['POST', '/api/sync/prices'],
    ['POST', '/api/auth/mercadolibre/disconnect'],
  ]) {
    const { res, nextCalled } = await asUser(2, 'lectura', method, url);
    assert.equal(res.statusCode, 403, `${method} ${url}`);
    assert.equal(res.body.code, 'read_only');
    assert.equal(nextCalled, false);
  }
});

test('lectura: las escrituras permitidas pasan (sesión propia, Actualizar, tildes de despacho)', async () => {
  for (const [method, url] of [
    ['POST', '/api/session/logout'], ['POST', '/api/session/password'],
    ['POST', '/api/sales/sync'], ['POST', '/api/sync/returns/fetch?x=1'],
    ['POST', '/api/products/publish-jobs/reconcile'],
    ['PUT', '/api/dispatch/ml/123/prepared'], ['DELETE', '/api/dispatch/tn/9/prepared'],
    ['PUT', '/api/dispatch/ml/123/cancel-seen'],
  ]) {
    const { res, nextCalled } = await asUser(2, 'lectura', method, url);
    assert.equal(nextCalled, true, `${method} ${url} → ${res.statusCode}`);
  }
});

test('admin: cualquier escritura pasa', async () => {
  const { nextCalled } = await asUser(1, 'admin', 'DELETE', '/api/orders/4');
  assert.equal(nextCalled, true);
});

test('usuario sin rol en la base (previo a la migración) se trata como admin', async () => {
  const { nextCalled } = await asUser(1, undefined, 'POST', '/api/deposito');
  assert.equal(nextCalled, true);
});

test('el rol sale de la caché: un cambio aplica recién al invalidarla', async () => {
  await asUser(2, 'admin', 'GET', '/api/deposito');
  dbState.users[2].role = 'lectura';
  const stale = await run({
    headers: { authorization: `Bearer ${signToken({ id: 2, username: 'u2', tokenVersion: 1 })}` },
    method: 'POST', originalUrl: '/api/deposito',
  });
  assert.equal(stale.nextCalled, true);
  invalidateAuthUserCache(2);
  const fresh = await run({
    headers: { authorization: `Bearer ${signToken({ id: 2, username: 'u2', tokenVersion: 1 })}` },
    method: 'POST', originalUrl: '/api/deposito',
  });
  assert.equal(fresh.res.statusCode, 403);
});

test('requireAdmin: admin pasa, lectura → 403 admin_only', () => {
  let called = false;
  requireAdmin({ user: { role: 'admin' } }, fakeRes(), () => { called = true; });
  assert.equal(called, true);
  const res = fakeRes();
  called = false;
  requireAdmin({ user: { role: 'lectura' } }, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'admin_only');
});
