/**
 * Tests de db.js: capa de acceso a Postgres (sync_settings, sync_audit, sync_pending_returns,
 * sync_processed_orders, oauth_tokens, ml_pending_tasks).
 *
 * Mockeamos `pg` (no hay Postgres real en los tests): una Pool falsa cuyo `query`/`connect().query`
 * delega en `state.responder(sql, params)`, configurable por test. Esto alcanza para probar tanto el
 * camino feliz (filas devueltas) como el catch de cada función (responder que rechaza la promesa).
 *
 * Además probamos el corto-circuito "sin DATABASE_URL" (getPool() devuelve null) sacando la env var
 * puntualmente en algunos tests — getPool() la relee en cada llamada, así que no hace falta un
 * archivo de test aparte para ese caso.
 */
import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const state = { responder: null };

function defaultResponder(sql) {
  if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [], rowCount: 0 };
  return { rows: [], rowCount: 0 };
}

class MockClient {
  async query(sql, params) {
    return (state.responder || defaultResponder)(sql, params);
  }
  release() {}
}

class MockPool {
  async query(sql, params) {
    return (state.responder || defaultResponder)(sql, params);
  }
  async connect() {
    return new MockClient();
  }
}

let db;
before(async () => {
  mock.module('pg', { exports: { default: { Pool: MockPool } } });
  process.env.DATABASE_URL = 'postgres://test/db';
  db = await import('../src/db.js');
});

beforeEach(() => {
  state.responder = null;
  process.env.DATABASE_URL = 'postgres://test/db';
});

// ─── getPool() / hasDatabase() ────────────────────────────────────────────────

test('hasDatabase: true cuando hay DATABASE_URL configurada', () => {
  assert.equal(db.hasDatabase(), true);
});

test('hasDatabase: false sin DATABASE_URL (getPool corta antes de crear la Pool)', () => {
  delete process.env.DATABASE_URL;
  assert.equal(db.hasDatabase(), false);
});

test('sin DATABASE_URL: las funciones devuelven su valor por defecto sin tocar la Pool', async () => {
  delete process.env.DATABASE_URL;
  assert.equal(await db.getSyncEnabled(), false);
  assert.equal(await db.setSyncEnabled(true), false);
  assert.deepEqual(await db.getAuditLog(), { rows: [], total: 0 });
  assert.equal(await db.getAnalysisSnapshot(), null);
  assert.equal(await db.getAuditRowById(1), null);
  assert.equal(await db.setAuditReverted(1), false);
  assert.equal(await db.getOAuthTokens(), null);
  assert.equal(await db.setOAuthTokens({}), false);
  assert.deepEqual(await db.getPendingReturns(), { rows: [], total: 0 });
  assert.equal(await db.insertPendingReturn({}), null);
  assert.equal(await db.hasPendingReturnForClaimItem('c', 'i'), false);
  assert.equal(await db.hasPendingReturnForOrder('o'), false);
  assert.equal(await db.getPendingReturnById(1), null);
  assert.equal(await db.setReturnApproved(1), false);
  assert.equal(await db.enqueueMlTask({ kind: 'x', itemId: 'y' }), null);
  assert.equal(await db.claimNextMlTask(), null);
  assert.equal(await db.updateMlTaskStatus(1, 'done'), false);
  assert.deepEqual(await db.getPendingMlTasks(), { tasks: [], total: 0, activeCount: 0, failedCount: 0 });
  assert.equal(await db.retryMlTask(1), false);
  assert.equal(await db.getMlTaskStatus(1), null);
  assert.equal(await db.tryClaimOrderProcessing('mercadolibre', '1', 'deduct'), false);
  assert.equal(await db.hasOrderProcessingClaimed('mercadolibre', '1', 'deduct'), false);
  assert.equal(await db.releaseOrderProcessingClaim('mercadolibre', '1', 'deduct'), false);
  assert.equal(await db.initDb(), false);
});

// ─── initDb ────────────────────────────────────────────────────────────────

test('initDb: crea tablas y hace el backfill de pack_id → true', async () => {
  const calls = [];
  state.responder = (sql) => { calls.push(sql); return { rows: [], rowCount: 0 }; };
  const ok = await db.initDb();
  assert.equal(ok, true);
  assert.ok(calls.some((s) => s.includes('CREATE TABLE IF NOT EXISTS sync_settings')));
  assert.ok(calls.some((s) => s.includes('CREATE TABLE IF NOT EXISTS ml_pending_tasks')));
});

test('initDb: si falla el backfill de pack_id, lo swallowea y sigue (sigue devolviendo true)', async () => {
  state.responder = (sql) => {
    if (sql.includes("SET pack_id = (notification_payload::jsonb")) throw new Error('boom backfill');
    return { rows: [], rowCount: 0 };
  };
  const ok = await db.initDb();
  assert.equal(ok, true);
});

test('initDb: si falla una query de creación de tabla, devuelve false', async () => {
  state.responder = (sql) => {
    if (sql.includes('CREATE TABLE IF NOT EXISTS sync_settings')) throw new Error('conexión rechazada');
    return { rows: [], rowCount: 0 };
  };
  const ok = await db.initDb();
  assert.equal(ok, false);
});

// ─── getAnalysisCache / setAnalysisCache / invalidateAnalysisCache ──────────

test('getAnalysisSnapshot: sin fila devuelve null', async () => {
  state.responder = () => ({ rows: [] });
  assert.equal(await db.getAnalysisSnapshot(), null);
});

test('getAnalysisSnapshot: fila devuelve { at, data } sin filtrar por antigüedad', async () => {
  const at = Date.now() - 10 * 60 * 1000; // "viejo": ya no se filtra por TTL, lo decide el consumidor
  state.responder = () => ({ rows: [{ value: JSON.stringify({ at, data: { mlRows: [], tnRows: [] } }) }] });
  const snap = await db.getAnalysisSnapshot();
  assert.deepEqual(snap.data, { mlRows: [], tnRows: [] });
  assert.equal(snap.at, at);
});

test('getAnalysisSnapshot: sin data devuelve null', async () => {
  state.responder = () => ({ rows: [{ value: JSON.stringify({ at: Date.now() }) }] });
  assert.equal(await db.getAnalysisSnapshot(), null);
});

test('getAnalysisSnapshot: error de query → catch devuelve null', async () => {
  state.responder = () => { throw new Error('db down'); };
  assert.equal(await db.getAnalysisSnapshot(), null);
});

test('setAnalysisSnapshot: hace upsert sin lanzar', async () => {
  let inserted = null;
  state.responder = (sql, params) => { inserted = params; return { rows: [] }; };
  await db.setAnalysisSnapshot({ a: 1 });
  assert.equal(inserted[0], 'conflicts_analysis_cache');
});

test('setAnalysisSnapshot: error de query no propaga (catch interno)', async () => {
  state.responder = () => { throw new Error('boom'); };
  await db.setAnalysisSnapshot({ a: 1 }); // no debe lanzar
});

test('invalidateAnalysisCache: borra la fila sin lanzar', async () => {
  let ran = false;
  state.responder = (sql) => { if (sql.includes('DELETE FROM sync_settings')) ran = true; return { rows: [] }; };
  await db.invalidateAnalysisCache();
  assert.equal(ran, true);
});

test('invalidateAnalysisCache: error de query no propaga', async () => {
  state.responder = () => { throw new Error('boom'); };
  await db.invalidateAnalysisCache();
});

// ─── getSyncEnabled / setSyncEnabled ─────────────────────────────────────────

test('getSyncEnabled: true cuando value = "true"', async () => {
  state.responder = () => ({ rows: [{ value: 'true' }] });
  assert.equal(await db.getSyncEnabled(), true);
});

test('getSyncEnabled: false cuando no hay fila', async () => {
  state.responder = () => ({ rows: [] });
  assert.equal(await db.getSyncEnabled(), false);
});

test('getSyncEnabled: error de query → false', async () => {
  state.responder = () => { throw new Error('boom'); };
  assert.equal(await db.getSyncEnabled(), false);
});

test('setSyncEnabled: true en éxito', async () => {
  state.responder = () => ({ rows: [] });
  assert.equal(await db.setSyncEnabled(true), true);
});

test('setSyncEnabled: false si la query falla', async () => {
  state.responder = () => { throw new Error('boom'); };
  assert.equal(await db.setSyncEnabled(true), false);
});

// ─── tryClaimOrderProcessing / hasOrderProcessingClaimed / releaseOrderProcessingClaim ──

test('tryClaimOrderProcessing: sin orderId devuelve false sin consultar', async () => {
  assert.equal(await db.tryClaimOrderProcessing('mercadolibre', '', 'deduct'), false);
});

test('tryClaimOrderProcessing: gana la carrera (rowCount > 0) → true', async () => {
  state.responder = () => ({ rows: [{}], rowCount: 1 });
  assert.equal(await db.tryClaimOrderProcessing('mercadolibre', '1', 'deduct'), true);
});

test('tryClaimOrderProcessing: ya reclamada (rowCount 0 por ON CONFLICT DO NOTHING) → false', async () => {
  state.responder = () => ({ rows: [], rowCount: 0 });
  assert.equal(await db.tryClaimOrderProcessing('mercadolibre', '1', 'deduct'), false);
});

test('tryClaimOrderProcessing: error de query → false', async () => {
  state.responder = () => { throw new Error('boom'); };
  assert.equal(await db.tryClaimOrderProcessing('mercadolibre', '1', 'deduct'), false);
});

test('hasOrderProcessingClaimed: sin orderId → false', async () => {
  assert.equal(await db.hasOrderProcessingClaimed('mercadolibre', '', 'deduct'), false);
});

test('hasOrderProcessingClaimed: true si existe fila', async () => {
  state.responder = () => ({ rows: [{}], rowCount: 1 });
  assert.equal(await db.hasOrderProcessingClaimed('mercadolibre', '1', 'deduct'), true);
});

test('hasOrderProcessingClaimed: error de query → false', async () => {
  state.responder = () => { throw new Error('boom'); };
  assert.equal(await db.hasOrderProcessingClaimed('mercadolibre', '1', 'deduct'), false);
});

test('releaseOrderProcessingClaim: sin orderId → false', async () => {
  assert.equal(await db.releaseOrderProcessingClaim('mercadolibre', '', 'deduct'), false);
});

test('releaseOrderProcessingClaim: true si borró una fila', async () => {
  state.responder = () => ({ rows: [{}], rowCount: 1 });
  assert.equal(await db.releaseOrderProcessingClaim('mercadolibre', '1', 'deduct'), true);
});

test('releaseOrderProcessingClaim: error de query → false', async () => {
  state.responder = () => { throw new Error('boom'); };
  assert.equal(await db.releaseOrderProcessingClaim('mercadolibre', '1', 'deduct'), false);
});

// ─── insertAuditLog / getAuditLog / getAuditRowById / setAuditReverted ───────

test('insertAuditLog: arma params correctamente (objeto → JSON.stringify; string se deja igual)', async () => {
  let params;
  state.responder = (sql, p) => { params = p; return { rows: [] }; };
  await db.insertAuditLog({
    channelSale: 'mercadolibre',
    orderId: '1',
    packId: '2',
    saleItemId: 'MLA1',
    sku: 'X',
    productLabel: 'Venta ML',
    productDisplay: 'Cuaderno',
    quantity: 2,
    updatedChannel: 'tiendanube',
    stockBefore: 5,
    stockAfter: 3,
    notificationPayload: { foo: 1 }
  });
  assert.equal(params[0], 'mercadolibre');
  assert.equal(params[11], JSON.stringify({ foo: 1 }));
});

test('insertAuditLog: notificationPayload ya string se deja tal cual', async () => {
  let params;
  state.responder = (sql, p) => { params = p; return { rows: [] }; };
  await db.insertAuditLog({ channelSale: 'x', updatedChannel: 'y', notificationPayload: '{"a":1}' });
  assert.equal(params[11], '{"a":1}');
});

test('insertAuditLog: sin notificationPayload manda null y usa defaults', async () => {
  let params;
  state.responder = (sql, p) => { params = p; return { rows: [] }; };
  await db.insertAuditLog({ channelSale: 'x', updatedChannel: 'y' });
  assert.equal(params[11], null);
  assert.equal(params[1], ''); // orderId default
  assert.equal(params[7], 0); // quantity default
});

test('insertAuditLog: error de query no propaga', async () => {
  state.responder = () => { throw new Error('boom'); };
  await db.insertAuditLog({ channelSale: 'x', updatedChannel: 'y' });
});

test('getAuditLog: sin búsqueda arma SQL sin WHERE y devuelve rows+total', async () => {
  let sqlSeen = [];
  state.responder = (sql) => {
    sqlSeen.push(sql);
    if (sql.startsWith('SELECT COUNT')) return { rows: [{ total: 2 }] };
    return { rows: [{ id: 1, createdAt: new Date('2024-01-01'), revertedAt: null }] };
  };
  const { rows, total } = await db.getAuditLog(10, 0);
  assert.equal(total, 2);
  assert.equal(rows[0].createdAt, new Date('2024-01-01').toISOString());
  assert.equal(rows[0].revertedAt, null);
  assert.ok(!sqlSeen.some((s) => s.includes('WHERE')));
});

test('getAuditLog: con búsqueda arma SQL con ILIKE', async () => {
  let listSql;
  state.responder = (sql) => {
    if (sql.startsWith('SELECT COUNT')) return { rows: [{ total: 1 }] };
    listSql = sql;
    return { rows: [{ id: 1, createdAt: null, revertedAt: new Date('2024-02-02') }] };
  };
  const { rows, total } = await db.getAuditLog(10, 0, '12345');
  assert.equal(total, 1);
  assert.ok(listSql.includes('ILIKE'));
  assert.equal(rows[0].createdAt, null);
  assert.equal(rows[0].revertedAt, new Date('2024-02-02').toISOString());
});

test('getAuditLog: error de query → { rows: [], total: 0 }', async () => {
  state.responder = () => { throw new Error('boom'); };
  assert.deepEqual(await db.getAuditLog(), { rows: [], total: 0 });
});

test('getAuditRowById: sin id → null sin consultar', async () => {
  assert.equal(await db.getAuditRowById(null), null);
});

test('getAuditRowById: fila encontrada normaliza revertedAt a Date', async () => {
  state.responder = () => ({ rows: [{ id: 1, revertedAt: '2024-01-01T00:00:00Z' }] });
  const row = await db.getAuditRowById(1);
  assert.ok(row.revertedAt instanceof Date);
});

test('getAuditRowById: sin fila → null', async () => {
  state.responder = () => ({ rows: [] });
  assert.equal(await db.getAuditRowById(999), null);
});

test('getAuditRowById: error de query → null', async () => {
  state.responder = () => { throw new Error('boom'); };
  assert.equal(await db.getAuditRowById(1), null);
});

test('setAuditReverted: sin id → false', async () => {
  assert.equal(await db.setAuditReverted(null), false);
});

test('setAuditReverted: true si actualizó una fila', async () => {
  state.responder = () => ({ rows: [{}], rowCount: 1 });
  assert.equal(await db.setAuditReverted(1), true);
});

test('setAuditReverted: false si ya estaba revertida (rowCount 0)', async () => {
  state.responder = () => ({ rows: [], rowCount: 0 });
  assert.equal(await db.setAuditReverted(1), false);
});

test('setAuditReverted: error de query → false', async () => {
  state.responder = () => { throw new Error('boom'); };
  assert.equal(await db.setAuditReverted(1), false);
});

// ─── OAuth tokens ─────────────────────────────────────────────────────────

test('getOAuthTokens: devuelve el value guardado', async () => {
  state.responder = () => ({ rows: [{ value: { mercadolibre: { access_token: 'x' } } }] });
  const data = await db.getOAuthTokens();
  assert.deepEqual(data, { mercadolibre: { access_token: 'x' } });
});

test('getOAuthTokens: sin fila → null', async () => {
  state.responder = () => ({ rows: [] });
  assert.equal(await db.getOAuthTokens(), null);
});

test('getOAuthTokens: error de query → null', async () => {
  state.responder = () => { throw new Error('boom'); };
  assert.equal(await db.getOAuthTokens(), null);
});

test('setOAuthTokens: true en éxito', async () => {
  state.responder = () => ({ rows: [] });
  assert.equal(await db.setOAuthTokens({ a: 1 }), true);
});

test('setOAuthTokens: false si la query falla', async () => {
  state.responder = () => { throw new Error('boom'); };
  assert.equal(await db.setOAuthTokens({ a: 1 }), false);
});

// ─── Pending returns ──────────────────────────────────────────────────────

test('getPendingReturns: arma rows con fechas ISO y total', async () => {
  state.responder = (sql) => {
    if (sql.startsWith('SELECT COUNT')) return { rows: [{ total: 1 }] };
    return { rows: [{ id: 1, createdAt: new Date('2024-01-01'), claimDate: null }] };
  };
  const { rows, total } = await db.getPendingReturns(20, 0);
  assert.equal(total, 1);
  assert.equal(rows[0].createdAt, new Date('2024-01-01').toISOString());
  assert.equal(rows[0].claimDate, null);
});

test('getPendingReturns: error de query → vacío', async () => {
  state.responder = () => { throw new Error('boom'); };
  assert.deepEqual(await db.getPendingReturns(), { rows: [], total: 0 });
});

test('insertPendingReturn: devuelve la fila creada con fechas ISO', async () => {
  state.responder = () => ({ rows: [{ id: 1, orderId: '5', createdAt: new Date('2024-01-01'), claimDate: new Date('2024-01-02') }] });
  const row = await db.insertPendingReturn({ orderId: '5', itemId: 'MLA1' });
  assert.equal(row.id, 1);
  assert.equal(row.createdAt, new Date('2024-01-01').toISOString());
  assert.equal(row.claimDate, new Date('2024-01-02').toISOString());
});

test('insertPendingReturn: error de query → null', async () => {
  state.responder = () => { throw new Error('boom'); };
  assert.equal(await db.insertPendingReturn({}), null);
});

test('hasPendingReturnForClaimItem: sin claimId → false sin consultar', async () => {
  assert.equal(await db.hasPendingReturnForClaimItem(null, 'i1'), false);
});

test('hasPendingReturnForClaimItem: true si encuentra fila', async () => {
  state.responder = () => ({ rows: [{}] });
  assert.equal(await db.hasPendingReturnForClaimItem('c1', 'i1', 'v1'), true);
});

test('hasPendingReturnForClaimItem: error de query → false', async () => {
  state.responder = () => { throw new Error('boom'); };
  assert.equal(await db.hasPendingReturnForClaimItem('c1', 'i1'), false);
});

test('hasPendingReturnForOrder: sin orderId → false', async () => {
  assert.equal(await db.hasPendingReturnForOrder(''), false);
});

test('hasPendingReturnForOrder: true si encuentra fila', async () => {
  state.responder = () => ({ rows: [{}] });
  assert.equal(await db.hasPendingReturnForOrder('123'), true);
});

test('hasPendingReturnForOrder: error de query → false', async () => {
  state.responder = () => { throw new Error('boom'); };
  assert.equal(await db.hasPendingReturnForOrder('123'), false);
});

test('getPendingReturnById: devuelve fila o null', async () => {
  state.responder = () => ({ rows: [{ id: 5 }] });
  assert.deepEqual(await db.getPendingReturnById(5), { id: 5 });
  state.responder = () => ({ rows: [] });
  assert.equal(await db.getPendingReturnById(999), null);
});

test('getPendingReturnById: error de query → null', async () => {
  state.responder = () => { throw new Error('boom'); };
  assert.equal(await db.getPendingReturnById(5), null);
});

test('setReturnApproved: true en éxito', async () => {
  state.responder = () => ({ rows: [] });
  assert.equal(await db.setReturnApproved(5), true);
});

test('setReturnApproved: false si la query falla', async () => {
  state.responder = () => { throw new Error('boom'); };
  assert.equal(await db.setReturnApproved(5), false);
});

// ─── ml_pending_tasks ─────────────────────────────────────────────────────

test('enqueueMlTask: devuelve el id insertado', async () => {
  state.responder = () => ({ rows: [{ id: 42 }] });
  const id = await db.enqueueMlTask({ kind: 'stock_ml', itemId: 'MLA1', targetQty: -1 });
  assert.equal(id, 42);
});

test('enqueueMlTask: error de query → null', async () => {
  state.responder = () => { throw new Error('boom'); };
  assert.equal(await db.enqueueMlTask({ kind: 'stock_ml', itemId: 'MLA1' }), null);
});

test('claimNextMlTask: sin tarea disponible devuelve null (BEGIN/SELECT vacío/COMMIT)', async () => {
  state.responder = (sql) => {
    if (sql.includes('FOR UPDATE SKIP LOCKED')) return { rows: [] };
    return { rows: [], rowCount: 0 };
  };
  assert.equal(await db.claimNextMlTask(), null);
});

test('claimNextMlTask: reclama la tarea encontrada y la marca processing', async () => {
  const updates = [];
  state.responder = (sql, params) => {
    if (sql.includes('FOR UPDATE SKIP LOCKED')) {
      return { rows: [{ id: 7, kind: 'stock_ml', itemId: 'MLA1', variationId: null, targetQty: -1, targetSku: null, targetPrice: null, contextJson: null, attempts: 0 }] };
    }
    if (sql.includes("SET status = 'processing'")) updates.push(params);
    return { rows: [], rowCount: 0 };
  };
  const task = await db.claimNextMlTask();
  assert.equal(task.id, 7);
  assert.equal(updates[0][0], 7);
});

test('claimNextMlTask: si falla la query hace ROLLBACK y devuelve null', async () => {
  let rolledBack = false;
  state.responder = (sql) => {
    if (sql.includes('FOR UPDATE SKIP LOCKED')) throw new Error('boom');
    if (/^ROLLBACK/i.test(sql)) rolledBack = true;
    return { rows: [], rowCount: 0 };
  };
  const task = await db.claimNextMlTask();
  assert.equal(task, null);
  assert.equal(rolledBack, true);
});

test('updateMlTaskStatus: status "done" no calcula backoff', async () => {
  const calls = [];
  state.responder = (sql, params) => { calls.push({ sql, params }); return { rows: [] }; };
  const ok = await db.updateMlTaskStatus(1, 'done');
  assert.equal(ok, true);
  assert.ok(!calls.some((c) => c.sql.includes('SELECT attempts')));
});

test('updateMlTaskStatus: status "failed" calcula backoff exponencial leyendo attempts', async () => {
  state.responder = (sql) => {
    if (sql.includes('SELECT attempts')) return { rows: [{ attempts: 2 }] };
    return { rows: [] };
  };
  const ok = await db.updateMlTaskStatus(1, 'failed', 'ML rechazó');
  assert.equal(ok, true);
});

test('updateMlTaskStatus: error de query → false', async () => {
  state.responder = () => { throw new Error('boom'); };
  assert.equal(await db.updateMlTaskStatus(1, 'done'), false);
});

test('getPendingMlTasks: arma tasks con targetPrice numérico y fechas ISO', async () => {
  state.responder = (sql) => {
    if (sql.startsWith('SELECT\n')) return { rows: [{ total: 1, activeCount: 1, failedCount: 0 }] };
    return {
      rows: [{
        id: 1, kind: 'price_ml', targetPrice: '150.00',
        createdAt: new Date('2024-01-01'), updatedAt: new Date('2024-01-02'), nextRunAt: null
      }]
    };
  };
  const { tasks, total, activeCount, failedCount } = await db.getPendingMlTasks(20, 0);
  assert.equal(total, 1);
  assert.equal(activeCount, 1);
  assert.equal(failedCount, 0);
  assert.equal(tasks[0].targetPrice, 150);
  assert.equal(tasks[0].nextRunAt, null);
});

test('getPendingMlTasks: error de query → estructura vacía', async () => {
  state.responder = () => { throw new Error('boom'); };
  assert.deepEqual(await db.getPendingMlTasks(), { tasks: [], total: 0, activeCount: 0, failedCount: 0 });
});

test('retryMlTask: true si reinició una fila failed', async () => {
  state.responder = () => ({ rows: [], rowCount: 1 });
  assert.equal(await db.retryMlTask(1), true);
});

test('retryMlTask: false si no había fila failed con ese id', async () => {
  state.responder = () => ({ rows: [], rowCount: 0 });
  assert.equal(await db.retryMlTask(1), false);
});

test('retryMlTask: error de query → false', async () => {
  state.responder = () => { throw new Error('boom'); };
  assert.equal(await db.retryMlTask(1), false);
});

test('getMlTaskStatus: devuelve la fila o null', async () => {
  state.responder = () => ({ rows: [{ id: 1, status: 'done' }] });
  assert.deepEqual(await db.getMlTaskStatus(1), { id: 1, status: 'done' });
  state.responder = () => ({ rows: [] });
  assert.equal(await db.getMlTaskStatus(2), null);
});

test('getMlTaskStatus: error de query → null', async () => {
  state.responder = () => { throw new Error('boom'); };
  assert.equal(await db.getMlTaskStatus(1), null);
});
