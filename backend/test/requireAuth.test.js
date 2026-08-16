/**
 * Tests del middleware requireAuth: token ausente/inválido, usuario inactivo o con token_version
 * viejo, la caché de 60s sobre getAppUserById y su invalidación, y el 503 sin base de datos.
 */
import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.AUTH_JWT_SECRET = 'test-secret-requireAuth';

const dbState = { hasDb: true, users: {}, getByIdCalls: 0 };

let requireAuth, invalidateAuthUserCache, signToken;

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
  ({ requireAuth, invalidateAuthUserCache } = await import('../src/middleware/requireAuth.js'));
  ({ signToken } = await import('../src/lib/authTokens.js'));
});

beforeEach(() => {
  dbState.hasDb = true;
  dbState.users = { 1: { id: 1, activo: true, tokenVersion: 1 } };
  dbState.getByIdCalls = 0;
  // La caché del middleware vive a nivel de módulo, así que hay que vaciarla entre tests para
  // que el estado de dbState de un test no se filtre al siguiente vía la ventana de 60s.
  invalidateAuthUserCache(1);
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
  assert.deepEqual(req.user, { id: 1, username: 'mica' });
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
