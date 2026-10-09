/**
 * Tests de routes/orders.js + ordersService.js por HTTP, con db.js mockeado en memoria (mismo
 * patrón que routesDeposito.test.js). Cubre el ciclo borrador → pendiente → recibido, los 409 de
 * editar/borrar/recibir fuera de estado, la recepción incompleta, duplicar (todo / faltantes /
 * "repetir y marcar como pedido") y que los descuentos por defecto salgan de la configuración.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mock } from 'node:test';

const db = { orders: new Map(), nextId: 1, nextLineId: 1, defaults: { discount1: 25, discount2: 5 }, cutoffSets: 0, packs: [], costs: [] };

function reset() {
  db.orders = new Map();
  db.nextId = 1;
  db.nextLineId = 1;
  db.defaults = { discount1: 25, discount2: 5 };
  db.cutoffSets = 0;
  db.packs = [{ id: 7, name: 'Cuadernos', sku: 'PK', unitCount: 8, mode: 'assorted', skus: ['A'] }];
  db.costs = [{ sku: 'A', bulkPrice: 80000, bulkQty: 8 }];
}

const clone = (o) => (o ? JSON.parse(JSON.stringify(o)) : null);
const withIds = (lines) => lines.map((l) => ({ receivedQty: null, ...l, id: db.nextLineId++ }));

before(async () => {
  const noop = async () => {};
  mock.module('../src/db.js', {
    exports: {
      // alertsService (importado por ordersService)
      listStockAlerts: async () => [], setStockAlertState: noop, insertStockNotification: noop,
      listStockNotifications: async () => ({ rows: [], total: 0 }), countUnreadNotifications: async () => 0,
      getRestockCutoff: async () => null, listRestockCandidates: async () => [],
      listRestockOverrides: async () => new Map(), setRestockOverride: noop, clearRestockOverrides: noop,
      listRestockDismissed: async () => new Map(), setRestockDismissed: noop, clearRestockDismissed: noop,
      getDepositoStockBySku: async () => new Map(),
      setRestockCutoff: async () => { db.cutoffSets++; return true; },
      listPacks: async () => db.packs,
      getAnalysisSnapshot: async () => ({ data: { mlRows: [{ sku: 'A', title: 'Cuaderno', stock: 1 }], tnRows: [] } }),
      getAllProductCosts: async () => db.costs,
      getSkuCodeMap: async () => [], getPackCodeMap: async () => [], getSupplierCodeDescriptions: async () => new Map(),
      getOrderDefaults: async () => ({ ...db.defaults }),
      setOrderDefaults: async (v) => { db.defaults = v; return true; },
      listSupplierOrders: async ({ status } = {}) => [...db.orders.values()].filter((o) => !status || o.status === status).reverse().map(clone),
      getSupplierOrder: async (id) => clone(db.orders.get(id)),
      createSupplierOrder: async ({ name, status = 'borrador', discount1, discount2, note = '', basedOnId = null, lines = [] }) => {
        const o = { id: db.nextId++, name, status, partial: false, discount1, discount2, note, basedOnId, createdAt: 'now', orderedAt: status === 'pendiente' ? 'now' : null, lines: withIds(lines) };
        db.orders.set(o.id, o);
        return clone(o);
      },
      updateSupplierOrderDraft: async (id, v) => {
        const o = db.orders.get(id);
        if (!o) return 'not_found';
        if (o.status !== 'borrador') return 'not_draft';
        Object.assign(o, { name: v.name, note: v.note, discount1: v.discount1, discount2: v.discount2, lines: withIds(v.lines) });
        return clone(o);
      },
      placeSupplierOrder: async (id) => {
        const o = db.orders.get(id);
        if (!o || o.status !== 'borrador') return false;
        o.status = 'pendiente';
        return true;
      },
      receiveSupplierOrder: async (id, received, { close }) => {
        const o = db.orders.get(id);
        if (!o) return 'not_found';
        if (o.status !== 'pendiente') return 'not_pending';
        for (const l of o.lines) if (String(l.id) in received) l.receivedQty = received[String(l.id)];
        if (close) {
          for (const l of o.lines) l.receivedQty ??= 0;
          o.partial = o.lines.some((l) => l.receivedQty < l.qty);
          o.status = 'recibido';
        }
        return clone(o);
      },
      deleteSupplierOrderDraft: async (id) => {
        const o = db.orders.get(id);
        if (!o || o.status !== 'borrador') return false;
        db.orders.delete(id);
        return true;
      },
    },
  });

  const { ordersRoutes } = await import('../src/routes/orders.js');
  const app = express();
  app.use(express.json());
  app.use('/api/orders', ordersRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/orders`;
});

let server, baseUrl;
after(() => { server.close(); });
beforeEach(reset);

const call = async (method, path, body) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

const draftBody = (lines) => ({ name: 'Pedido octubre', note: '', discount1: 25, discount2: 5, lines });
const PACK_LINE = { kind: 'pack', packId: 7, qty: 2, code: 'PK', description: 'Cuadernos', unitPrice: 80000, priceSource: 'precios', unitsPerPack: 8, origin: 'alerta' };

test('POST /: crea un borrador con los descuentos por defecto configurados', async () => {
  await call('PUT', '/settings', { discount1: 30, discount2: 0 });
  const { status, body } = await call('POST', '/', {});
  assert.equal(status, 201);
  assert.equal(body.order.status, 'borrador');
  assert.equal(body.order.discount1, 30);
  assert.equal(body.order.discount2, 0);
});

test('PUT /settings: rechaza descuentos fuera de rango', async () => {
  const { status } = await call('PUT', '/settings', { discount1: 101, discount2: 5 });
  assert.equal(status, 400);
});

test('ciclo completo: guardar borrador → marcar como pedido (corre el corte) → ya no se edita ni se borra', async () => {
  const { body: created } = await call('POST', '/', {});
  const id = created.order.id;

  const saved = await call('PUT', `/${id}`, draftBody([PACK_LINE, { kind: 'free', qty: 1, code: '5520', description: 'Planner', unitPrice: 42000 }]));
  assert.equal(saved.status, 200);
  assert.equal(saved.body.order.totals.subtotal, 202000);
  assert.equal(saved.body.order.totals.total, 143925); // 202000 × 0,75 × 0,95

  const placed = await call('POST', `/${id}/place`);
  assert.equal(placed.status, 200);
  assert.equal(placed.body.order.status, 'pendiente');
  assert.equal(db.cutoffSets, 1);

  assert.equal((await call('PUT', `/${id}`, draftBody([PACK_LINE]))).status, 409);
  assert.equal((await call('DELETE', `/${id}`)).status, 409);
  assert.equal((await call('POST', `/${id}/place`)).status, 409);
});

test('PUT /:id: valida las líneas (400) y 404 si no existe', async () => {
  const { body } = await call('POST', '/', {});
  assert.equal((await call('PUT', `/${body.order.id}`, draftBody([{ kind: 'pack', qty: 1 }]))).status, 400);
  assert.equal((await call('PUT', '/999', draftBody([]))).status, 404);
});

test('GET /:id de un borrador: las líneas "de Precios" toman el precio de hoy, las editadas no', async () => {
  const { body } = await call('POST', '/', {});
  const id = body.order.id;
  await call('PUT', `/${id}`, draftBody([PACK_LINE, { ...PACK_LINE, unitPrice: 1234, priceSource: 'manual' }]));
  db.costs = [{ sku: 'A', bulkPrice: 88000, bulkQty: 8 }];
  const { body: got } = await call('GET', `/${id}`);
  assert.deepEqual(got.order.lines.map((l) => l.unitPrice), [88000, 1234]);
});

test('recepción: guardar parcial, cerrar incompleto, y pasar lo que faltó a un borrador', async () => {
  const { body } = await call('POST', '/', {});
  const id = body.order.id;
  const { body: saved } = await call('PUT', `/${id}`, draftBody([PACK_LINE, { ...PACK_LINE, packId: 8, qty: 3 }]));
  const [l1, l2] = saved.order.lines;

  assert.equal((await call('PUT', `/${id}/receive`, { received: {} })).status, 409, 'un borrador no se recibe');
  await call('POST', `/${id}/place`);
  assert.equal((await call('PUT', `/${id}/receive`, { received: { [l1.id]: -1 } })).status, 400);

  const partial = await call('PUT', `/${id}/receive`, { received: { [l1.id]: 2 } });
  assert.equal(partial.body.order.status, 'pendiente', 'sin close solo guarda lo anotado');

  const closed = await call('PUT', `/${id}/receive`, { received: { [l2.id]: 1 }, close: true });
  assert.equal(closed.body.order.status, 'recibido');
  assert.equal(closed.body.order.partial, true);

  const missing = await call('POST', `/${id}/duplicate`, { mode: 'missing' });
  assert.equal(missing.status, 201);
  assert.equal(missing.body.order.name, 'Faltantes de Pedido octubre');
  assert.equal(missing.body.order.status, 'borrador');
  assert.deepEqual(missing.body.order.lines.map((l) => l.qty), [2]);
});

test('duplicate: copia como borrador, o "repetir y marcar como pedido" (pendiente + corte)', async () => {
  const { body } = await call('POST', '/', {});
  const id = body.order.id;
  await call('PUT', `/${id}`, draftBody([PACK_LINE]));

  const dup = await call('POST', `/${id}/duplicate`, {});
  assert.equal(dup.body.order.status, 'borrador');
  assert.equal(dup.body.order.basedOnId, id);
  assert.equal(dup.body.order.lines[0].origin, 'copia');
  assert.equal(db.cutoffSets, 0);

  const rep = await call('POST', `/${id}/duplicate`, { status: 'pendiente' });
  assert.equal(rep.body.order.status, 'pendiente');
  assert.equal(db.cutoffSets, 1);

  assert.equal((await call('POST', '/999/duplicate', {})).status, 404);
});

test('GET /: lista con totales y filtro por estado; DELETE borra un borrador', async () => {
  const a = (await call('POST', '/', {})).body.order.id;
  const b = (await call('POST', '/', {})).body.order.id;
  await call('POST', `/${b}/place`);
  const all = await call('GET', '/');
  assert.equal(all.body.orders.length, 2);
  assert.ok(all.body.orders[0].totals);
  const drafts = await call('GET', '/?status=borrador');
  assert.deepEqual(drafts.body.orders.map((o) => o.id), [a]);
  assert.equal((await call('DELETE', `/${a}`)).status, 200);
  assert.equal((await call('GET', `/${a}`)).status, 404);
});

test('GET /catalog: devuelve las unidades de compra', async () => {
  const { status, body } = await call('GET', '/catalog');
  assert.equal(status, 200);
  assert.equal(body.units[0].key, 'pack:7');
  assert.equal(body.units[0].price, 80000);
});
