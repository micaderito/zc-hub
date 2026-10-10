/**
 * Tests de services/dispatchService.js ("Para despachar"): qué paquetes de ML/TN se muestran, en
 * qué parte de la página (atrasado / hoy / próximos días / cancelado) y con qué estado. Mockea los
 * clientes de ML/TN, store y db — sin red ni base.
 */
import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const state = {
  orders: [],
  shipments: {},
  slas: {},
  items: [],
  tnByShipping: { unpacked: [], unfulfilled: [] },
  tnCancelled: [],
  marks: new Map(),
  mlThrows: null,
  calls: { getShipment: [], getShipmentSla: [], getItems: [] },
};

let svc;
before(async () => {
  mock.module('../src/lib/mercadolibre.js', {
    exports: {
      getOrdersWindow: async () => {
        if (state.mlThrows) throw state.mlThrows;
        return state.orders;
      },
      getShipment: async (_t, id) => {
        state.calls.getShipment.push(id);
        return state.shipments[id] ?? null;
      },
      getShipmentSla: async (_t, id) => {
        state.calls.getShipmentSla.push(id);
        return state.slas[id] ?? null;
      },
      getItems: async (_t, ids) => {
        state.calls.getItems.push(ids);
        return state.items;
      },
    },
  });
  mock.module('../src/lib/tiendanube.js', {
    exports: {
      listOrders: async (_t, _s, params) => {
        if (params.status === 'cancelled') return state.tnCancelled;
        return state.tnByShipping[params.shipping_status] ?? [];
      },
    },
  });
  mock.module('../src/store.js', {
    exports: {
      tokens: { mercadolibre: { user_id: 1 }, tiendanube: { access_token: 'tn', store_id: '9' } },
      getMlToken: async () => 'ml',
    },
  });
  mock.module('../src/db.js', {
    exports: { getDispatchMarks: async () => state.marks },
  });
  svc = await import('../src/services/dispatchService.js');
});

beforeEach(() => {
  state.orders = [];
  state.shipments = {};
  state.slas = {};
  state.items = [];
  state.tnByShipping = { unpacked: [], unfulfilled: [] };
  state.tnCancelled = [];
  state.marks = new Map();
  state.mlThrows = null;
  state.calls = { getShipment: [], getShipmentSla: [], getItems: [] };
  svc._resetDispatchCache();
});

// Jueves 9/10/2026 10:00 en Argentina (13:00 UTC).
const NOW = new Date('2026-10-09T13:00:00.000Z');

function mlOrder(id, { packId = null, shipId = 500, status = 'paid', items = [{ id: 'MLA1', sku: 'S1', qty: 1 }], ...rest } = {}) {
  return {
    id,
    pack_id: packId,
    status,
    date_created: '2026-10-08T15:00:00.000Z',
    buyer: { nickname: 'COMPRADORA' },
    shipping: shipId ? { id: shipId } : {},
    payments: [{ status: 'approved', date_approved: '2026-10-08T15:01:00.000Z' }],
    order_items: items.map((it) => ({
      item: { id: it.id, title: `Título ${it.sku}`, seller_sku: it.sku, variation_id: it.variationId ?? null, variation_attributes: it.attrs ?? [] },
      quantity: it.qty,
    })),
    ...rest,
  };
}

function shipment(id, { status = 'ready_to_ship', substatus = 'ready_to_print', logistic = 'drop_off', leadTime = {} } = {}) {
  return { id, status, substatus, logistic: { type: logistic }, lead_time: leadTime, destination: { shipping_address: { city: { name: 'Córdoba' } } } };
}

// ── funciones puras ──────────────────────────────────────────────────────────

test('isPendingShipment: handling y ready_to_ship sí; despachado y Full no', () => {
  assert.equal(svc.isPendingShipment(shipment(1, { status: 'handling' })), true);
  assert.equal(svc.isPendingShipment(shipment(1)), true);
  assert.equal(svc.isPendingShipment(shipment(1, { status: 'shipped' })), false);
  assert.equal(svc.isPendingShipment(shipment(1, { logistic: 'fulfillment' })), false);
  assert.equal(svc.isPendingShipment({ status: 'ready_to_ship', logistic_type: 'fulfillment' }), false);
  assert.equal(svc.isPendingShipment(null), false);
});

test('bucketFor: atrasado, hoy, próximos días y en espera', () => {
  const at = (iso) => new Date(iso);
  // Hoy 13:00 AR (16:00 UTC), son las 10:00 → hoy.
  assert.equal(svc.bucketFor({ deadline: at('2026-10-09T16:00:00Z'), deadlineHasTime: true }, NOW), 'today');
  // Hoy 9:00 AR, ya pasó → atrasado aunque sea el mismo día.
  assert.equal(svc.bucketFor({ deadline: at('2026-10-09T12:00:00Z'), deadlineHasTime: true }, NOW), 'overdue');
  // Ayer → atrasado.
  assert.equal(svc.bucketFor({ deadline: at('2026-10-08T16:00:00Z'), deadlineHasTime: true }, NOW), 'overdue');
  // ML dice delayed → atrasado.
  assert.equal(svc.bucketFor({ deadline: at('2026-10-09T16:00:00Z'), deadlineHasTime: true, slaStatus: 'delayed' }, NOW), 'overdue');
  // Mañana → próximos días.
  assert.equal(svc.bucketFor({ deadline: at('2026-10-10T16:00:00Z'), deadlineHasTime: true }, NOW), 'upcoming');
  // Solo fecha (sin hora): hoy a la medianoche UTC no vence a la mañana.
  assert.equal(svc.bucketFor({ deadline: at('2026-10-09T03:00:00Z'), deadlineHasTime: false }, NOW), 'today');
  // En espera hasta mañana → próximos días aunque el límite viejo sea hoy.
  assert.equal(svc.bucketFor({ deadline: at('2026-10-09T16:00:00Z'), deadlineHasTime: true, bufferedUntil: at('2026-10-10T11:00:00Z') }, NOW), 'upcoming');
  // Sin límite → hoy (mejor de más que escondido).
  assert.equal(svc.bucketFor({ deadline: null }, NOW), 'today');
});

test('arDayKey usa hora argentina, no UTC', () => {
  // 01:00 UTC del 10 = 22:00 del 9 en Argentina.
  assert.equal(svc.arDayKey(new Date('2026-10-10T01:00:00Z')), '2026-10-09');
});

test('stateLabel: estados de ML y TN', () => {
  assert.equal(svc.stateLabel({ channel: 'ml', shipStatus: 'ready_to_ship', substatus: 'ready_to_print', bucket: 'today' }).label, 'Imprimir etiqueta');
  assert.equal(svc.stateLabel({ channel: 'ml', shipStatus: 'ready_to_ship', substatus: 'printed', bucket: 'today' }).label, 'Etiqueta impresa');
  assert.equal(svc.stateLabel({ channel: 'ml', shipStatus: 'handling', substatus: null, bucket: 'today' }).label, 'Preparando etiqueta');
  assert.deepEqual(svc.stateLabel({ channel: 'ml', shipStatus: 'ready_to_ship', substatus: 'printed', bucket: 'overdue' }), { label: 'Atrasado', tone: 'err' });
  assert.equal(
    svc.stateLabel({ channel: 'ml', shipStatus: 'ready_to_ship', substatus: 'buffered', bufferedUntil: '2026-10-10T12:00:00Z', bucket: 'upcoming' }).label,
    'En espera hasta el 10/10'
  );
  assert.equal(svc.stateLabel({ channel: 'tn', shipStatus: 'unpacked' }).label, 'Sin empaquetar');
  assert.equal(svc.stateLabel({ channel: 'tn', shipStatus: 'unshipped' }).label, 'Empaquetado, sin enviar');
  assert.equal(svc.stateLabel({ channel: 'tn', cancelled: true }).tone, 'err');
});

test('mlPicturesFor: fotos de la variación en su orden, si no las del ítem', () => {
  const item = {
    pictures: [{ id: 'a', secure_url: 'https://x/a-O.jpg' }, { id: 'b', secure_url: 'https://x/b-O.jpg' }, { id: 'c', secure_url: 'https://x/c-O.jpg' }],
    variations: [{ id: 7, picture_ids: ['c', 'a'] }],
  };
  assert.deepEqual(svc.mlPicturesFor(item, 7), ['https://x/c-O.jpg', 'https://x/a-O.jpg']);
  assert.deepEqual(svc.mlPicturesFor(item, null), ['https://x/a-O.jpg', 'https://x/b-O.jpg', 'https://x/c-O.jpg']);
  assert.equal(svc.mlThumbFromUrl('https://x/a-O.jpg'), 'https://x/a-I.jpg');
});

// ── getDispatchList ──────────────────────────────────────────────────────────

test('un carrito de ML es un solo paquete con todos sus productos y el horario del SLA', async () => {
  state.orders = [
    mlOrder(1, { packId: 900, items: [{ id: 'MLA1', sku: 'S1', qty: 2 }] }),
    mlOrder(2, { packId: 900, items: [{ id: 'MLA2', sku: 'S2', qty: 1 }] }),
  ];
  state.shipments = { 500: shipment(500) };
  state.slas = { 500: { status: 'on_time', expected_date: '2026-10-09T13:00:00.000-03:00' } };
  state.items = [{ id: 'MLA1', pictures: [{ id: 'p', secure_url: 'https://x/p-O.jpg' }] }];

  const r = await svc.getDispatchList({ now: NOW });
  assert.equal(r.packages.length, 1);
  const pkg = r.packages[0];
  assert.equal(pkg.saleId, '900');
  assert.deepEqual(pkg.orderIds, ['1', '2']);
  assert.equal(pkg.items.length, 2);
  assert.equal(pkg.items[0].qty, 2);
  assert.deepEqual(pkg.items[0].pictures, ['https://x/p-O.jpg']);
  assert.equal(pkg.items[0].thumb, 'https://x/p-I.jpg');
  assert.equal(pkg.bucket, 'today');
  assert.equal(pkg.deadlineHasTime, true);
  assert.equal(pkg.state.label, 'Imprimir etiqueta');
  assert.equal(pkg.city, 'Córdoba');
  // Un solo envío consultado para las dos órdenes del carrito.
  assert.deepEqual(state.calls.getShipment, ['500']);
});

test('despachados, Full y entregados no aparecen; el envío despachado se memoriza', async () => {
  state.orders = [
    mlOrder(1, { shipId: 501 }),
    mlOrder(2, { shipId: 502 }),
    mlOrder(3, { shipId: 503, tags: ['delivered'] }),
  ];
  state.shipments = { 501: shipment(501, { status: 'shipped', substatus: null }), 502: shipment(502, { logistic: 'fulfillment' }) };
  let r = await svc.getDispatchList({ now: NOW });
  assert.equal(r.packages.length, 0);
  assert.deepEqual(state.calls.getShipment.sort(), ['501', '502']);
  assert.deepEqual(state.calls.getShipmentSla, []);

  state.calls.getShipment = [];
  r = await svc.getDispatchList({ now: NOW, refresh: true });
  assert.deepEqual(state.calls.getShipment, ['502'], 'el despachado no se vuelve a pedir');
});

test('mlDispatchInfo: entregado en el punto (ready_to_ship) o shipped, con la hora de la entrega', () => {
  assert.deepEqual(svc.mlDispatchInfo(shipment(1, { substatus: 'printed' })), { dispatched: false, dispatchedAt: null });
  const dropped = {
    ...shipment(1, { substatus: 'dropped_off' }),
    substatus_history: [
      { status: 'ready_to_ship', substatus: 'printed', date: '2026-10-08T10:00:00.000-03:00' },
      { status: 'ready_to_ship', substatus: 'dropped_off', date: '2026-10-08T17:01:00.000-03:00' },
      { status: 'ready_to_ship', substatus: 'in_hub', date: '2026-10-08T18:00:00.000-03:00' },
    ],
  };
  const info = svc.mlDispatchInfo(dropped);
  assert.equal(info.dispatched, true);
  assert.equal(info.dispatchedAt.toISOString(), '2026-10-08T20:01:00.000Z');
  assert.equal(svc.isPendingShipment(dropped), false, 'ya entregado: no es pendiente');
  const shipped = { ...shipment(2, { status: 'shipped', substatus: null }), status_history: { date_shipped: '2026-10-09T09:30:00.000-03:00' } };
  assert.equal(svc.mlDispatchInfo(shipped).dispatchedAt.toISOString(), '2026-10-09T12:30:00.000Z');
  assert.equal(svc.mlDispatchInfo(shipment(3, { substatus: 'in_hub' })).dispatchedAt, null);
});

test('stateLabel: despachado con la hora', () => {
  assert.deepEqual(
    svc.stateLabel({ channel: 'ml', bucket: 'dispatched', dispatchedAt: '2026-10-09T20:01:00.000Z' }),
    { label: 'Despachado 17:01', tone: 'ok' }
  );
  assert.equal(svc.stateLabel({ channel: 'ml', bucket: 'dispatched', dispatchedAt: null }).label, 'Despachado');
});

test('entregado en el punto con el horario vencido → "despachado", no atrasado; sin pedir el SLA', async () => {
  state.orders = [mlOrder(1, { shipId: 501 }), mlOrder(2, { shipId: 502 })];
  state.shipments = {
    501: { ...shipment(501, { substatus: 'dropped_off' }), substatus_history: [{ substatus: 'dropped_off', date: '2026-10-09T09:15:00.000-03:00' }] },
    502: shipment(502, { substatus: 'printed' }),
  };
  state.slas = { 502: { status: 'delayed', expected_date: '2026-10-08T16:00:00.000-03:00' } };
  state.items = [{ id: 'MLA1', pictures: [{ id: 'p', secure_url: 'https://x/p-O.jpg' }] }];
  const r = await svc.getDispatchList({ now: NOW });
  const bySale = Object.fromEntries(r.packages.map((p) => [p.saleId, p]));
  assert.equal(bySale['1'].bucket, 'dispatched');
  assert.equal(bySale['1'].state.label, 'Despachado 09:15');
  assert.deepEqual(bySale['1'].items[0].pictures, ['https://x/p-O.jpg'], 'trae las fotos igual');
  assert.equal(bySale['2'].bucket, 'overdue', 'vencido y sin entregar sigue atrasado');
  assert.deepEqual(state.calls.getShipmentSla, ['502']);
});

test('despachados de días anteriores no aparecen; los de hoy sí', async () => {
  state.orders = [mlOrder(1, { shipId: 501 }), mlOrder(2, { shipId: 502 }), mlOrder(3, { shipId: 503 })];
  state.shipments = {
    501: { ...shipment(501, { status: 'shipped', substatus: null }), status_history: { date_shipped: '2026-10-09T08:00:00.000-03:00' } },
    502: { ...shipment(502, { status: 'shipped', substatus: null }), status_history: { date_shipped: '2026-10-08T17:00:00.000-03:00' } },
    // Sigue en el punto pero ML no da la fecha: se muestra (es reciente).
    503: shipment(503, { substatus: 'in_hub' }),
  };
  const r = await svc.getDispatchList({ now: NOW });
  assert.deepEqual(r.packages.map((p) => [p.saleId, p.bucket]).sort(), [['1', 'dispatched'], ['3', 'dispatched']]);
});

test('datos reales de la cuenta: in_packing_list con drop off = despachado; pending/buffered = próximos días', async () => {
  state.orders = [mlOrder(1, { shipId: 501 }), mlOrder(2, { shipId: 502 }), mlOrder(3, { shipId: 503 }), mlOrder(4, { shipId: 504 })];
  state.shipments = {
    // Lo dejó en el punto ayer a la tarde y ML todavía no lo marcó "shipped".
    501: { ...shipment(501, { substatus: 'in_packing_list', logistic: 'xd_drop_off' }), substatus_history: [{ substatus: 'in_packing_list', date: '2026-10-09T08:40:00.000-03:00' }] },
    // En Colecta, in_packing_list es "entró en la lista de retiro": sigue pendiente.
    502: shipment(502, { substatus: 'in_packing_list', logistic: 'cross_docking' }),
    // "Despachá el lunes": la etiqueta todavía no se puede imprimir.
    503: shipment(503, { status: 'pending', substatus: 'buffered', logistic: 'xd_drop_off', leadTime: { buffering: { date: '2026-10-12T00:00:00.000-03:00' } } }),
    // Pendiente por otra cosa (no es "en espera de fecha"): no se muestra.
    504: shipment(504, { status: 'pending', substatus: 'creating_route' }),
  };
  state.slas = {
    502: { status: 'on_time', expected_date: '2026-10-09T16:00:00.000-03:00' },
    503: { status: 'on_time', expected_date: '2026-10-12T16:00:00.000-03:00' },
  };
  const r = await svc.getDispatchList({ now: NOW });
  const bySale = Object.fromEntries(r.packages.map((p) => [p.saleId, p]));
  assert.equal(bySale['1'].bucket, 'dispatched');
  assert.equal(bySale['2'].bucket, 'today');
  assert.equal(bySale['3'].bucket, 'upcoming');
  assert.equal(bySale['3'].bufferedDay, '2026-10-12');
  assert.equal(bySale['4'], undefined);
  assert.deepEqual(state.calls.getShipmentSla.sort(), ['502', '503']);
});

test('bucketFor: en espera sin fecha conocida va a próximos días, no a hoy', () => {
  assert.equal(svc.bucketFor({ deadline: null, buffered: true, bufferedUntil: null }, NOW), 'upcoming');
});

test('"Despachá el X día" (buffered) va a próximos días', async () => {
  state.orders = [mlOrder(1)];
  state.shipments = { 500: shipment(500, { substatus: 'buffered', leadTime: { buffering: { date: '2026-10-12T00:00:00.000-03:00' } } }) };
  state.slas = { 500: { status: 'on_time', expected_date: '2026-10-12T13:00:00.000-03:00' } };
  const r = await svc.getDispatchList({ now: NOW });
  assert.equal(r.packages[0].bucket, 'upcoming');
  assert.equal(r.packages[0].bufferedDay, '2026-10-12');
  assert.match(r.packages[0].state.label, /En espera hasta el 12\/10/);
});

test('cancelada recién y nunca despachada → aviso "no despachar"; un pago rechazado no', async () => {
  state.orders = [
    mlOrder(1, { status: 'cancelled', shipId: 510, date_last_updated: '2026-10-09T12:00:00.000Z' }),
    mlOrder(2, { status: 'cancelled', shipId: 511, date_last_updated: '2026-10-09T12:00:00.000Z', payments: [{ status: 'rejected' }] }),
    mlOrder(3, { status: 'cancelled', shipId: 512, date_last_updated: '2026-10-01T12:00:00.000Z' }),
  ];
  state.shipments = { 510: shipment(510, { status: 'cancelled', substatus: null }) };
  const r = await svc.getDispatchList({ now: NOW });
  assert.equal(r.packages.length, 1);
  assert.equal(r.packages[0].saleId, '1');
  assert.equal(r.packages[0].bucket, 'cancelled');
  assert.equal(r.packages[0].state.label, 'Cancelado');
});

test('un cancelado con "Entendido" ya no se muestra; preparados van al final', async () => {
  state.orders = [
    mlOrder(1, { status: 'cancelled', shipId: null, date_last_updated: '2026-10-09T12:00:00.000Z' }),
    mlOrder(2, { shipId: 520 }),
    mlOrder(3, { shipId: 521 }),
  ];
  state.shipments = { 520: shipment(520), 521: shipment(521) };
  state.slas = {
    520: { status: 'on_time', expected_date: '2026-10-09T12:00:00.000-03:00' },
    521: { status: 'on_time', expected_date: '2026-10-09T13:00:00.000-03:00' },
  };
  state.marks = new Map([
    ['ml:1', { cancelSeenAt: '2026-10-09T12:30:00.000Z' }],
    ['ml:2', { preparedAt: '2026-10-09T12:40:00.000Z', preparedBy: 'mica' }],
  ]);
  const r = await svc.getDispatchList({ now: NOW });
  assert.deepEqual(r.packages.map((p) => p.saleId), ['3', '2']);
  assert.equal(r.packages[1].preparedBy, 'mica');
});

test('TN: pagadas sin enviar (sin duplicar entre filtros) y canceladas recientes', async () => {
  const open = (id, shipping) => ({
    id, number: 1000 + id, status: 'open', payment_status: 'paid', shipping_status: shipping,
    contact_name: 'María', shipping_address: { city: 'Rosario' }, shipping_option: 'Correo Argentino',
    shipping_pickup_type: 'ship', paid_at: '2026-10-08T20:00:00Z',
    products: [{ name: 'Planner', sku: 'PLN', quantity: 1, variant_values: ['Azul'], image: { src: 'http://cdn/x.jpg' } }],
  });
  state.tnByShipping = { unpacked: [open(1, 'unpacked')], unfulfilled: [open(1, 'unpacked'), open(2, 'unshipped'), open(3, 'shipped')] };
  state.tnCancelled = [
    { ...open(4, 'unpacked'), status: 'cancelled', payment_status: 'refunded' },
    { ...open(5, 'unpacked'), status: 'cancelled', payment_status: 'pending' },
  ];
  const r = await svc.getDispatchList({ now: NOW });
  const tn = r.packages.filter((p) => p.channel === 'tn');
  assert.deepEqual(tn.map((p) => p.saleId).sort(), ['1', '2', '4']);
  const p1 = tn.find((p) => p.saleId === '1');
  assert.equal(p1.orderNumber, '1001');
  assert.equal(p1.items[0].variation, 'Azul');
  assert.equal(p1.items[0].thumb, 'https://cdn/x.jpg');
  assert.equal(p1.shippingMethod, 'Correo Argentino');
  assert.equal(p1.state.label, 'Sin empaquetar');
  assert.equal(tn.find((p) => p.saleId === '4').bucket, 'cancelled');
});

test('si ML falla, TN se devuelve igual con el error de ML', async () => {
  state.mlThrows = Object.assign(new Error('429'), { statusCode: 429 });
  state.tnByShipping = { unpacked: [{ id: 1, status: 'open', payment_status: 'paid', shipping_status: 'unpacked', products: [] }], unfulfilled: [] };
  const r = await svc.getDispatchList({ now: NOW });
  assert.equal(r.packages.length, 1);
  assert.match(r.errors.ml, /no contestó/);
  assert.equal(r.errors.tn, undefined);
});

test('caché de 60 s: la segunda visita no le pega a ML, refresh sí', async () => {
  state.orders = [mlOrder(1)];
  state.shipments = { 500: shipment(500) };
  await svc.getDispatchList({ now: NOW });
  await svc.getDispatchList({ now: new Date(NOW.getTime() + 30_000) });
  assert.equal(state.calls.getShipment.length, 1);
  await svc.getDispatchList({ now: new Date(NOW.getTime() + 30_000), refresh: true });
  assert.equal(state.calls.getShipment.length, 2);
});
