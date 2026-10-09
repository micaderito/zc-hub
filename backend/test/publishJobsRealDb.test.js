/**
 * Los tests del proyecto que corren contra un Postgres REAL en vez de mockear `pg`. Se salta solo
 * si no hay `DATABASE_URL` (CI sin base, o quien corra `npm test` sin el `.env` symlinkeado).
 *
 * Por qué existe: `finishPublishJob` y `reconcileStalePublishJobs` tenían un bug real donde
 * Postgres rechazaba la query entera con "inconsistent types deduced for parameter $n" (el mismo
 * `$n` se usaba en `SET status = $n` —deduce varchar(16), el tipo de la columna— y en
 * `$n IN ('done','error')` —deduce text—). TODOS los demás tests de `db.js` mockean `pg`, así que
 * el SQL nunca se evalúa de verdad y ninguno detectó esto — el job se quedaba en `processing` para
 * siempre a pesar de que el barrido "cerraba" 0 en silencio (`catch` + `console.error`). Este test
 * corre el SQL de verdad para que un regresivo de ese cast no vuelva a colarse invisible.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';

const hasDb = !!process.env.DATABASE_URL;

test(
  'finishPublishJob + reconcileStalePublishJobs cierran jobs trabados contra Postgres real',
  { skip: hasDb ? false : 'requiere DATABASE_URL (correr con el .env symlinkeado del worktree, o el de backend/)' },
  async () => {
    const { initDb, finishPublishJob, reconcileStalePublishJobs, retryPublishJob } = await import('../src/db.js');
    const pg = (await import('pg')).default;
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL?.includes('supabase') ? { rejectUnauthorized: false } : undefined
    });

    const ok = await initDb();
    assert.equal(ok, true, 'initDb() debería poder conectar con DATABASE_URL configurada');

    const suffix = Date.now();
    const jobs = [`t-finish-${suffix}`, `t-reconcile-${suffix}`, `t-retry-${suffix}`];
    const drafts = [`t-draft-a-${suffix}`, `t-draft-b-${suffix}`, `t-draft-c-${suffix}`];

    try {
      // --- finishPublishJob: cierra un job 'processing' con SET status=$1 + CASE WHEN $1 IN (...) ---
      await pool.query(`INSERT INTO product_drafts (id, name, sku, draft_json, status) VALUES ($1,'t','t-sku-a','{}','publishing')`, [drafts[0]]);
      await pool.query(
        `INSERT INTO product_publish_jobs (id, draft_id, channels, payload_json, status, locked_at, attempts) VALUES ($1,$2,'ml','{}','processing', NOW(), 1)`,
        [jobs[0], drafts[0]]
      );
      const finished = await finishPublishJob(jobs[0], 'done', null);
      assert.equal(finished, true, 'finishPublishJob debería cerrar el job (regresión: rechazaba la query por tipos inconsistentes)');
      const row0 = await pool.query('SELECT status FROM product_publish_jobs WHERE id=$1', [jobs[0]]);
      assert.equal(row0.rows[0]?.status, 'done');

      // --- reconcileStalePublishJobs: cierra un job trabado hace horas con todas sus unidades ok,
      // y recalcula el status del borrador a 'published' ---
      await pool.query(`INSERT INTO product_drafts (id, name, sku, draft_json, status) VALUES ($1,'t','t-sku-b','{}','publishing')`, [drafts[1]]);
      await pool.query(
        `INSERT INTO product_publish_jobs (id, draft_id, channels, payload_json, status, locked_at, attempts, updated_at)
         VALUES ($1,$2,'ml,tn','{}','processing', NOW() - interval '3 hours', 1, NOW() - interval '3 hours')`,
        [jobs[1], drafts[1]]
      );
      await pool.query(
        `INSERT INTO product_publish_units (job_id, channel, unit_key, seq, status, external_id, updated_at) VALUES
           ($1,'ml','sku1',0,'ok','MLA1', NOW() - interval '3 hours'),
           ($1,'tn','sku1',1,'ok','367000', NOW() - interval '3 hours')`,
        [jobs[1]]
      );
      const closed = await reconcileStalePublishJobs();
      assert.ok(closed >= 1, 'reconcileStalePublishJobs debería cerrar al menos el job trabado que sembramos');
      const row1 = await pool.query('SELECT status FROM product_publish_jobs WHERE id=$1', [jobs[1]]);
      assert.equal(row1.rows[0]?.status, 'done');
      const draft1 = await pool.query('SELECT status FROM product_drafts WHERE id=$1', [drafts[1]]);
      assert.equal(draft1.rows[0]?.status, 'published');

      // --- guarda anti-carrera: un job recién reintentado no debe cerrarse por el barrido ---
      await pool.query(`INSERT INTO product_drafts (id, name, sku, draft_json, status) VALUES ($1,'t','t-sku-c','{}','error')`, [drafts[2]]);
      await pool.query(
        `INSERT INTO product_publish_jobs (id, draft_id, channels, payload_json, status, locked_at, attempts, updated_at)
         VALUES ($1,$2,'ml','{}','error', NULL, 5, NOW() - interval '3 hours')`,
        [jobs[2], drafts[2]]
      );
      await pool.query(
        `INSERT INTO product_publish_units (job_id, channel, unit_key, seq, status, updated_at) VALUES ($1,'ml','sku1',0,'error', NOW() - interval '3 hours')`,
        [jobs[2]]
      );
      const retried = await retryPublishJob(jobs[2]);
      assert.equal(retried, true);
      await reconcileStalePublishJobs();
      const row2 = await pool.query('SELECT status FROM product_publish_jobs WHERE id=$1', [jobs[2]]);
      assert.equal(row2.rows[0]?.status, 'pending', 'un job recién reintentado no debe cerrarlo el barrido');
    } finally {
      await pool.query('DELETE FROM product_publish_jobs WHERE id = ANY($1)', [jobs]);
      await pool.query('DELETE FROM product_drafts WHERE id = ANY($1)', [drafts]);
      await pool.end();
    }
  }
);

// Pedidos al proveedor: vive en este mismo archivo a propósito. `node --test` corre cada archivo en
// su propio proceso y en paralelo; dos archivos llamando a initDb() a la vez chocan creando las
// mismas tablas ("duplicate key ... pg_class_relname_nsp_index"). En un solo archivo van en serie.
test(
  'pedidos: crear, guardar borrador, marcar como pedido, recibir incompleto y duplicar faltantes contra Postgres real',
  { skip: hasDb ? false : 'requiere DATABASE_URL (correr con el .env symlinkeado del worktree, o el de backend/)' },
  async () => {
    const db = await import('../src/db.js');
    const pg = (await import('pg')).default;
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL?.includes('supabase') ? { rejectUnauthorized: false } : undefined,
    });
    assert.equal(await db.initDb(), true, 'initDb() debería poder conectar con DATABASE_URL configurada');

    const created = [];
    try {
      const pending = await db.createSupplierOrder({ name: `t-repetido-${Date.now()}`, status: 'pendiente', discount1: 25, discount2: 5 });
      created.push(pending.id);
      assert.equal(pending.status, 'pendiente');
      assert.ok(pending.orderedAt, 'un pedido creado como pendiente tiene fecha de pedido');

      const draft = await db.createSupplierOrder({ name: `t-pedido-${Date.now()}`, discount1: 25, discount2: 5 });
      created.push(draft.id);
      assert.equal(draft.status, 'borrador');
      assert.equal(draft.orderedAt, null);

      const saved = await db.updateSupplierOrderDraft(draft.id, {
        name: 'Pedido test', note: 'nota', discount1: 30, discount2: 0,
        lines: [
          { kind: 'pack', packId: 999999, code: 'PK', description: 'Pack', detail: 'rosa', qty: 2, unitPrice: 96000.5, priceSource: 'precios', unitsPerPack: 8, origin: 'alerta' },
          { kind: 'free', code: '5520', description: 'Planner', qty: 3, unitPrice: null, priceSource: 'manual', origin: 'libre' },
        ],
      });
      assert.equal(saved.discount1, 30);
      assert.deepEqual(saved.lines.map((l) => [l.kind, l.qty, l.unitPrice, l.detail]), [['pack', 2, 96000.5, 'rosa'], ['free', 3, null, '']]);

      assert.equal(await db.placeSupplierOrder(draft.id), true);
      assert.equal(await db.placeSupplierOrder(draft.id), false, 'no se marca dos veces');
      assert.equal(await db.updateSupplierOrderDraft(draft.id, { ...saved, lines: [] }), 'not_draft');
      assert.equal(await db.deleteSupplierOrderDraft(draft.id), false, 'un pedido mandado no se borra');

      const [l1, l2] = saved.lines;
      const partial = await db.receiveSupplierOrder(draft.id, { [l1.id]: 2 });
      assert.equal(partial.status, 'pendiente');
      const closed = await db.receiveSupplierOrder(draft.id, { [l2.id]: 1 }, { close: true });
      assert.equal(closed.status, 'recibido');
      assert.equal(closed.partial, true);
      assert.ok(closed.receivedAt);
      assert.deepEqual(closed.lines.map((l) => l.receivedQty), [2, 1]);

      const list = await db.listSupplierOrders({ status: 'recibido' });
      assert.ok(list.some((o) => o.id === draft.id && o.lines.length === 2));

      await db.setOrderDefaults({ discount1: 25, discount2: 5 });
      assert.deepEqual(await db.getOrderDefaults(), { discount1: 25, discount2: 5 });
    } finally {
      if (created.length) await pool.query('DELETE FROM supplier_orders WHERE id = ANY($1::int[])', [created]);
      await pool.end();
    }
  }
);
