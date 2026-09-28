/**
 * Tests de publishAlert.js: el alta de la alerta de stock (y del pack) configurada en
 * "Crear producto", que corre el publish worker al terminar un job con algo publicado.
 */
import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const state = { packs: [], upserted: [], created: [], assigned: [], evaluated: 0, upsertAlertOk: true, listThrows: false };

let mod;
before(async () => {
  mock.module('../src/db.js', {
    exports: {
      upsertStockAlert: async (sku, opts) => {
        state.upserted.push({ sku, ...opts });
        return state.upsertAlertOk;
      },
      listPacks: async () => {
        if (state.listThrows) throw new Error('base caída');
        return state.packs;
      },
      upsertPack: async (data) => {
        state.created.push(data);
        return 77;
      },
      setSkuPack: async (sku, packId) => {
        state.assigned.push({ sku, packId });
        return true;
      }
    }
  });
  mock.module('../src/services/alertsService.js', {
    exports: {
      evaluateStockAlertsNow: async () => {
        state.evaluated++;
      }
    }
  });
  mod = await import('../src/services/publishAlert.js');
});

beforeEach(() => {
  Object.assign(state, { packs: [], upserted: [], created: [], assigned: [], evaluated: 0, upsertAlertOk: true, listThrows: false });
});

test('normalizePublishAlert: sin umbral válido o sin SKUs no hay alerta', () => {
  assert.equal(mod.normalizePublishAlert(null), null);
  assert.equal(mod.normalizePublishAlert({ threshold: -1, skus: [{ sku: 'A' }] }), null);
  assert.equal(mod.normalizePublishAlert({ threshold: 'x', skus: [{ sku: 'A' }] }), null);
  assert.equal(mod.normalizePublishAlert({ threshold: 3, skus: [{ sku: '  ' }] }), null);
});

test('normalizePublishAlert: deduplica SKUs, recorta espacios y sanea el pack nuevo', () => {
  const out = mod.normalizePublishAlert({
    threshold: 2.7,
    skus: [{ sku: ' A ', label: 'Uno' }, { sku: 'A' }, { sku: 'B' }],
    pack: { name: ' Pack x8 ', unitCount: '0', mode: 'raro', sku: '' }
  });
  assert.deepEqual(out, {
    threshold: 2,
    skus: [{ sku: 'A', label: 'Uno' }, { sku: 'B', label: null }],
    pack: { name: 'Pack x8', unitCount: 1, mode: 'assorted', sku: null }
  });
});

test('applyPublishAlert: sin pack, una regla por SKU con el mismo umbral y evalúa una vez', async () => {
  const res = await mod.applyPublishAlert({ threshold: 3, skus: [{ sku: 'A', label: 'Cuaderno Rojo' }, { sku: 'B', label: 'Cuaderno Azul' }] });
  assert.deepEqual(res, { applied: true, rules: 2, packId: null });
  assert.deepEqual(state.upserted, [
    { sku: 'A', threshold: 3, productLabel: 'Cuaderno Rojo' },
    { sku: 'B', threshold: 3, productLabel: 'Cuaderno Azul' }
  ]);
  assert.equal(state.assigned.length, 0);
  assert.equal(state.evaluated, 1);
});

test('applyPublishAlert: pack existente → asigna cada SKU a ese pack sin crear otro', async () => {
  const res = await mod.applyPublishAlert({ threshold: 1, skus: [{ sku: 'A' }, { sku: 'B' }], pack: { id: 5 } });
  assert.equal(res.packId, 5);
  assert.equal(state.created.length, 0);
  assert.deepEqual(state.assigned, [{ sku: 'A', packId: 5 }, { sku: 'B', packId: 5 }]);
});

test('applyPublishAlert: pack nuevo → lo crea y le asigna los SKUs', async () => {
  const res = await mod.applyPublishAlert({
    threshold: 1,
    skus: [{ sku: 'A' }],
    pack: { name: 'Cuadernos x8', unitCount: 8, mode: 'assorted', sku: 'PK-1' }
  });
  assert.equal(res.packId, 77);
  assert.deepEqual(state.created, [{ name: 'Cuadernos x8', unitCount: 8, mode: 'assorted', sku: 'PK-1' }]);
  assert.deepEqual(state.assigned, [{ sku: 'A', packId: 77 }]);
});

test('applyPublishAlert: pack nuevo con un nombre que ya existe (reintento) reusa el existente', async () => {
  state.packs = [{ id: 9, name: 'cuadernos X8 ' }];
  const res = await mod.applyPublishAlert({ threshold: 1, skus: [{ sku: 'A' }], pack: { name: 'Cuadernos x8', unitCount: 8 } });
  assert.equal(res.packId, 9);
  assert.equal(state.created.length, 0);
});

test('applyPublishAlert: sin alerta válida no toca nada', async () => {
  const res = await mod.applyPublishAlert({ threshold: 3, skus: [] });
  assert.deepEqual(res, { applied: false });
  assert.equal(state.upserted.length, 0);
  assert.equal(state.evaluated, 0);
});

test('applyPublishAlert: un fallo de la base no tira (la publicación ya se hizo)', async () => {
  state.listThrows = true;
  const res = await mod.applyPublishAlert({ threshold: 1, skus: [{ sku: 'A' }], pack: { name: 'Nuevo' } });
  assert.equal(res.applied, false);
  assert.match(res.error, /base caída/);
});
