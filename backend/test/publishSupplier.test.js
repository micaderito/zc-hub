/**
 * Tests de publishSupplier.js: el proveedor/config/costo elegidos en "Crear producto", que guarda
 * el publish worker al terminar un job con algo publicado.
 */
import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const state = { calls: [], throws: null };
let mod;
before(async () => {
  mock.module('../src/services/pricingService.js', {
    exports: {
      setProductSupplier: async (input) => {
        if (state.throws) throw state.throws;
        state.calls.push(input);
        return { ok: true, targets: [{ type: 'sku', id: input.skus[0] }], changedSkus: [] };
      },
    },
  });
  mod = await import('../src/services/publishSupplier.js');
});
beforeEach(() => { state.calls = []; state.throws = null; });

test('normalizePublishSupplier: sin SKUs, o sin proveedor ni costo, no hay nada que guardar', () => {
  assert.equal(mod.normalizePublishSupplier(null), null);
  assert.equal(mod.normalizePublishSupplier({ skus: [], supplierKey: 'pc' }), null);
  assert.equal(mod.normalizePublishSupplier({ skus: ['A'], supplierKey: null, cost: null }), null);
});

test('normalizePublishSupplier: limpia SKUs repetidos y normaliza el costo', () => {
  const n = mod.normalizePublishSupplier({ skus: [' A ', 'A', 'B'], supplierKey: 'pc', profileId: '3', cost: { mode: 'x', bulkPrice: 10, bulkQty: 2 } });
  assert.deepEqual(n.skus, ['A', 'B']);
  assert.equal(n.profileId, 3);
  assert.equal(n.cost.mode, 'bulk');
});

test('applyPublishSupplier: pasa el pack y no tira si falla', async () => {
  const ok = await mod.applyPublishSupplier({ skus: ['A'], supplierKey: 'pc' }, { packId: 77 });
  assert.equal(ok.applied, true);
  assert.equal(state.calls[0].packId, 77);
  state.throws = new Error('base caída');
  const bad = await mod.applyPublishSupplier({ skus: ['A'], supplierKey: 'pc' });
  assert.equal(bad.applied, false);
});
