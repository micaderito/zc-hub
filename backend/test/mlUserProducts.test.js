/**
 * isUserProductSeller: detecta si la cuenta ya está en el modelo User Products (tag
 * `user_product_seller` en GET /users/me) y cachea el resultado un rato para no repetir el
 * request en cada publicación.
 */
import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const state = { tags: [], calls: 0 };

let isUserProductSeller;
let __setCacheForTests;
before(async () => {
  mock.module('../src/lib/mercadolibre.js', {
    exports: {
      getMe: async () => {
        state.calls++;
        return { tags: state.tags };
      }
    }
  });
  ({ isUserProductSeller, __setCacheForTests } = await import('../src/lib/mlUserProducts.js'));
});
beforeEach(() => {
  state.calls = 0;
  state.tags = [];
  __setCacheForTests(null);
});

test('true si la cuenta tiene el tag user_product_seller', async () => {
  state.tags = ['normal', 'user_product_seller'];
  assert.equal(await isUserProductSeller('tok'), true);
});

test('false si no tiene el tag (cuenta legacy)', async () => {
  state.tags = ['normal', 'mercadolider'];
  assert.equal(await isUserProductSeller('tok'), false);
});

test('false si getMe no devuelve tags (falla getMe u otro formato)', async () => {
  state.tags = undefined;
  assert.equal(await isUserProductSeller('tok'), false);
});

test('cachea el resultado: una segunda llamada no repite el request a ML', async () => {
  state.tags = ['user_product_seller'];
  assert.equal(await isUserProductSeller('tok'), true);
  assert.equal(await isUserProductSeller('tok'), true);
  assert.equal(state.calls, 1);
});
