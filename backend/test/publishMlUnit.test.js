/**
 * publishMlUnit: ML descarta atributos en silencio al crear un ítem, así que el detalle de la unidad
 * (visible en la página Publicaciones) tiene que decir cuáles no guardó. Lo mismo con la
 * descripción: va dentro del POST /items, se verifica, y si no quedó se reintenta aparte y se avisa.
 */
import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const ml = {
  createResult: null,
  createErrors: [], // errores a tirar en los próximos createItem (shift por llamada)
  descriptions: [], // respuestas sucesivas de getItemDescription
  setResults: [], // respuestas sucesivas de setItemDescription
  calls: []
};

let publishMlUnit;
before(async () => {
  const real = await import('../src/lib/mercadolibre.js');
  mock.module('../src/lib/mercadolibre.js', {
    exports: {
      ...real,
      createItem: async (_t, body) => {
        ml.calls.push(['create', body.description?.plain_text ?? null]);
        if (ml.createErrors.length) throw ml.createErrors.shift();
        return ml.createResult;
      },
      getItemDescription: async () => {
        ml.calls.push(['getDescription']);
        return ml.descriptions.length ? ml.descriptions.shift() : '';
      },
      setItemDescription: async (_t, _id, text) => {
        ml.calls.push(['setDescription', text]);
        return ml.setResults.length ? ml.setResults.shift() : { ok: true };
      }
    }
  });
  ({ publishMlUnit } = await import('../src/services/productPublish.js'));
});

beforeEach(() => {
  ml.createResult = { id: 'MLA123', attributes: [{ id: 'PAPER_HEIGHT', value_name: '21 cm' }] };
  ml.createErrors = [];
  ml.descriptions = [];
  ml.setResults = [];
  ml.calls = [];
});

const body = { attributes: [{ id: 'PAPER_HEIGHT', value_name: '21 cm' }] };
const opts = { descriptionRetryMs: 0 };

test('publishMlUnit: con todo guardado, el detalle es el de siempre', async () => {
  const r = await publishMlUnit(body, 'tok', '', opts);
  assert.deepEqual(r, { externalId: 'MLA123', detail: 'Publicación MLA123 creada' });
  assert.deepEqual(ml.calls, [['create', null]]); // sin descripción no se consulta nada más
});

test('publishMlUnit: los atributos que ML no guardó y sus avisos quedan en el detalle', async (t) => {
  t.mock.method(console, 'warn', () => {});
  ml.createResult.warnings = [{ message: 'Attribute PAPER_THICKNESS was dropped' }];
  const r = await publishMlUnit({
    attributes: [
      { id: 'PAPER_HEIGHT', value_name: '21 cm' },
      { id: 'PAPER_THICKNESS', value_name: '80 g' },
      { id: 'PAPER_SIZE', value_id: '93218' }
    ]
  }, 'tok', '', opts);
  assert.equal(r.externalId, 'MLA123');
  assert.equal(
    r.detail,
    'Publicación MLA123 creada · ML no guardó: PAPER_THICKNESS, PAPER_SIZE · Avisos de ML: Attribute PAPER_THICKNESS was dropped'
  );
});

test('descripción: viaja dentro del POST /items y, si quedó guardada, no se vuelve a mandar', async () => {
  ml.descriptions = ['Hojas A5 rayadas'];
  const r = await publishMlUnit(body, 'tok', 'Hojas A5 rayadas', opts);
  assert.equal(r.detail, 'Publicación MLA123 creada');
  assert.deepEqual(ml.calls, [['create', 'Hojas A5 rayadas'], ['getDescription']]);
});

test('descripción: si el ítem quedó sin ella, se carga aparte', async () => {
  ml.descriptions = [''];
  const r = await publishMlUnit(body, 'tok', 'Hojas A5', opts);
  assert.equal(r.detail, 'Publicación MLA123 creada');
  assert.deepEqual(ml.calls, [['create', 'Hojas A5'], ['getDescription'], ['setDescription', 'Hojas A5']]);
});

test('descripción: si ML la rechaza en todos los intentos, queda escrito en el detalle', async (t) => {
  t.mock.method(console, 'warn', () => {});
  ml.setResults = [
    { ok: false, error: 'HTTP 404: item not found' },
    { ok: false, error: 'HTTP 404: item not found' },
    { ok: false, error: 'HTTP 400: description invalid' }
  ];
  const r = await publishMlUnit(body, 'tok', 'Hojas A5', opts);
  assert.equal(r.detail, 'Publicación MLA123 creada · ML no guardó la descripción (HTTP 400: description invalid)');
  assert.equal(ml.calls.filter(([c]) => c === 'setDescription').length, 3);
});

test('descripción: un reintento que encuentra la descripción ya guardada corta ahí', async () => {
  ml.descriptions = ['', 'Hojas A5'];
  ml.setResults = [{ ok: false, error: 'HTTP 404: item not found' }];
  const r = await publishMlUnit(body, 'tok', 'Hojas A5', opts);
  assert.equal(r.detail, 'Publicación MLA123 creada');
  assert.equal(ml.calls.filter(([c]) => c === 'setDescription').length, 1);
});

test('descripción: si ML rechaza el campo en POST /items, crea igual sin él y la carga aparte', async (t) => {
  t.mock.method(console, 'warn', () => {});
  ml.createErrors = [Object.assign(new Error('body.invalid_fields: [description]'), { mlStatus: 400 })];
  const r = await publishMlUnit(body, 'tok', 'Hojas A5', opts);
  assert.equal(r.externalId, 'MLA123');
  assert.deepEqual(ml.calls, [['create', 'Hojas A5'], ['create', null], ['getDescription'], ['setDescription', 'Hojas A5']]);
});

test('descripción: otro error de POST /items se propaga (no se reintenta sin descripción)', async () => {
  ml.createErrors = [Object.assign(new Error('item.price.invalid'), { mlStatus: 400 })];
  await assert.rejects(() => publishMlUnit(body, 'tok', 'Hojas A5', opts), /item\.price\.invalid/);
  assert.deepEqual(ml.calls, [['create', 'Hojas A5']]);
});

test('descripción: se limpia de emojis/HTML antes de mandarla a ML (y si queda vacía, no se manda)', async () => {
  ml.descriptions = ['Cuaderno A5'];
  await publishMlUnit(body, 'tok', '📒 <b>Cuaderno</b> A5 ✔', opts);
  assert.deepEqual(ml.calls[0], ['create', 'Cuaderno A5']);

  ml.calls = [];
  await publishMlUnit(body, 'tok', '📒✨', opts);
  assert.deepEqual(ml.calls, [['create', null]]);
});
