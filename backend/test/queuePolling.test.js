import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  startQueuePolling, stopQueuePolling, wakeQueue, QUEUE_POLL_MS, QUEUE_IDLE_MAX_MS
} from '../src/lib/queuePolling.js';

const flush = () => new Promise((r) => setImmediate(r));

/** Arranca el polling con reloj simulado; `advance(ms)` avanza de a un intervalo y deja correr los ticks. */
function setup(t, tickImpl) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let clock = 0;
  const calls = [];
  const tick = async () => { calls.push(clock); return tickImpl(calls.length); };
  const timer = startQueuePolling('test', tick, { now: () => clock });
  t.after(() => stopQueuePolling('test', timer));
  const advance = async (ms) => {
    for (let i = 0; i < ms / QUEUE_POLL_MS; i++) {
      clock += QUEUE_POLL_MS;
      t.mock.timers.tick(QUEUE_POLL_MS);
      await flush();
    }
  };
  return { calls, advance, timer };
}

test('cola vacía: espacia las consultas 1 s, 2 s, 4 s y se queda en el tope de 5 s', async (t) => {
  const { calls, advance } = setup(t, () => false);
  await advance(22_500);
  assert.deepEqual(calls, [500, 1500, 3500, 7500, 12500, 17500, 22500]);
  assert.equal(QUEUE_IDLE_MAX_MS, 5000);
});

test('con trabajo sigue consultando cada 500 ms', async (t) => {
  const { calls, advance } = setup(t, () => true);
  await advance(3000);
  assert.deepEqual(calls, [500, 1000, 1500, 2000, 2500, 3000]);
});

test('cuando aparece trabajo vuelve al ritmo rápido', async (t) => {
  const { calls, advance } = setup(t, (n) => n === 4);
  await advance(9000);
  // 4ª consulta (7500) encuentra trabajo → la siguiente va a 8000, que vuelve a estar vacía → 1 s
  assert.deepEqual(calls, [500, 1500, 3500, 7500, 8000, 9000]);
});

test('wakeQueue: encolar desde este proceso consulta en el próximo intervalo', async (t) => {
  const { calls, advance } = setup(t, () => false);
  await advance(12_500); // ya en el tope de 5 s: próxima consulta a los 17500
  const before = calls.length;
  wakeQueue('test');
  await advance(500);
  assert.equal(calls.length, before + 1);
  assert.equal(calls.at(-1), 13_000);
});

test('un despertar durante un tick que vuelve vacío no se pierde', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let clock = 0;
  const calls = [];
  const timer = startQueuePolling('race', async () => {
    calls.push(clock);
    if (calls.length === 3) wakeQueue('race'); // se encoló algo mientras el claim ya había vuelto vacío
    return false;
  }, { now: () => clock });
  t.after(() => stopQueuePolling('race', timer));
  for (let i = 0; i < 10; i++) {
    clock += QUEUE_POLL_MS;
    t.mock.timers.tick(QUEUE_POLL_MS);
    await flush();
  }
  // sin el guard, después de 3500 la próxima sería 7500; con el despertar va a 4000
  assert.deepEqual(calls.slice(0, 4), [500, 1500, 3500, 4000]);
});

test('un tick que tira no rompe el loop y cuenta como cola quieta', async (t) => {
  const { calls, advance } = setup(t, () => { throw new Error('base caída'); });
  await advance(3500);
  assert.deepEqual(calls, [500, 1500, 3500]);
});

test('stopQueuePolling corta el intervalo y desregistra el despertar', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let n = 0;
  const timer = startQueuePolling('stop', async () => { n++; return true; });
  t.mock.timers.tick(QUEUE_POLL_MS);
  await flush();
  stopQueuePolling('stop', timer);
  t.mock.timers.tick(QUEUE_POLL_MS * 4);
  await flush();
  assert.equal(n, 1);
  assert.doesNotThrow(() => wakeQueue('stop'));
});
