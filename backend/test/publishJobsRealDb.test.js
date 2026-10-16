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
      assert.equal(draft.supplierKey, 'punto_cero', 'sin proveedor, Punto Cero');

      // Proveedor del pedido: se guarda, se filtra por él y cuenta como "en uso" del proveedor.
      const supKey = `t-sup-${Date.now()}`;
      const other = await db.createSupplierOrder({ name: 't-otro', discount1: 0, discount2: 0, supplierKey: supKey });
      created.push(other.id);
      assert.equal(other.supplierKey, supKey);
      assert.deepEqual((await db.listSupplierOrders({ supplierKey: supKey })).map((o) => o.id), [other.id]);
      assert.deepEqual((await db.listSupplierOrders({ status: 'pendiente', supplierKey: supKey })), []);
      assert.equal((await db.getSupplierUsage(supKey)).orders, 1);

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

test(
  'borrar un borrador conserva su historial de publicación, con el nombre y SKU guardados en el job',
  { skip: hasDb ? false : 'requiere DATABASE_URL (correr con el .env symlinkeado del worktree, o el de backend/)' },
  async () => {
    const { initDb, createPublishJob, deleteProductDraft, listPublishJobs } = await import('../src/db.js');
    const pg = (await import('pg')).default;
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL?.includes('supabase') ? { rejectUnauthorized: false } : undefined
    });
    assert.equal(await initDb(), true);
    const suffix = Date.now();
    const draftId = `t-keep-draft-${suffix}`;
    const jobId = `t-keep-job-${suffix}`;
    try {
      await pool.query(`INSERT INTO product_drafts (id, name, sku, draft_json) VALUES ($1, $2, $3, '{}')`, [draftId, `Cuaderno t-keep ${suffix}`, `TKEEP-${suffix}`]);
      assert.equal(await createPublishJob({ id: jobId, draftId, channels: 'ml', payloadJson: '{}' }), jobId);
      assert.equal(await deleteProductDraft(draftId), true);

      const row = await pool.query('SELECT draft_id, product_name, product_sku FROM product_publish_jobs WHERE id = $1', [jobId]);
      assert.equal(row.rows.length, 1, 'el job sigue existiendo');
      assert.equal(row.rows[0].draft_id, null);
      assert.equal(row.rows[0].product_sku, `TKEEP-${suffix}`);

      const { rows } = await listPublishJobs(5, 0, { search: `t-keep ${suffix}` });
      assert.equal(rows[0]?.id, jobId);
      assert.equal(rows[0]?.draftName, `Cuaderno t-keep ${suffix}`);
    } finally {
      await pool.query('DELETE FROM product_publish_jobs WHERE id = $1', [jobId]);
      await pool.query('DELETE FROM product_drafts WHERE id = $1', [draftId]);
      await pool.end();
    }
  }
);

test(
  'ediciones de publicaciones: una sola abierta por producto, autoguardado y descartar contra Postgres real',
  { skip: hasDb ? false : 'requiere DATABASE_URL (correr con el .env symlinkeado del worktree, o el de backend/)' },
  async () => {
    const db = await import('../src/db.js');
    const pg = (await import('pg')).default;
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL?.includes('supabase') ? { rejectUnauthorized: false } : undefined
    });
    assert.equal(await db.initDb(), true);
    const suffix = Date.now();
    const groupKey = `ml:TEST-${suffix}`;
    const ids = [`t-edit-a-${suffix}`, `t-edit-b-${suffix}`, `t-edit-c-${suffix}`];
    const base = { draft: { common: { baseName: 'X' } }, baseline: { common: { baseName: 'X' } }, refs: { channels: { ml: true } } };
    try {
      const a = await db.createPublicationEdit({ id: ids[0], groupKey, name: 'X', ...base, createdBy: 'test' });
      assert.equal(a.id, ids[0]);
      assert.equal(a.draft.common.baseName, 'X');
      // Una segunda edición del mismo producto choca con el índice único y devuelve la abierta.
      const b = await db.createPublicationEdit({ id: ids[1], groupKey, name: 'X', ...base });
      assert.equal(b.id, ids[0]);
      assert.equal(await db.updatePublicationEditDraft(ids[0], { common: { baseName: 'Y' } }), true);
      assert.equal((await db.getActivePublicationEdit(groupKey)).draft.common.baseName, 'Y');
      assert.equal((await db.listActivePublicationEdits())[groupKey].id, ids[0]);
      assert.equal(await db.setPublicationEditStatus(ids[0], 'discarded'), true);
      assert.equal(await db.updatePublicationEditDraft(ids[0], { common: {} }), false, 'descartada ya no se autoguarda');
      assert.equal(await db.getActivePublicationEdit(groupKey), null);
      const c = await db.createPublicationEdit({ id: ids[2], groupKey, name: 'X', ...base });
      assert.equal(c.id, ids[2], 'descartada la anterior, se puede abrir otra');
    } finally {
      await pool.query('DELETE FROM publication_edits WHERE id = ANY($1)', [ids]);
      await pool.end();
    }
  }
);

test(
  'getLatestPriceListItems: por código, el ítem de la lista más reciente (Postgres real)',
  { skip: hasDb ? false : 'requiere DATABASE_URL' },
  async () => {
    const db = await import('../src/db.js');
    const pg = (await import('pg')).default;
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL?.includes('supabase') ? { rejectUnauthorized: false } : undefined
    });
    assert.equal(await db.initDb(), true);
    const code = `T-CODE-${Date.now()}`;
    const listIds = [];
    try {
      for (const [label, ago, price] of [['vieja', '2 days', 100], ['nueva', '1 hour', 200]]) {
        const r = await pool.query(
          `INSERT INTO price_lists (label, discount_1, discount_2, imported_at) VALUES ($1, 10, 5, NOW() - $2::interval) RETURNING id`,
          [`t-${label}`, ago]
        );
        listIds.push(r.rows[0].id);
        await pool.query(
          `INSERT INTO price_list_items (list_id, code, description, bulk_qty, bulk_price) VALUES ($1, $2, 'd', 8, $3)`,
          [r.rows[0].id, code, price]
        );
      }
      const [item] = await db.getLatestPriceListItems([code]);
      assert.equal(item.bulkPrice, 200);
      assert.equal(item.listLabel, 't-nueva');
      assert.equal(item.discount1, 10);
      const all = await db.getLatestPriceListItems(null);
      assert.equal(all.filter((i) => i.code === code).length, 1, 'sin filtro, un solo ítem por código');
    } finally {
      await pool.query('DELETE FROM price_lists WHERE id = ANY($1)', [listIds]);
      await pool.end();
    }
  }
);

test(
  'deletePriceList poda los códigos huérfanos y el "sacado a mano" no aparece en los mapeos (Postgres real)',
  { skip: hasDb ? false : 'requiere DATABASE_URL' },
  async () => {
    const db = await import('../src/db.js');
    const pg = (await import('pg')).default;
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL?.includes('supabase') ? { rejectUnauthorized: false } : undefined
    });
    assert.equal(await db.initDb(), true);
    const t = Date.now();
    const [orphan, mapped, sku] = [`T-ORPHAN-${t}`, `T-MAPPED-${t}`, `T-SKU-${t}`];
    try {
      const listId = await db.savePriceList({
        label: `t-borrar-${t}`,
        items: [{ code: orphan, bulkQty: 1, bulkPrice: 1 }, { code: mapped, bulkQty: 1, bulkPrice: 1 }],
      });
      assert.ok(listId);
      await db.upsertSkuCodeMap(sku, mapped, 'exact');

      assert.equal(await db.deletePriceList(listId), true);
      assert.equal(await db.deletePriceList(listId), false, 'ya no existe');
      const codes = (await pool.query('SELECT code FROM supplier_codes WHERE code = ANY($1)', [[orphan, mapped]])).rows.map((r) => r.code);
      assert.deepEqual(codes, [mapped], 'el código mapeado queda; el huérfano se poda');

      await db.markSkuCodeRemoved(sku);
      assert.equal((await db.getSkuCodeMap()).some((m) => m.sku === sku), false);
      assert.ok((await db.getRemovedCodeMapKeys()).includes(`sku:${sku}`));
      await db.upsertSkuCodeMap(sku, mapped, 'manual');
      assert.equal((await db.getSkuCodeMap()).find((m) => m.sku === sku)?.code, mapped, 'mapear a mano pisa la marca');
    } finally {
      await pool.query('DELETE FROM sku_code_map WHERE sku = $1', [sku]);
      await pool.query('DELETE FROM supplier_codes WHERE code = ANY($1)', [[orphan, mapped]]);
      await pool.end();
    }
  }
);

test(
  'proveedores, configs de descuento, asignaciones y códigos por proveedor contra Postgres real',
  { skip: hasDb ? false : 'requiere DATABASE_URL' },
  async () => {
    const db = await import('../src/db.js');
    const pg = (await import('pg')).default;
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL?.includes('supabase') ? { rejectUnauthorized: false } : undefined,
    });
    assert.equal(await db.initDb(), true);
    const suffix = Date.now();
    const sup = `t_sup_${suffix}`;
    const sku = `t-sku-${suffix}`;
    try {
      assert.equal(await db.createSupplier({ key: sup, name: 'Test', discount1: 10, discount2: 0 }), sup);
      assert.equal(await db.createSupplier({ key: sup, name: 'Otra vez' }), null, 'la clave no se repite');
      const agendas = await db.createDiscountProfile(sup, { name: 'Agendas', discount1: 30, discount2: 5 });
      let mine = (await db.listSuppliers()).find((s) => s.key === sup);
      assert.deepEqual(mine.profiles.map((p) => [p.name, p.discount1, p.isDefault]), [['General', 10, true], ['Agendas', 30, false]]);

      // onlyIfMissing no pisa una config propia; sin el flag, sí.
      await db.upsertProductSuppliers(sup, [{ type: 'sku', id: sku }], agendas);
      await db.upsertProductSuppliers(sup, [{ type: 'sku', id: sku }], null, { onlyIfMissing: true });
      let rows = (await db.listProductSuppliers()).filter((a) => a.supplierKey === sup);
      assert.deepEqual(rows, [{ type: 'sku', id: sku, supplierKey: sup, profileId: agendas }]);

      // Volverla default: deja de estar asignada explícitamente (sería la misma config dos veces).
      assert.equal(await db.updateDiscountProfile(agendas, { isDefault: true }), true);
      mine = (await db.listSuppliers()).find((s) => s.key === sup);
      assert.deepEqual(mine.profiles.filter((p) => p.isDefault).map((p) => p.id), [agendas]);
      rows = (await db.listProductSuppliers()).filter((a) => a.supplierKey === sup);
      assert.equal(rows[0].profileId, null);

      // Un mismo SKU con un código por proveedor (PK compuesta).
      assert.equal(await db.upsertSkuCodeMap(sku, 'PC-1', 'manual', 'punto_cero'), true);
      assert.equal(await db.upsertSkuCodeMap(sku, 'T-1', 'manual', sup), true);
      assert.equal(await db.upsertSkuCodeMap(sku, 'T-2', 'manual', sup), true);
      const codes = (await db.getSkuCodeMap(null)).filter((m) => m.sku === sku).map((m) => [m.supplier, m.code]).sort();
      assert.deepEqual(codes, [['punto_cero', 'PC-1'], [sup, 'T-2']]);

      // La última lista de cada proveedor por código.
      const listId = await db.savePriceList({ supplier: sup, label: 't', items: [{ code: 'T-2', bulkQty: 2, bulkPrice: 100 }] });
      const latest = await db.getLatestPriceListItems(['T-2'], sup);
      assert.equal(latest.length, 1);
      assert.equal(latest[0].supplier, sup);
      assert.deepEqual(await db.getLatestPriceListItems(['T-2'], 'punto_cero'), []);
      assert.equal((await db.getSupplierUsage(sup)).lists, 1);
      assert.equal(await db.deletePriceList(listId), true);

      // Vigente en product_costs: solo se toca si viene.
      await db.upsertProductCost(sku, { source: 'list', bulkPrice: 100, bulkQty: 2, supplierKey: sup });
      await db.upsertProductCost(sku, { source: 'list', bulkPrice: 120, bulkQty: 2 });
      assert.equal((await db.getProductCost(sku)).supplierKey, sup);
    } finally {
      await pool.query('DELETE FROM product_costs WHERE sku = $1', [sku]);
      await pool.query(`DELETE FROM sku_code_map WHERE sku = $1 AND supplier = 'punto_cero'`, [sku]);
      await db.deleteSupplier(sup);
      const left = await pool.query('SELECT COUNT(*)::int AS n FROM product_suppliers WHERE supplier_key = $1', [sup]);
      assert.equal(left.rows[0].n, 0, 'borrar el proveedor limpia sus asignaciones en cascada');
      await pool.end();
    }
  },
);
