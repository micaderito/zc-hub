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
  assert.equal(await db.createProductDraft({ id: 'd1', draftJson: '{}' }), null);
  assert.equal(await db.getProductDraft('d1'), null);
  assert.deepEqual(await db.listProductDrafts(), []);
  assert.equal(await db.deleteProductDraft('d1'), false);
  assert.equal(await db.createPublishJob({ id: 'j1', draftId: 'd1', channels: 'ml', payloadJson: '{}' }), null);
  assert.equal(await db.claimNextPublishJob(), null);
  assert.equal(await db.retryPublishJob('j1'), false);
  assert.equal(await db.cancelPublishJob('j1'), false);
  assert.equal(await db.isPublishJobCancelled('j1'), false);
  assert.equal(await db.getPublishJob('j1'), null);
  assert.deepEqual(await db.listPublishJobsForDraft('d1'), []);
  assert.equal(await db.upsertPublishUnit({ jobId: 'j1', channel: 'ml', unitKey: '', seq: 0, status: 'ok' }), false);
  assert.deepEqual(await db.getPublishUnits('j1'), []);
  assert.equal(await db.recomputeDraftStatus('d1'), null);
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

// ─── historial: origen del cambio (venta / manual / devolución) ──────────────

test('insertAuditLog: un cambio manual guarda source y anula los campos de venta', async () => {
  let params;
  state.responder = (sql, p) => { params = p; return { rows: [] }; };
  await db.insertAuditLog({
    source: 'manual',
    sku: 'X',
    updatedChannel: 'mercadolibre',
    stockBefore: 5,
    stockAfter: 2,
  });
  assert.equal(params[12], 'manual');
  assert.equal(params[0], null); // channelSale: no hubo venta
  assert.equal(params[1], null); // orderId
  assert.equal(params[2], null); // packId
  assert.equal(params[7], null); // quantity: no hay cantidad vendida
  // Lo que sí cuenta el cambio:
  assert.equal(params[9], 5);
  assert.equal(params[10], 2);
});

test('insertAuditLog: sin source explícito la fila es de venta (retrocompatible)', async () => {
  let params;
  state.responder = (sql, p) => { params = p; return { rows: [] }; };
  await db.insertAuditLog({ channelSale: 'mercadolibre', orderId: '1', updatedChannel: 'tiendanube' });
  assert.equal(params[12], 'venta');
  assert.equal(params[1], '1');
});

test('getAuditLog: filtra por origen', async () => {
  let listSql, listParams;
  state.responder = (sql, p) => {
    if (sql.startsWith('SELECT COUNT')) return { rows: [{ total: 1 }] };
    listSql = sql; listParams = p;
    return { rows: [] };
  };
  await db.getAuditLog(10, 0, '', 'manual');
  assert.ok(listSql.includes('source = $1'));
  assert.equal(listParams[0], 'manual');
});

test('getAuditLog: un origen inventado se ignora en vez de filtrar por nada', async () => {
  let listSql;
  state.responder = (sql) => {
    if (sql.startsWith('SELECT COUNT')) return { rows: [{ total: 0 }] };
    listSql = sql;
    return { rows: [] };
  };
  await db.getAuditLog(10, 0, '', 'cualquier-cosa');
  assert.ok(!listSql.includes('source ='));
});

test('getAuditLog: busca también por SKU, no solo por nº de venta', async () => {
  let listSql;
  state.responder = (sql) => {
    if (sql.startsWith('SELECT COUNT')) return { rows: [{ total: 0 }] };
    listSql = sql;
    return { rows: [] };
  };
  await db.getAuditLog(10, 0, 'SKU-1');
  assert.ok(listSql.includes('sku ILIKE'));
});

test('getAuditLog: combina búsqueda y origen con AND', async () => {
  let listSql, listParams;
  state.responder = (sql, p) => {
    if (sql.startsWith('SELECT COUNT')) return { rows: [{ total: 0 }] };
    listSql = sql; listParams = p;
    return { rows: [] };
  };
  await db.getAuditLog(10, 0, 'SKU-1', 'manual');
  assert.ok(listSql.includes(' AND '));
  assert.deepEqual(listParams.slice(0, 2), ['%SKU-1%', 'manual']);
});

// ─── getStockHistoryBySku ───────────────────────────────────────────────────

test('getStockHistoryBySku: sin sku → vacío sin consultar', async () => {
  state.responder = () => { throw new Error('no debería consultar'); };
  assert.deepEqual(await db.getStockHistoryBySku(''), { rows: [], total: 0 });
});

test('getStockHistoryBySku: filtra por sku exacto y normaliza fechas', async () => {
  let listParams;
  state.responder = (sql, p) => {
    if (sql.startsWith('SELECT COUNT')) return { rows: [{ total: 1 }] };
    listParams = p;
    return { rows: [{ id: 1, createdAt: new Date('2024-01-01'), revertedAt: null }] };
  };
  const { rows, total } = await db.getStockHistoryBySku('SKU-1', 10, 0);
  assert.equal(total, 1);
  assert.equal(listParams[0], 'SKU-1');
  assert.equal(rows[0].createdAt, new Date('2024-01-01').toISOString());
});

test('getStockHistoryBySku: error de query → vacío', async () => {
  state.responder = () => { throw new Error('boom'); };
  assert.deepEqual(await db.getStockHistoryBySku('SKU-1'), { rows: [], total: 0 });
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

// Locks vencidos: una tarea que quedó en 'processing' porque el worker se murió a mitad de camino
// (un deploy, típicamente) tiene que volver a la cola sola. Antes quedaba trabada para siempre.
test('claimNextMlTask: la query busca también tareas processing con el lock vencido', async () => {
  let selectSql = '';
  state.responder = (sql) => {
    if (sql.includes('FOR UPDATE SKIP LOCKED')) { selectSql = sql; return { rows: [] }; }
    return { rows: [], rowCount: 0 };
  };
  await db.claimNextMlTask();
  assert.ok(selectSql.includes("status = 'processing'"));
  assert.ok(selectSql.includes('locked_at <'));
});

test('claimNextMlTask: recuperar una tarea trabada cuenta como intento (attempts + 1)', async () => {
  let updateParams = null;
  state.responder = (sql, params) => {
    if (sql.includes('FOR UPDATE SKIP LOCKED')) {
      return { rows: [{ id: 7, kind: 'stock_ml', itemId: 'MLA1', variationId: null, targetQty: -1, targetSku: null, targetPrice: null, contextJson: null, attempts: 1, status: 'processing' }] };
    }
    if (sql.includes("SET status = 'processing'")) updateParams = params;
    return { rows: [], rowCount: 0 };
  };
  const task = await db.claimNextMlTask();
  assert.equal(updateParams[1], 1, 'debe sumar 1 intento al recuperar');
  assert.equal(task.attempts, 2);
  assert.equal(task.status, undefined, 'status es interno del claim, no se propaga al worker');
});

test('claimNextMlTask: una tarea pending no suma intento al reclamarse', async () => {
  let updateParams = null;
  state.responder = (sql, params) => {
    if (sql.includes('FOR UPDATE SKIP LOCKED')) {
      return { rows: [{ id: 8, kind: 'sku_ml', attempts: 0, status: 'pending' }] };
    }
    if (sql.includes("SET status = 'processing'")) updateParams = params;
    return { rows: [], rowCount: 0 };
  };
  const task = await db.claimNextMlTask();
  assert.equal(updateParams[1], 0);
  assert.equal(task.attempts, 0);
});

test('touchMlTaskLock: refresca locked_at solo si la tarea sigue en processing', async () => {
  let sqlSeen = '';
  state.responder = (sql, params) => { sqlSeen = sql; return { rows: [], rowCount: params[0] === 1 ? 1 : 0 }; };
  assert.equal(await db.touchMlTaskLock(1), true);
  assert.ok(sqlSeen.includes("status = 'processing'"));
  assert.equal(await db.touchMlTaskLock(2), false);
});

test('touchMlTaskLock: error de query → false', async () => {
  state.responder = () => { throw new Error('boom'); };
  assert.equal(await db.touchMlTaskLock(1), false);
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
  assert.equal(tasks[0].stuck, false, 'sin flag de la query, la tarea no está trabada');
});

test('getPendingMlTasks: propaga el flag stuck que calcula la query (lock vencido)', async () => {
  state.responder = (sql) => {
    if (sql.startsWith('SELECT\n')) return { rows: [{ total: 1, activeCount: 1, failedCount: 0 }] };
    return { rows: [{ id: 1, kind: 'stock_ml_set', status: 'processing', stuck: true, createdAt: null, updatedAt: null, nextRunAt: null }] };
  };
  const { tasks } = await db.getPendingMlTasks(20, 0);
  assert.equal(tasks[0].stuck, true);
});

test('getPendingMlTasks: error de query → estructura vacía', async () => {
  state.responder = () => { throw new Error('boom'); };
  assert.deepEqual(await db.getPendingMlTasks(), { tasks: [], total: 0, activeCount: 0, failedCount: 0 });
});

test('retryMlTask: true si reinició una fila failed', async () => {
  state.responder = () => ({ rows: [], rowCount: 1 });
  assert.equal(await db.retryMlTask(1), true);
});

test('retryMlTask: acepta processing con lock vencido, no processing con lock vivo', async () => {
  let sqlSeen = '';
  state.responder = (sql) => { sqlSeen = sql; return { rows: [], rowCount: 1 }; };
  await db.retryMlTask(1);
  assert.ok(sqlSeen.includes("status = 'failed'"));
  assert.ok(sqlSeen.includes("status = 'processing'"));
  assert.ok(sqlSeen.includes('locked_at <'), 'solo las trabadas: el lock tiene que estar vencido');
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

/* ══════════════ Crear producto: borradores + publicación en background ══════════════ */

test('createProductDraft / getProductDraft: guarda y devuelve el draft parseado', async () => {
  state.responder = (sql, params) => {
    if (sql.startsWith('INSERT INTO product_drafts')) return { rows: [], rowCount: 1 };
    if (sql.startsWith('SELECT id, name, sku, draft_json')) {
      return { rows: [{ id: params[0], name: 'Cuaderno', sku: 'CUA-1', draftJson: JSON.stringify({ common: { sku: 'CUA-1' } }), status: 'draft' }] };
    }
    return { rows: [] };
  };
  const id = await db.createProductDraft({ id: 'd1', name: 'Cuaderno', sku: 'CUA-1', draftJson: '{}' });
  assert.equal(id, 'd1');
  const draft = await db.getProductDraft('d1');
  assert.equal(draft.id, 'd1');
  assert.deepEqual(draft.draft, { common: { sku: 'CUA-1' } });
});

test('getProductDraft: id inexistente → null', async () => {
  state.responder = () => ({ rows: [] });
  assert.equal(await db.getProductDraft('no-existe'), null);
});

test('listProductDrafts: más recientes primero, tope 200', async () => {
  let limitUsed = null;
  state.responder = (sql, params) => { limitUsed = params[0]; return { rows: [{ id: 'd1' }, { id: 'd2' }] }; };
  const list = await db.listProductDrafts(500);
  assert.equal(limitUsed, 200);
  assert.equal(list.length, 2);
});

test('deleteProductDraft: true si borró una fila', async () => {
  state.responder = () => ({ rowCount: 1 });
  assert.equal(await db.deleteProductDraft('d1'), true);
  state.responder = () => ({ rowCount: 0 });
  assert.equal(await db.deleteProductDraft('no-existe'), false);
});

test('createPublishJob: inserta y devuelve el id dado', async () => {
  state.responder = () => ({ rows: [], rowCount: 1 });
  assert.equal(await db.createPublishJob({ id: 'j1', draftId: 'd1', channels: 'ml,tn', payloadJson: '{}' }), 'j1');
});

test('claimNextPublishJob: sin job disponible devuelve null', async () => {
  state.responder = (sql) => (sql.includes('FOR UPDATE SKIP LOCKED') ? { rows: [] } : { rows: [], rowCount: 0 });
  assert.equal(await db.claimNextPublishJob(), null);
});

test('claimNextPublishJob: reclama el job y lo marca processing', async () => {
  const updates = [];
  state.responder = (sql, params) => {
    if (sql.includes('FOR UPDATE SKIP LOCKED')) {
      return { rows: [{ id: 'j1', draftId: 'd1', channels: 'ml,tn', payloadJson: '{}', attempts: 0, status: 'pending' }] };
    }
    if (sql.includes("SET status = 'processing'")) updates.push(params);
    return { rows: [], rowCount: 0 };
  };
  const job = await db.claimNextPublishJob();
  assert.equal(job.id, 'j1');
  assert.equal(updates[0][0], 'j1');
  assert.equal(updates[0][1], 0); // pending: no suma intento
});

test('claimNextPublishJob: recupera un job trabado (processing con lock vencido) y suma un intento', async () => {
  let updateParams = null;
  state.responder = (sql, params) => {
    if (sql.includes('FOR UPDATE SKIP LOCKED')) {
      return { rows: [{ id: 'j2', draftId: 'd1', channels: 'ml', payloadJson: '{}', attempts: 1, status: 'processing' }] };
    }
    if (sql.includes("SET status = 'processing'")) updateParams = params;
    return { rows: [], rowCount: 0 };
  };
  const job = await db.claimNextPublishJob();
  assert.equal(updateParams[1], 1);
  assert.equal(job.attempts, 2);
});

test('claimNextPublishJob: la query también busca processing con lock vencido, con umbral de 5 min', async () => {
  let selectSql = '';
  let umbral = null;
  state.responder = (sql, params) => {
    if (sql.includes('FOR UPDATE SKIP LOCKED')) { selectSql = sql; umbral = params[0]; return { rows: [] }; }
    return { rows: [], rowCount: 0 };
  };
  await db.claimNextPublishJob();
  assert.ok(selectSql.includes("status = 'processing'"));
  assert.equal(umbral, db.PUBLISH_JOB_STALE_LOCK_MS);
  assert.equal(db.PUBLISH_JOB_STALE_LOCK_MS, 5 * 60 * 1000); // 5 min — publicar de verdad tarda más que una tarea de stock
});

test('touchPublishJobLock: refresca el lock solo si sigue processing', async () => {
  state.responder = (sql, params) => ({ rowCount: params[0] === 'j1' ? 1 : 0 });
  assert.equal(await db.touchPublishJobLock('j1'), true);
  assert.equal(await db.touchPublishJobLock('otro'), false);
});

test('finishPublishJob: marca done/error, limpia el lock', async () => {
  const calls = [];
  state.responder = (sql, params) => { calls.push(params); return { rowCount: 1 }; };
  assert.equal(await db.finishPublishJob('j1', 'done'), true);
  assert.equal(calls[0][0], 'done');
});

test('retryPublishJob: solo re-encola un job error o processing con lock vencido', async () => {
  state.responder = () => ({ rowCount: 1 });
  assert.equal(await db.retryPublishJob('j1'), true);
  state.responder = () => ({ rowCount: 0 });
  assert.equal(await db.retryPublishJob('j-vivo'), false);
});

test('cancelPublishJob: cancela pending/processing/error (rowCount>0 → true); un job ya terminado → false', async () => {
  const calls = [];
  state.responder = (sql, params) => { calls.push({ sql, params }); return { rowCount: 1 }; };
  assert.equal(await db.cancelPublishJob('j1'), true);
  assert.match(calls[0].sql, /status = 'cancelled'/);
  assert.match(calls[0].sql, /status IN \('pending', 'processing', 'error'\)/);
  state.responder = () => ({ rowCount: 0 });
  assert.equal(await db.cancelPublishJob('j-done'), false);
});

test('finishPublishJob: no revive un job cancelado (WHERE status <> cancelled)', async () => {
  const calls = [];
  state.responder = (sql, params) => { calls.push(sql); return { rowCount: 1 }; };
  await db.finishPublishJob('j1', 'error', 'boom');
  assert.match(calls[0], /status <> 'cancelled'/);
});

test('finishPublishJob: devuelve false si el UPDATE no tocó ninguna fila (cancelado/inexistente)', async () => {
  state.responder = () => ({ rowCount: 0 });
  assert.equal(await db.finishPublishJob('j1', 'done'), false);
  state.responder = () => ({ rowCount: 1 });
  assert.equal(await db.finishPublishJob('j1', 'done'), true);
});

test('reconcileStalePublishJobs: cierra un job trabado con unidades terminales y marca error los zombis', async () => {
  const updates = [];
  state.responder = (sql, params) => {
    // 1) SELECT de jobs con lock vencido y sin unidades pending
    if (/FROM product_publish_jobs j\s+WHERE j\.status IN \('pending', 'processing'\)/.test(sql)) {
      return { rows: [{ id: 'jA', draftId: 'dA' }] };
    }
    // 2) SELECT status de las unidades de jA → todas ok
    if (sql.startsWith('SELECT status FROM product_publish_units')) {
      return { rows: [{ status: 'ok' }, { status: 'ok' }] };
    }
    // 3) UPDATE que cierra jA
    if (/SET status = \$2/.test(sql) && /WHERE id = \$1 AND status IN \('pending', 'processing'\)/.test(sql)) {
      updates.push({ id: params[0], status: params[1] });
      return { rowCount: 1 };
    }
    // 4) UPDATE de zombis (attempts >= 5) con RETURNING
    if (/status = 'processing' AND attempts >= 5/.test(sql)) {
      return { rows: [{ id: 'jZombi', draftId: 'dZ' }] };
    }
    // recomputeDraftStatus interno
    return { rows: [], rowCount: 1 };
  };
  const closed = await db.reconcileStalePublishJobs();
  assert.equal(closed, 2); // jA + jZombi
  assert.deepEqual(updates, [{ id: 'jA', status: 'done' }]);
});

test('reconcileStalePublishJobs: el SELECT también cierra por fan-out quieto, no solo por lock vencido', async () => {
  // Regresión: antes exigía SOLO lock vencido, y el latido del worker lo renueva hasta 15 min. Un
  // job al que solo le faltó el finishPublishJob final quedaba 5-20 min con el panel en
  // "Publicando…" aunque las publicaciones ya estuvieran creadas. Como acá `pg` está mockeado (el
  // SQL no se evalúa), lo que se verifica es que la condición y su parámetro viajen en la query.
  let selectSql = null;
  let selectParams = null;
  state.responder = (sql, params) => {
    if (/FROM product_publish_jobs j\s+WHERE j\.status IN \('pending', 'processing'\)/.test(sql)) {
      selectSql = sql;
      selectParams = params;
      return { rows: [] };
    }
    return { rows: [], rowCount: 0 };
  };
  await db.reconcileStalePublishJobs();
  assert.ok(selectSql, 'no se ejecutó el SELECT de jobs trabados');
  assert.match(selectSql, /u\.updated_at > NOW\(\) - \(\$2::int \* INTERVAL '1 millisecond'\)/);
  assert.deepEqual(selectParams, [db.PUBLISH_JOB_STALE_LOCK_MS, db.PUBLISH_JOB_SETTLE_MS]);
  // Las dos guardas que hacen que esto sea seguro siguen ahí: tiene unidades y ninguna en 'pending'.
  assert.match(selectSql, /AND EXISTS \(SELECT 1 FROM product_publish_units u WHERE u\.job_id = j\.id\)/);
  assert.match(selectSql, /NOT EXISTS \(SELECT 1 FROM product_publish_units u WHERE u\.job_id = j\.id AND u\.status = 'pending'\)/);
});

test('isPublishJobCancelled: true si la fila existe con status cancelled', async () => {
  state.responder = (sql) => (sql.includes("status = 'cancelled'") ? { rows: [{ '?column?': 1 }] } : { rows: [] });
  assert.equal(await db.isPublishJobCancelled('j1'), true);
  state.responder = () => ({ rows: [] });
  assert.equal(await db.isPublishJobCancelled('j2'), false);
});

test('getPublishJob / listPublishJobsForDraft / deletePublishJob', async () => {
  state.responder = (sql) => {
    if (sql.startsWith('SELECT id, draft_id AS "draftId", channels, payload_json')) {
      return { rows: [{ id: 'j1', draftId: 'd1', channels: 'ml', status: 'done' }] };
    }
    if (sql.startsWith('SELECT id, draft_id AS "draftId", channels, status, attempts')) {
      return { rows: [{ id: 'j1' }, { id: 'j0' }] };
    }
    return { rowCount: 1 };
  };
  const job = await db.getPublishJob('j1');
  assert.equal(job.id, 'j1');
  const list = await db.listPublishJobsForDraft('d1');
  assert.equal(list.length, 2);
  assert.equal(await db.deletePublishJob('j1'), true);
});

test('listPublishJobs: pagina y filtra (status =, canal con LIKE, búsqueda), devuelve { rows, total }', async () => {
  let selectParams = null;
  state.responder = (sql, params) => {
    if (sql.startsWith('SELECT COUNT(*)::int AS total')) return { rows: [{ total: 3 }] };
    if (sql.includes('"unitsOk"') && sql.includes('ORDER BY j.created_at DESC')) {
      selectParams = params;
      return { rows: [{ id: 'j1', draftName: 'Agenda', unitsOk: 2, unitsTotal: 3 }] };
    }
    return { rows: [] };
  };
  const { rows, total } = await db.listPublishJobs(20, 40, { search: 'agenda', status: 'error', channel: 'tn' });
  assert.equal(total, 3);
  assert.equal(rows[0].id, 'j1');
  // params: [ %agenda%, 'error', %tn%, limit(20), offset(40) ]
  assert.deepEqual(selectParams, ['%agenda%', 'error', '%tn%', 20, 40]);
});

test('listPublishJobs: ignora un status inválido y un canal desconocido', async () => {
  let selectParams = null;
  state.responder = (sql, params) => {
    if (sql.startsWith('SELECT COUNT(*)::int AS total')) return { rows: [{ total: 0 }] };
    selectParams = params;
    return { rows: [] };
  };
  await db.listPublishJobs(10, 0, { status: 'lo-que-sea', channel: 'xx' });
  assert.deepEqual(selectParams, [10, 0]); // sin cláusulas de filtro
});

test('upsertPublishUnit / getPublishUnits: registra una unidad y la devuelve en orden', async () => {
  const inserted = [];
  state.responder = (sql, params) => {
    if (sql.startsWith('INSERT INTO product_publish_units')) { inserted.push(params); return { rowCount: 1 }; }
    if (sql.startsWith('SELECT channel, unit_key')) {
      return { rows: [{ channel: 'ml', unitKey: 'CUA-N', seq: 0, status: 'ok', externalId: 'MLA1', detail: 'Publicación MLA1 creada' }] };
    }
    return { rows: [] };
  };
  assert.equal(await db.upsertPublishUnit({ jobId: 'j1', channel: 'ml', unitKey: 'CUA-N', seq: 0, status: 'ok', externalId: 'MLA1', detail: 'ok' }), true);
  assert.equal(inserted[0][0], 'j1');
  const units = await db.getPublishUnits('j1');
  assert.equal(units.length, 1);
  assert.equal(units[0].externalId, 'MLA1');
});

test('recomputeDraftStatus: ambos canales con todas sus unidades ok → published', async () => {
  state.responder = (sql) => {
    if (sql.includes('FROM product_publish_jobs')) return { rows: [{ id: 'j1', channels: 'ml,tn' }] };
    if (sql.includes('FROM product_publish_units')) return { rows: [{ status: 'ok' }] };
    return { rowCount: 1 };
  };
  assert.equal(await db.recomputeDraftStatus('d1'), 'published');
});

test('recomputeDraftStatus: sin ningún job terminado → draft (nunca se intentó publicar)', async () => {
  state.responder = (sql) => (sql.includes('FROM product_publish_jobs') ? { rows: [] } : { rowCount: 1 });
  assert.equal(await db.recomputeDraftStatus('d1'), 'draft');
});

test('recomputeDraftStatus: un canal ok y el otro con error → partial', async () => {
  state.responder = (sql, params) => {
    if (sql.includes('FROM product_publish_jobs')) return { rows: [{ id: 'j1', channels: 'ml,tn' }] };
    if (sql.includes('FROM product_publish_units')) {
      return { rows: params[1] === 'ml' ? [{ status: 'ok' }] : [{ status: 'error' }] };
    }
    return { rowCount: 1 };
  };
  assert.equal(await db.recomputeDraftStatus('d1'), 'partial');
});

test('recomputeDraftStatus: un reintento de un solo canal no pisa lo que ya se sabía del otro (job más reciente por canal, no el último job entero)', async () => {
  // Job viejo: publicó AMBOS canales ok. Job nuevo (reintento): solo TN, y falló.
  // El resultado debe ser 'partial' (ml sigue 'ok' del job viejo), no 'error' (que pisaría ml sin motivo).
  state.responder = (sql, params) => {
    if (sql.includes('FROM product_publish_jobs')) {
      return { rows: [{ id: 'j-nuevo', channels: 'tn' }, { id: 'j-viejo', channels: 'ml,tn' }] };
    }
    if (sql.includes('FROM product_publish_units')) {
      if (params[0] === 'j-nuevo') return { rows: [{ status: 'error' }] }; // tn del job nuevo: error
      return { rows: [{ status: 'ok' }] }; // ml (y tn) del job viejo: ok — pero tn ya se resolvió con el nuevo
    }
    return { rowCount: 1 };
  };
  assert.equal(await db.recomputeDraftStatus('d1'), 'partial');
});

test('recomputeDraftStatus: ambos con error → error', async () => {
  state.responder = (sql) => {
    if (sql.includes('FROM product_publish_jobs')) return { rows: [{ id: 'j1', channels: 'ml,tn' }] };
    if (sql.includes('FROM product_publish_units')) return { rows: [{ status: 'error' }] };
    return { rowCount: 1 };
  };
  assert.equal(await db.recomputeDraftStatus('d1'), 'error');
});
