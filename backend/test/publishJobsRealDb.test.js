/**
 * Único test del proyecto que corre contra un Postgres REAL en vez de mockear `pg`. Se salta solo
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
