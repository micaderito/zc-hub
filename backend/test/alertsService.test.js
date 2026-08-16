/**
 * Tests de alertsService.js (ver CLAUDE.md → "Alertas de stock bajo" y el plan en
 * ~/.claude/plans/quiero-poder-configurar-alertas-rippling-glade.md).
 *
 * Cubre:
 * 1) evaluateStockAlerts: histéresis (no repite mientras sigue bajo, se re-arma al subir), min(ML,TN)
 *    con variantes, SKU sin filas en ningún canal, regla nueva con stock ya bajo, muted_until vigente.
 * 2) getRestockList: colapsa varios disparos del mismo SKU en una fila, "Marcar pedido como hecho"
 *    vacía la lista sin borrar el historial, y un SKU que se repuso solo queda en 'restocked'.
 * 3) computeSuggestedQty/computePackSuggestedQty: sin pack sugiere unidades sueltas hasta el
 *    umbral; con pack la sugerencia es del pack completo (el modelo con menos stock manda), y los
 *    ajustes manuales (restock_order_overrides) pisan lo calculado y se limpian al cerrar el período.
 *
 * Mockeamos '../src/db.js' con un estado en memoria (mismo patrón que syncService.test.js) — no
 * hay Postgres real. `setStockAlertState` implementa el UPDATE condicional real (con `expectedState`)
 * para poder testear que la histéresis usa esa condición.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';

const dbState = {
  rules: new Map(),
  notifications: [],
  notifId: 1,
  restockCutoff: null,
  packs: [],
  snapshot: null,
  clock: 0,
  overrides: new Map(),
};

function resetDbState() {
  dbState.rules = new Map();
  dbState.notifications = [];
  dbState.notifId = 1;
  dbState.restockCutoff = null;
  dbState.packs = [];
  dbState.snapshot = null;
  dbState.clock = Date.parse('2026-01-01T00:00:00.000Z');
  dbState.overrides = new Map();
}

/**
 * Reloj falso, monotónico: cada llamada avanza un segundo y devuelve el ISO resultante. Evita que
 * los tests de "Para reponer" (que comparan `created_at` contra un corte) sean flaky por coincidir
 * en el mismo milisegundo real — acá el orden de las llamadas es lo único que importa.
 */
function tick() {
  dbState.clock += 1000;
  return new Date(dbState.clock).toISOString();
}

function makeSnapshot({ mlRows = [], tnRows = [] } = {}) {
  return { at: Date.now(), data: { mlRows, tnRows, mlConnected: true, tnConnected: true, mlAuthError: false } };
}

let alertsService;
before(async () => {
  mock.module('../src/db.js', {
    exports: {
      listStockAlerts: async () => [...dbState.rules.values()].map((r) => ({ ...r })),
      setStockAlertState: async (sku, state, { expectedState } = {}) => {
        const r = dbState.rules.get(sku);
        if (!r) return false;
        if (expectedState != null && r.state !== expectedState) return false;
        r.state = state;
        return true;
      },
      insertStockNotification: async (row) => {
        dbState.notifications.push({
          id: dbState.notifId++,
          readAt: null,
          createdAt: tick(),
          ...row,
        });
        return true;
      },
      listStockNotifications: async ({ unreadOnly = false, limit = 50, offset = 0 } = {}) => {
        let rows = [...dbState.notifications].reverse();
        if (unreadOnly) rows = rows.filter((n) => !n.readAt);
        return { rows: rows.slice(offset, offset + limit), total: rows.length };
      },
      countUnreadNotifications: async () => dbState.notifications.filter((n) => !n.readAt).length,
      getRestockCutoff: async () => dbState.restockCutoff,
      // Ignora el ISO real que manda closeRestockPeriod() (new Date().toISOString()) y usa el
      // reloj falso, para que el corte quede ordenado junto con las notificaciones del test.
      setRestockCutoff: async (_iso) => { dbState.restockCutoff = tick(); return true; },
      listRestockCandidates: async (since) => {
        const sinceMs = since ? new Date(since).getTime() : 0;
        const bySku = new Map();
        for (const n of dbState.notifications) {
          if (new Date(n.createdAt).getTime() < sinceMs) continue;
          if (!bySku.has(n.sku)) bySku.set(n.sku, []);
          bySku.get(n.sku).push(n);
        }
        return [...bySku.entries()]
          .map(([sku, rows]) => {
            const sorted = [...rows].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
            const last = sorted[sorted.length - 1];
            return {
              sku,
              productLabel: last.productLabel,
              firstTriggeredAt: sorted[0].createdAt,
              timesTriggered: sorted.length,
              threshold: last.threshold,
            };
          })
          .sort((a, b) => new Date(a.firstTriggeredAt) - new Date(b.firstTriggeredAt));
      },
      listPacks: async () => dbState.packs,
      getAnalysisSnapshot: async () => dbState.snapshot,
      listRestockOverrides: async () => new Map(dbState.overrides),
      setRestockOverride: async (targetType, targetId, qty) => {
        const key = `${targetType}:${targetId}`;
        if (qty == null) dbState.overrides.delete(key);
        else dbState.overrides.set(key, qty);
        return true;
      },
      clearRestockOverrides: async () => { dbState.overrides = new Map(); return true; },
    },
  });
  alertsService = await import('../src/services/alertsService.js');
});

beforeEach(() => {
  resetDbState();
});

function addRule(sku, threshold, extra = {}) {
  dbState.rules.set(sku, { sku, threshold, productLabel: sku, state: 'ok', mutedUntil: null, ...extra });
}

/* ── evaluateStockAlerts: histéresis ─────────────────────────────────────── */

test('dispara al cruzar el umbral hacia abajo y no repite mientras sigue bajo', async () => {
  addRule('SKU-1', 3);
  const low = makeSnapshot({ mlRows: [{ sku: 'SKU-1', stock: 2 }], tnRows: [{ sku: 'SKU-1', stock: 2 }] });

  await alertsService.evaluateStockAlerts(low.data);
  assert.equal(dbState.notifications.length, 1);
  assert.equal(dbState.rules.get('SKU-1').state, 'triggered');

  // Sigue bajo (mismo valor): no debe insertar una segunda notificación.
  await alertsService.evaluateStockAlerts(low.data);
  assert.equal(dbState.notifications.length, 1);
});

test('se re-arma al subir estrictamente por encima y vuelve a avisar en el siguiente cruce', async () => {
  addRule('SKU-1', 3);
  const low = makeSnapshot({ mlRows: [{ sku: 'SKU-1', stock: 2 }], tnRows: [{ sku: 'SKU-1', stock: 2 }] });
  const restocked = makeSnapshot({ mlRows: [{ sku: 'SKU-1', stock: 10 }], tnRows: [{ sku: 'SKU-1', stock: 10 }] });

  await alertsService.evaluateStockAlerts(low.data);
  assert.equal(dbState.notifications.length, 1);

  await alertsService.evaluateStockAlerts(restocked.data);
  assert.equal(dbState.rules.get('SKU-1').state, 'ok');
  assert.equal(dbState.notifications.length, 1); // subir no notifica

  // Vuelve a cruzar hacia abajo: dispara un segundo aviso.
  await alertsService.evaluateStockAlerts(low.data);
  assert.equal(dbState.notifications.length, 2);
  assert.equal(dbState.rules.get('SKU-1').state, 'triggered');
});

test('estar exactamente en el umbral no re-arma una regla ya disparada', async () => {
  addRule('SKU-2', 3);
  const low = makeSnapshot({ mlRows: [{ sku: 'SKU-2', stock: 1 }], tnRows: [{ sku: 'SKU-2', stock: 1 }] });
  await alertsService.evaluateStockAlerts(low.data);
  assert.equal(dbState.notifications.length, 1);

  // effective == threshold sigue siendo "triggered" (la condición es <=), no es "estrictamente
  // por encima": la regla no se re-arma y no dispara un segundo aviso.
  const atThreshold = makeSnapshot({ mlRows: [{ sku: 'SKU-2', stock: 3 }], tnRows: [{ sku: 'SKU-2', stock: 3 }] });
  await alertsService.evaluateStockAlerts(atThreshold.data);
  assert.equal(dbState.rules.get('SKU-2').state, 'triggered');
  assert.equal(dbState.notifications.length, 1);
});

test('min(ML, TN) manda, y un SKU con varias variantes usa el mínimo de todas', async () => {
  addRule('SKU-VAR', 5);
  const snap = makeSnapshot({
    mlRows: [
      { sku: 'SKU-VAR', stock: 8 },
      { sku: 'SKU-VAR', stock: 3 }, // otra variante, mismo SKU
    ],
    tnRows: [{ sku: 'SKU-VAR', stock: 20 }],
  });
  await alertsService.evaluateStockAlerts(snap.data);
  assert.equal(dbState.rules.get('SKU-VAR').state, 'triggered');
  assert.equal(dbState.notifications[0].stockEffective, 3);
});

test('SKU sin filas en ningún canal no notifica', async () => {
  addRule('SKU-FANTASMA', 5);
  const snap = makeSnapshot({ mlRows: [{ sku: 'OTRO', stock: 1 }], tnRows: [] });
  await alertsService.evaluateStockAlerts(snap.data);
  assert.equal(dbState.notifications.length, 0);
  assert.equal(dbState.rules.get('SKU-FANTASMA').state, 'ok');
});

test('una regla creada con el stock ya bajo notifica en la primera pasada', async () => {
  addRule('SKU-NEW', 4); // arranca en 'ok', como una regla recién creada
  const snap = makeSnapshot({ mlRows: [{ sku: 'SKU-NEW', stock: 1 }], tnRows: [{ sku: 'SKU-NEW', stock: 1 }] });
  await alertsService.evaluateStockAlerts(snap.data);
  assert.equal(dbState.notifications.length, 1);
  assert.equal(dbState.notifications[0].sku, 'SKU-NEW');
});

test('muted_until vigente cambia el estado pero no inserta notificación', async () => {
  const muted = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  addRule('SKU-MUTED', 5, { mutedUntil: muted });
  const snap = makeSnapshot({ mlRows: [{ sku: 'SKU-MUTED', stock: 1 }], tnRows: [{ sku: 'SKU-MUTED', stock: 1 }] });
  await alertsService.evaluateStockAlerts(snap.data);
  assert.equal(dbState.notifications.length, 0);
  assert.equal(dbState.rules.get('SKU-MUTED').state, 'triggered');
});

/* ── lista para reponer ──────────────────────────────────────────────────── */

test('lista para reponer: colapsa varios disparos del mismo SKU en una fila', async () => {
  addRule('SKU-REP', 3);
  const low = makeSnapshot({ mlRows: [{ sku: 'SKU-REP', stock: 1 }], tnRows: [{ sku: 'SKU-REP', stock: 1 }] });
  await alertsService.evaluateStockAlerts(low.data); // dispara (ok -> triggered)
  await alertsService.evaluateStockAlerts(low.data); // no repite
  const restocked = makeSnapshot({ mlRows: [{ sku: 'SKU-REP', stock: 10 }], tnRows: [{ sku: 'SKU-REP', stock: 10 }] });
  await alertsService.evaluateStockAlerts(restocked.data); // re-arma
  await alertsService.evaluateStockAlerts(low.data); // dispara otra vez (2do aviso)

  dbState.snapshot = low; // stock actual para getRestockList
  const { rows } = await alertsService.getRestockList({ period: 'all' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sku, 'SKU-REP');
  assert.equal(rows[0].timesTriggered, 2);
  assert.equal(rows[0].state, 'still-low');
});

test('marcar pedido como hecho vacía la lista y los disparos posteriores vuelven a aparecer', async () => {
  addRule('SKU-CUT', 3);
  const low = makeSnapshot({ mlRows: [{ sku: 'SKU-CUT', stock: 1 }], tnRows: [{ sku: 'SKU-CUT', stock: 1 }] });
  dbState.snapshot = low;
  await alertsService.evaluateStockAlerts(low.data);

  let { rows } = await alertsService.getRestockList({ period: 'last-order' });
  assert.equal(rows.length, 1);

  await alertsService.closeRestockPeriod();
  ({ rows } = await alertsService.getRestockList({ period: 'last-order' }));
  assert.equal(rows.length, 0, 'el período recién cerrado no tiene disparos');

  // El historial completo sigue disponible.
  ({ rows } = await alertsService.getRestockList({ period: 'all' }));
  assert.equal(rows.length, 1);

  // Un disparo nuevo, después del corte, vuelve a aparecer en "desde el último pedido".
  const restocked = makeSnapshot({ mlRows: [{ sku: 'SKU-CUT', stock: 10 }], tnRows: [{ sku: 'SKU-CUT', stock: 10 }] });
  await alertsService.evaluateStockAlerts(restocked.data);
  await alertsService.evaluateStockAlerts(low.data);
  dbState.snapshot = low;
  ({ rows } = await alertsService.getRestockList({ period: 'last-order' }));
  assert.equal(rows.length, 1);
});

test('un SKU que se repuso solo sigue en la lista pero marcado "restocked"', async () => {
  addRule('SKU-SOLO', 3);
  const low = makeSnapshot({ mlRows: [{ sku: 'SKU-SOLO', stock: 1 }], tnRows: [{ sku: 'SKU-SOLO', stock: 1 }] });
  await alertsService.evaluateStockAlerts(low.data);

  // El stock volvió a subir (devolución, carga manual) SIN pasar por evaluateStockAlerts de nuevo
  // con ese snapshot (o la regla se borró/editó) — igual sigue en el período porque ya avisó.
  dbState.snapshot = makeSnapshot({ mlRows: [{ sku: 'SKU-SOLO', stock: 9 }], tnRows: [{ sku: 'SKU-SOLO', stock: 9 }] });
  const { rows } = await alertsService.getRestockList({ period: 'all' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'restocked');
});

/* ── packs: sugerencia de cantidad ───────────────────────────────────────── */

test('un SKU sin pack sugiere llegar justo al umbral, en unidades sueltas', () => {
  const s = alertsService.computeSuggestedQty({ threshold: 5, stockEffective: 1 });
  assert.deepEqual(s, { unit: 'unidades', qty: 4 });
});

test('el faltante nunca es menor a 1, aunque el stock ya esté sobre el umbral', () => {
  const s = alertsService.computeSuggestedQty({ threshold: 5, stockEffective: 9 });
  assert.deepEqual(s, { unit: 'unidades', qty: 1 });
});

test('pack surtido con TANTOS modelos como unitCount: 1 unidad de cada modelo por pack', () => {
  // 8 modelos en un pack de 8 → floor(8/8) = 1 unidad de cada modelo por pack.
  const members = [{ threshold: 3, stockEffective: 1 }]; // falta 2
  const s = alertsService.computePackSuggestedQty(members, { unitCount: 8, modelCount: 8 });
  assert.deepEqual(s, { unit: 'packs', qty: 2 }); // ceil(2/1) = 2
});

test('pack surtido con MENOS modelos que unitCount: se reparte, no es 1 por modelo', () => {
  // 3 modelos en un pack de 8 → floor(8/3) = 2 unidades de cada modelo por pack (no 8, no 1).
  // El más bajo (44) con umbral 80 falta 36; el otro (50) falta 30 — manda el de 36.
  const members = [{ threshold: 80, stockEffective: 44 }, { threshold: 80, stockEffective: 50 }];
  const s = alertsService.computePackSuggestedQty(members, { unitCount: 8, modelCount: 3 });
  assert.deepEqual(s, { unit: 'packs', qty: 18 }); // ceil(36/2) = 18
});

test('pack de un solo modelo: todo el unitCount es de ese modelo', () => {
  const members = [{ threshold: 5, stockEffective: 1 }]; // falta 4
  const s = alertsService.computePackSuggestedQty(members, { mode: 'single', unitCount: 8, modelCount: 1 });
  assert.deepEqual(s, { unit: 'packs', qty: 1 }); // floor(8/1)=8 unidades por pack → ceil(4/8) = 1
});

test('lista para reponer: un SKU sin pack trae su sugerencia calculada; uno con pack la trae vacía y el pack trae la suya', async () => {
  addRule('SKU-SUELTO', 5);
  addRule('SKU-PACK-A', 30);
  addRule('SKU-PACK-B', 10);
  dbState.packs = [{ id: 1, name: 'Repuestos A4', unitCount: 8, mode: 'assorted', skus: ['SKU-PACK-A', 'SKU-PACK-B'] }];
  const snap = makeSnapshot({
    mlRows: [
      { sku: 'SKU-SUELTO', stock: 1 },
      { sku: 'SKU-PACK-A', stock: 6 }, // falta 24 (umbral 30) — el peor
      { sku: 'SKU-PACK-B', stock: 8 }, // falta 2 (umbral 10)
    ],
    tnRows: [
      { sku: 'SKU-SUELTO', stock: 1 },
      { sku: 'SKU-PACK-A', stock: 6 },
      { sku: 'SKU-PACK-B', stock: 8 },
    ],
  });
  await alertsService.evaluateStockAlerts(snap.data);
  dbState.snapshot = snap;

  const { rows } = await alertsService.getRestockList({ period: 'all' });
  const suelto = rows.find((r) => r.sku === 'SKU-SUELTO');
  const packA = rows.find((r) => r.sku === 'SKU-PACK-A');
  const packB = rows.find((r) => r.sku === 'SKU-PACK-B');

  assert.deepEqual(suelto.suggested, { unit: 'unidades', qty: 4 });
  assert.equal(packA.suggested, null, 'sin pack propio, el modelo dentro de un pack no trae sugerencia');
  assert.equal(packB.suggested, null);
  // 2 modelos en un pack de 8 → floor(8/2) = 4 unidades de cada modelo por pack.
  // ceil(max(24, 2) / 4) = ceil(24/4) = 6
  assert.deepEqual(packA.pack.suggestedPacks, { unit: 'packs', qty: 6 }, 'lo cubre el de menor stock (A), repartido entre los 2 modelos del pack');
  assert.deepEqual(packB.pack.suggestedPacks, { unit: 'packs', qty: 6 }, 'mismo pack, misma sugerencia repetida en cada fila');
});

test('ajuste manual: pisa la sugerencia calculada, por SKU y por pack, y se puede borrar', async () => {
  addRule('SKU-SUELTO', 5);
  addRule('SKU-PACK-A', 3);
  dbState.packs = [{ id: 7, name: 'Repuestos A4', unitCount: 8, mode: 'assorted', skus: ['SKU-PACK-A'] }];
  const snap = makeSnapshot({
    mlRows: [{ sku: 'SKU-SUELTO', stock: 1 }, { sku: 'SKU-PACK-A', stock: 1 }],
    tnRows: [{ sku: 'SKU-SUELTO', stock: 1 }, { sku: 'SKU-PACK-A', stock: 1 }],
  });
  await alertsService.evaluateStockAlerts(snap.data);
  dbState.snapshot = snap;

  await alertsService.saveRestockOverride({ targetType: 'sku', targetId: 'SKU-SUELTO', qty: 20 });
  await alertsService.saveRestockOverride({ targetType: 'sku', targetId: 'SKU-PACK-A', qty: 3 });
  await alertsService.saveRestockOverride({ targetType: 'pack', targetId: '7', qty: 9 });

  let { rows } = await alertsService.getRestockList({ period: 'all' });
  let suelto = rows.find((r) => r.sku === 'SKU-SUELTO');
  let packA = rows.find((r) => r.sku === 'SKU-PACK-A');
  assert.deepEqual(suelto.suggested, { unit: 'unidades', qty: 20 });
  assert.deepEqual(packA.suggested, { unit: 'unidades', qty: 3 }, 'extra puntual de ese modelo dentro del pack');
  assert.deepEqual(packA.pack.suggestedPacks, { unit: 'packs', qty: 9 });

  // Borrar el override (qty: null) vuelve al valor calculado.
  await alertsService.saveRestockOverride({ targetType: 'pack', targetId: '7', qty: null });
  ({ rows } = await alertsService.getRestockList({ period: 'all' }));
  packA = rows.find((r) => r.sku === 'SKU-PACK-A');
  assert.deepEqual(packA.pack.suggestedPacks, { unit: 'packs', qty: 1 }, 'sin override vuelve a ceil(max(faltante)/unitCount) = ceil(2/8)');
});

test('marcar pedido como hecho limpia los ajustes manuales', async () => {
  addRule('SKU-CUT2', 3);
  const low = makeSnapshot({ mlRows: [{ sku: 'SKU-CUT2', stock: 1 }], tnRows: [{ sku: 'SKU-CUT2', stock: 1 }] });
  dbState.snapshot = low;
  await alertsService.evaluateStockAlerts(low.data);
  await alertsService.saveRestockOverride({ targetType: 'sku', targetId: 'SKU-CUT2', qty: 15 });

  await alertsService.closeRestockPeriod();
  assert.equal(dbState.overrides.size, 0, 'el override no sobrevive al cierre del período');
});

/* ── productos sin alerta ────────────────────────────────────────────────── */

test('getUnwatchedProducts: solo devuelve SKUs matcheados en los dos canales y sin regla', async () => {
  dbState.snapshot = makeSnapshot({
    mlRows: [
      { sku: 'SKU-A', title: 'Cuaderno A4', variationName: null, thumbnail: 'https://ml/a.jpg', stock: 5 },
      { sku: 'SKU-B', title: 'Cuaderno A5', variationName: 'Negro', thumbnail: null, stock: 2 },
      { sku: 'SKU-SOLO-ML', title: 'Solo en ML', variationName: null, thumbnail: null, stock: 9 },
    ],
    tnRows: [
      { sku: 'SKU-A', productName: 'Cuaderno A4', stock: 4 },
      { sku: 'SKU-B', productName: 'Cuaderno A5', stock: 1 },
      { sku: 'SKU-SOLO-TN', productName: 'Solo en TN', stock: 3 },
    ],
  });
  addRule('SKU-B', 3); // ya vigilado → no debe aparecer

  const products = await alertsService.getUnwatchedProducts();
  assert.deepEqual(products.map((p) => p.sku), ['SKU-A']);
  assert.equal(products[0].productLabel, 'Cuaderno A4');
  assert.equal(products[0].stockMl, 5);
  assert.equal(products[0].stockTn, 4);
});

test('getUnwatchedProducts: usa título + variante como label y respeta el pack', async () => {
  dbState.snapshot = makeSnapshot({
    mlRows: [{ sku: 'SKU-VAR', title: 'Repuesto', variationName: 'Rojo', thumbnail: null, stock: 6 }],
    tnRows: [{ sku: 'SKU-VAR', productName: 'Repuesto', stock: 6 }],
  });
  dbState.packs = [{ id: 1, name: 'Repuestos A4', unitCount: 8, mode: 'single', skus: ['SKU-VAR'] }];

  const products = await alertsService.getUnwatchedProducts();
  assert.equal(products.length, 1);
  assert.equal(products[0].productLabel, 'Repuesto (Rojo)');
  assert.equal(products[0].pack?.name, 'Repuestos A4');
});

test('borrar un pack deja a sus SKUs sin pack, sin tocar reglas ni historial', async () => {
  addRule('SKU-PACK', 3);
  dbState.packs = [{ id: 1, name: 'Repuestos A4', unitCount: 8, mode: 'single', skus: ['SKU-PACK'] }];
  const low = makeSnapshot({ mlRows: [{ sku: 'SKU-PACK', stock: 1 }], tnRows: [{ sku: 'SKU-PACK', stock: 1 }] });
  await alertsService.evaluateStockAlerts(low.data);
  dbState.snapshot = low;

  let { rows } = await alertsService.getRestockList({ period: 'all' });
  assert.equal(rows[0].pack?.name, 'Repuestos A4');

  // Simula el borrado del pack (ON DELETE CASCADE en pack_skus, ver db.js): la regla y el
  // historial de notificaciones no se tocan.
  dbState.packs = [];
  ({ rows } = await alertsService.getRestockList({ period: 'all' }));
  assert.equal(rows.length, 1, 'el historial sigue estando');
  assert.equal(rows[0].pack, null, 'el producto queda sin pack');
  assert.equal(dbState.rules.has('SKU-PACK'), true, 'la regla no se borra');
});
