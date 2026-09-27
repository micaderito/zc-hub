/**
 * publishMlUnit: ML descarta atributos en silencio al crear un ítem, así que el detalle de la unidad
 * (visible en la página Publicaciones) tiene que decir cuáles no guardó.
 */
import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

let createResult;
let publishMlUnit;
before(async () => {
  const real = await import('../src/lib/mercadolibre.js');
  mock.module('../src/lib/mercadolibre.js', {
    exports: {
      ...real,
      createItem: async () => createResult,
      setItemDescription: async () => true
    }
  });
  ({ publishMlUnit } = await import('../src/services/productPublish.js'));
});

beforeEach(() => {
  createResult = { id: 'MLA123', attributes: [{ id: 'PAPER_HEIGHT', value_name: '21 cm' }] };
});

test('publishMlUnit: con todo guardado, el detalle es el de siempre', async () => {
  const r = await publishMlUnit({ attributes: [{ id: 'PAPER_HEIGHT', value_name: '21 cm' }] }, 'tok', '');
  assert.deepEqual(r, { externalId: 'MLA123', detail: 'Publicación MLA123 creada' });
});

test('publishMlUnit: los atributos que ML no guardó y sus avisos quedan en el detalle', async (t) => {
  t.mock.method(console, 'warn', () => {});
  createResult.warnings = [{ message: 'Attribute PAPER_THICKNESS was dropped' }];
  const r = await publishMlUnit({
    attributes: [
      { id: 'PAPER_HEIGHT', value_name: '21 cm' },
      { id: 'PAPER_THICKNESS', value_name: '80 g' },
      { id: 'PAPER_SIZE', value_id: '93218' }
    ]
  }, 'tok', '');
  assert.equal(r.externalId, 'MLA123');
  assert.equal(
    r.detail,
    'Publicación MLA123 creada · ML no guardó: PAPER_THICKNESS, PAPER_SIZE · Avisos de ML: Attribute PAPER_THICKNESS was dropped'
  );
});
