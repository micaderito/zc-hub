/**
 * Conexión a Postgres (Supabase o cualquier Postgres) para:
 * - sync_settings: activar/desactivar sincronización de stock
 * - sync_audit: historial de cada descuento de stock (canal, orden, SKU, cantidad, antes/después, fecha)
 */

import pg from 'pg';

const { Pool } = pg;

let pool = null;

function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL?.includes('supabase') ? { rejectUnauthorized: false } : undefined
    });
  }
  return pool;
}

const SYNC_ENABLED_KEY = 'stock_sync_enabled';
const ANALYSIS_CACHE_KEY = 'conflicts_analysis_cache';

/** Crea las tablas si no existen. */
export async function initDb() {
  const p = getPool();
  if (!p) return false;
  try {
    await p.query(`
      CREATE TABLE IF NOT EXISTS sync_settings (
        key VARCHAR(64) PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    await p.query(`
      INSERT INTO sync_settings (key, value) VALUES ($1, 'false')
      ON CONFLICT (key) DO NOTHING;
    `, [SYNC_ENABLED_KEY]);

    await p.query(`
      CREATE TABLE IF NOT EXISTS sync_audit (
        id SERIAL PRIMARY KEY,
        channel_sale VARCHAR(32) NOT NULL,
        order_id VARCHAR(128) NOT NULL,
        sku VARCHAR(128) NOT NULL,
        product_label VARCHAR(512),
        quantity INTEGER NOT NULL,
        updated_channel VARCHAR(32) NOT NULL,
        stock_before INTEGER NOT NULL,
        stock_after INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await p.query(`ALTER TABLE sync_audit ADD COLUMN IF NOT EXISTS reverted_at TIMESTAMPTZ;`);
    await p.query(`ALTER TABLE sync_audit ADD COLUMN IF NOT EXISTS sale_item_id VARCHAR(128);`);
    await p.query(`ALTER TABLE sync_audit ADD COLUMN IF NOT EXISTS product_display VARCHAR(1024);`);
    await p.query(`ALTER TABLE sync_audit ADD COLUMN IF NOT EXISTS notification_payload TEXT;`);
    await p.query(`ALTER TABLE sync_audit ADD COLUMN IF NOT EXISTS pack_id VARCHAR(128);`);
    // `source` distingue de dónde vino el cambio de stock. La tabla nació asumiendo que todo
    // cambio era consecuencia de una venta, así que las filas viejas son todas 'venta' y el
    // DEFAULT las backfillea. Los cambios manuales (botón "sincronizar stock") no tienen orden
    // ni canal de venta: por eso los NOT NULL de abajo se aflojan en vez de rellenarse con
    // sentinelas vacíos, que harían pasar por "sin orden" a algo que nunca tuvo una.
    await p.query(`ALTER TABLE sync_audit ADD COLUMN IF NOT EXISTS source VARCHAR(16) NOT NULL DEFAULT 'venta';`);
    await p.query(`ALTER TABLE sync_audit ALTER COLUMN channel_sale DROP NOT NULL;`);
    await p.query(`ALTER TABLE sync_audit ALTER COLUMN order_id DROP NOT NULL;`);
    await p.query(`ALTER TABLE sync_audit ALTER COLUMN quantity DROP NOT NULL;`);
    // El historial por producto filtra por SKU y ordena por fecha.
    await p.query(`CREATE INDEX IF NOT EXISTS idx_sync_audit_sku_created ON sync_audit (sku, created_at DESC);`);
    // Backfill una sola vez: rellena pack_id de filas viejas leyendo el pack_id real desde el JSON crudo de la orden.
    try {
      await p.query(`
        UPDATE sync_audit
        SET pack_id = (notification_payload::jsonb ->> 'pack_id')
        WHERE pack_id IS NULL
          AND notification_payload IS NOT NULL
          AND (notification_payload::jsonb ->> 'pack_id') IS NOT NULL
      `);
    } catch (e) {
      console.error('DB init: backfill pack_id error:', e.message);
    }

    await p.query(`
      CREATE TABLE IF NOT EXISTS sync_pending_returns (
        id SERIAL PRIMARY KEY,
        claim_id VARCHAR(64),
        order_id VARCHAR(128) NOT NULL,
        item_id VARCHAR(64) NOT NULL,
        variation_id VARCHAR(64),
        sku VARCHAR(128),
        quantity INTEGER NOT NULL DEFAULT 1,
        product_label VARCHAR(512),
        status VARCHAR(32) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        approved_at TIMESTAMPTZ
      );
    `);
    await p.query(`
      ALTER TABLE sync_pending_returns ADD COLUMN IF NOT EXISTS claim_id VARCHAR(64);
    `);
    await p.query(`ALTER TABLE sync_pending_returns ADD COLUMN IF NOT EXISTS reason VARCHAR(256);`);
    await p.query(`ALTER TABLE sync_pending_returns ADD COLUMN IF NOT EXISTS buyer_nickname VARCHAR(256);`);
    await p.query(`ALTER TABLE sync_pending_returns ADD COLUMN IF NOT EXISTS claim_date TIMESTAMPTZ;`);
    // order_id es el nro de venta que ve el usuario (pack_id cuando la venta es de un carrito), así
    // que NO sirve para cruzar con sync_processed_orders ni con el id que trae el webhook de orders.
    // sale_order_id guarda el id de la orden individual justamente para ese cruce.
    await p.query(`ALTER TABLE sync_pending_returns ADD COLUMN IF NOT EXISTS sale_order_id VARCHAR(128);`);

    await p.query(`
      CREATE TABLE IF NOT EXISTS sync_processed_orders (
        channel_sale VARCHAR(32) NOT NULL,
        order_id VARCHAR(128) NOT NULL,
        operation VARCHAR(16) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (channel_sale, order_id, operation)
      );
    `);

    await p.query(`
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        key VARCHAR(64) PRIMARY KEY,
        value JSONB NOT NULL
      );
    `);

    await p.query(`
      CREATE TABLE IF NOT EXISTS ml_pending_tasks (
        id SERIAL PRIMARY KEY,
        kind VARCHAR(32) NOT NULL,
        item_id VARCHAR(128),
        variation_id VARCHAR(128),
        target_qty INTEGER,
        target_sku VARCHAR(128),
        target_price NUMERIC(15,2),
        context_json TEXT,
        status VARCHAR(32) NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        locked_at TIMESTAMPTZ,
        idempotency_key VARCHAR(256) UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await p.query(`
      CREATE INDEX IF NOT EXISTS idx_ml_pending_tasks_runnable
      ON ml_pending_tasks(status, next_run_at)
      WHERE status IN ('pending', 'failed');
    `);
    // Migración: agrega target_price a tablas ya creadas (price_ml).
    await p.query(`ALTER TABLE ml_pending_tasks ADD COLUMN IF NOT EXISTS target_price NUMERIC(15,2);`);
    return true;
  } catch (e) {
    console.error('DB init error:', e.message);
    return false;
  }
}

/**
 * Snapshot persistente del catálogo (filas crudas mlRows/tnRows) del que se computa el análisis.
 * A diferencia de una caché con TTL, es la FUENTE del análisis: se llena con un crawl completo de
 * ML/TN solo la primera vez (o en refresh manual / reconcile periódico) y después se mantiene fresco
 * con parches puntuales (webhooks, escrituras). Devuelve { at, data } sin filtrar por antigüedad:
 * quien lo consume decide si dispara un refresh en background (stale-while-revalidate).
 */
export async function getAnalysisSnapshot() {
  const p = getPool();
  if (!p) return null;
  try {
    const r = await p.query('SELECT value FROM sync_settings WHERE key = $1', [ANALYSIS_CACHE_KEY]);
    if (!r.rows?.length) return null;
    const raw = r.rows[0].value;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed?.data) return null;
    return { at: parsed.at ?? 0, data: parsed.data };
  } catch {
    return null;
  }
}

export async function setAnalysisSnapshot(data) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(
      `INSERT INTO sync_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
      [ANALYSIS_CACHE_KEY, JSON.stringify({ at: Date.now(), data })]
    );
  } catch (e) {
    console.error('setAnalysisSnapshot:', e.message);
  }
}

/** Borra el snapshot para forzar un crawl completo en la próxima lectura (refresh manual). */
export async function invalidateAnalysisCache() {
  const p = getPool();
  if (!p) return;
  try {
    await p.query('DELETE FROM sync_settings WHERE key = $1', [ANALYSIS_CACHE_KEY]);
  } catch (e) {
    console.error('invalidateAnalysisCache:', e.message);
  }
}

/** ¿Está activada la sincronización de stock? Por defecto false. */
export async function getSyncEnabled() {
  const p = getPool();
  if (!p) return false;
  try {
    const r = await p.query(
      'SELECT value FROM sync_settings WHERE key = $1',
      [SYNC_ENABLED_KEY]
    );
    return r.rows[0]?.value === 'true';
  } catch (e) {
    console.error('getSyncEnabled:', e.message);
    return false;
  }
}

/** Activar o desactivar la sincronización. */
export async function setSyncEnabled(enabled) {
  const p = getPool();
  if (!p) return false;
  try {
    await p.query(
      'UPDATE sync_settings SET value = $1 WHERE key = $2',
      [enabled ? 'true' : 'false', SYNC_ENABLED_KEY]
    );
    return true;
  } catch (e) {
    console.error('setSyncEnabled:', e.message);
    return false;
  }
}

/**
 * Reemplazo atómico para idempotencia: intenta "reservar" el procesamiento de esta orden+operación.
 * Solo un request puede ganar (INSERT con PK). Evita doble descuento/restauración aunque lleguen varios webhooks a la vez.
 * @param {string} channelSale - 'mercadolibre' | 'tiendanube'
 * @param {string} orderId
 * @param {string} operation - 'deduct' | 'restore'
 * @returns {Promise<boolean>} true si somos los primeros (procesar), false si ya estaba procesado (omitir)
 */
export async function tryClaimOrderProcessing(channelSale, orderId, operation) {
  const p = getPool();
  if (!p || !orderId) return false;
  try {
    const r = await p.query(
      `INSERT INTO sync_processed_orders (channel_sale, order_id, operation)
       VALUES ($1, $2, $3)
       ON CONFLICT (channel_sale, order_id, operation) DO NOTHING
       RETURNING 1`,
      [channelSale, String(orderId), operation]
    );
    return (r.rowCount ?? 0) > 0;
  } catch (e) {
    return false;
  }
}

/** Indica si ya se procesó esta orden para esta operación (restore o deduct). */
export async function hasOrderProcessingClaimed(channelSale, orderId, operation) {
  const p = getPool();
  if (!p || !orderId) return false;
  try {
    const r = await p.query(
      'SELECT 1 FROM sync_processed_orders WHERE channel_sale = $1 AND order_id = $2 AND operation = $3 LIMIT 1',
      [channelSale, String(orderId), operation]
    );
    return (r.rowCount ?? 0) > 0;
  } catch (e) {
    return false;
  }
}

/** Libera el claim de una orden para que pueda volver a procesarse (p. ej. si no se pudo sincronizar nada). */
export async function releaseOrderProcessingClaim(channelSale, orderId, operation) {
  const p = getPool();
  if (!p || !orderId) return false;
  try {
    const r = await p.query(
      'DELETE FROM sync_processed_orders WHERE channel_sale = $1 AND order_id = $2 AND operation = $3 RETURNING 1',
      [channelSale, String(orderId), operation]
    );
    return (r.rowCount ?? 0) > 0;
  } catch (e) {
    return false;
  }
}

/**
 * Registra una línea del historial de sincronización.
 * @param {object} row - { channelSale, orderId, packId?, sku, productLabel?, productDisplay?, quantity, updatedChannel, stockBefore, stockAfter, saleItemId?, notificationPayload? }
 * orderId = id de la orden individual (ML: order.id; TN: order id).
 * packId = nro de venta real (ML: pack_id de la orden, agrupa varias órdenes de un mismo carrito; TN no tiene pack, se usa el propio orderId).
 * saleItemId = id del ítem en esa venta (ML: item_id o item_id:variation_id; TN: variant_id o product_id:variant_id).
 * productLabel = estado/acción que afecta el stock: "Venta ML", "Venta TN", "Cancelación ML", "Cancelación TN", "Devolución aprobada".
 * productDisplay = descripción y variante del producto (nombre + variante); no usar productLabel para el nombre del producto.
 * notificationPayload = JSON crudo de la orden (respuesta getOrder ML/TN) para auditoría.
 */
export async function insertAuditLog(row) {
  const p = getPool();
  if (!p) return;
  try {
    const payloadStr = row.notificationPayload != null
      ? (typeof row.notificationPayload === 'string' ? row.notificationPayload : JSON.stringify(row.notificationPayload))
      : null;
    const source = row.source || 'venta';
    // Un cambio manual no nace de una orden: no tiene canal de venta, nº de orden ni cantidad
    // vendida. Esos campos van NULL; el qué pasó lo cuentan stock_before/stock_after. Las filas
    // de venta mantienen los defaults de siempre ('' y 0) para no cambiar lo ya guardado.
    const fromSale = source !== 'manual';
    await p.query(
      `INSERT INTO sync_audit (channel_sale, order_id, pack_id, sale_item_id, sku, product_label, product_display, quantity, updated_channel, stock_before, stock_after, notification_payload, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        row.channelSale ?? null,
        fromSale ? (row.orderId || '') : null,
        fromSale ? (row.packId || row.orderId || '') : null,
        row.saleItemId ?? null,
        row.sku || '',
        row.productLabel ?? null,
        row.productDisplay ?? null,
        fromSale ? (row.quantity ?? 0) : null,
        row.updatedChannel,
        row.stockBefore ?? 0,
        row.stockAfter ?? 0,
        payloadStr,
        source
      ]
    );
  } catch (e) {
    console.error('insertAuditLog:', e.message);
  }
}

/** Columnas del historial, en el formato camelCase que espera el front. */
const AUDIT_COLUMNS = `id, channel_sale AS "channelSale", order_id AS "orderId", pack_id AS "packId",
        sale_item_id AS "saleItemId", sku, product_label AS "productLabel", product_display AS "productDisplay",
        quantity, updated_channel AS "updatedChannel", stock_before AS "stockBefore", stock_after AS "stockAfter",
        source, created_at AS "createdAt", reverted_at AS "revertedAt", notification_payload AS "notificationPayload"`;

/** Orígenes válidos de un cambio de stock. Se valida en la query para no filtrar por algo inexistente. */
export const AUDIT_SOURCES = ['venta', 'manual', 'devolucion'];

function mapAuditRow(r) {
  return {
    ...r,
    saleItemId: r.saleItemId ?? null,
    createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
    revertedAt: r.revertedAt ? new Date(r.revertedAt).toISOString() : null
  };
}

/**
 * Lista el historial de cambios de stock (más recientes primero).
 * @param {number} limit
 * @param {number} offset
 * @param {string} [search] - nº de venta (pack_id), nº de orden (order_id), id. ítem (sale_item_id) o SKU; busca en los cuatro.
 * @param {string} [source] - filtra por origen ('venta' | 'manual' | 'devolucion'); vacío = todos.
 */
export async function getAuditLog(limit = 100, offset = 0, search = '', source = '') {
  const p = getPool();
  if (!p) return { rows: [], total: 0 };
  try {
    const where = [];
    const params = [];

    const searchTrim = search && String(search).trim();
    if (searchTrim) {
      params.push('%' + searchTrim + '%');
      const i = params.length;
      where.push(`(order_id ILIKE $${i} OR pack_id ILIKE $${i} OR sale_item_id ILIKE $${i} OR sku ILIKE $${i})`);
    }
    const sourceTrim = source && String(source).trim();
    if (sourceTrim && AUDIT_SOURCES.includes(sourceTrim)) {
      params.push(sourceTrim);
      where.push(`source = $${params.length}`);
    }
    const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';

    const countResult = await p.query(`SELECT COUNT(*)::int AS total FROM sync_audit${whereSql}`, params);
    const total = countResult.rows[0]?.total ?? 0;

    const result = await p.query(
      `SELECT ${AUDIT_COLUMNS}
         FROM sync_audit${whereSql}
         ORDER BY created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, Math.min(limit, 500), offset]
    );
    return { rows: result.rows.map(mapAuditRow), total };
  } catch (e) {
    console.error('getAuditLog:', e.message);
    return { rows: [], total: 0 };
  }
}

/**
 * Historial de un producto puntual, por SKU (la unidad que une ML ↔ TN).
 * Trae los cambios de ambos canales juntos, más recientes primero.
 */
export async function getStockHistoryBySku(sku, limit = 50, offset = 0) {
  const p = getPool();
  const skuTrim = sku && String(sku).trim();
  if (!p || !skuTrim) return { rows: [], total: 0 };
  try {
    const countResult = await p.query(
      'SELECT COUNT(*)::int AS total FROM sync_audit WHERE sku = $1',
      [skuTrim]
    );
    const total = countResult.rows[0]?.total ?? 0;
    const result = await p.query(
      `SELECT ${AUDIT_COLUMNS}
         FROM sync_audit
         WHERE sku = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
      [skuTrim, Math.min(limit, 200), offset]
    );
    return { rows: result.rows.map(mapAuditRow), total };
  } catch (e) {
    console.error('getStockHistoryBySku:', e.message);
    return { rows: [], total: 0 };
  }
}

/** Obtiene una fila del historial por id. */
export async function getAuditRowById(id) {
  const p = getPool();
  if (!p || !id) return null;
  try {
    const r = await p.query(
      `SELECT id, channel_sale AS "channelSale", order_id AS "orderId", pack_id AS "packId", sale_item_id AS "saleItemId", sku, product_label AS "productLabel", product_display AS "productDisplay",
              quantity, updated_channel AS "updatedChannel", stock_before AS "stockBefore", stock_after AS "stockAfter",
              source, reverted_at AS "revertedAt", notification_payload AS "notificationPayload"
       FROM sync_audit WHERE id = $1`,
      [Number(id)]
    );
    const row = r.rows[0];
    if (!row) return null;
    return { ...row, revertedAt: row.revertedAt ? new Date(row.revertedAt) : null };
  } catch (e) {
    return null;
  }
}

/** Marca una fila del historial como revertida. */
export async function setAuditReverted(id) {
  const p = getPool();
  if (!p || !id) return false;
  try {
    const r = await p.query(
      'UPDATE sync_audit SET reverted_at = NOW() WHERE id = $1 AND reverted_at IS NULL RETURNING 1',
      [Number(id)]
    );
    return (r.rowCount ?? 0) > 0;
  } catch (e) {
    return false;
  }
}

export function hasDatabase() {
  return !!getPool();
}

const OAUTH_TOKENS_KEY = 'oauth_tokens';

/** Lee el blob de tokens OAuth (ML/TN) desde la base. Para que sobrevivan redeploys en Render. */
export async function getOAuthTokens() {
  const p = getPool();
  if (!p) return null;
  try {
    const r = await p.query('SELECT value FROM oauth_tokens WHERE key = $1', [OAUTH_TOKENS_KEY]);
    return r.rows[0]?.value ?? null;
  } catch (e) {
    console.error('getOAuthTokens:', e.message);
    return null;
  }
}

/** Guarda el blob de tokens OAuth en la base. */
export async function setOAuthTokens(value) {
  const p = getPool();
  if (!p) return false;
  try {
    await p.query(
      `INSERT INTO oauth_tokens (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [OAUTH_TOKENS_KEY, value]
    );
    return true;
  } catch (e) {
    console.error('setOAuthTokens:', e.message);
    return false;
  }
}

/**
 * Devuelve pendientes de devolución (solo status = 'pending'), paginadas.
 */
export async function getPendingReturns(limit = 20, offset = 0) {
  const p = getPool();
  if (!p) return { rows: [], total: 0 };
  try {
    const countResult = await p.query(
      `SELECT COUNT(*)::int AS total FROM sync_pending_returns WHERE status = 'pending'`
    );
    const total = countResult.rows[0]?.total ?? 0;
    const r = await p.query(
      `SELECT id, order_id AS "orderId", sale_order_id AS "saleOrderId", item_id AS "itemId", variation_id AS "variationId",
              sku, quantity, product_label AS "productLabel", reason, buyer_nickname AS "buyerNickname",
              claim_date AS "claimDate", status, created_at AS "createdAt"
       FROM sync_pending_returns
       WHERE status = 'pending'
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [Math.min(limit, 100), offset]
    );
    return {
      rows: r.rows.map(row => ({
        ...row,
        createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
        claimDate: row.claimDate ? new Date(row.claimDate).toISOString() : null
      })),
      total
    };
  } catch (e) {
    console.error('getPendingReturns:', e.message);
    return { rows: [], total: 0 };
  }
}

/**
 * Inserta una devolución pendiente. claimId opcional (para evitar duplicados al traer desde ML).
 */
export async function insertPendingReturn(row) {
  const p = getPool();
  if (!p) return null;
  try {
    const r = await p.query(
      `INSERT INTO sync_pending_returns (claim_id, order_id, sale_order_id, item_id, variation_id, sku, quantity, product_label, reason, buyer_nickname, claim_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending')
       RETURNING id, order_id AS "orderId", sale_order_id AS "saleOrderId", item_id AS "itemId", variation_id AS "variationId",
                 sku, quantity, product_label AS "productLabel", reason, buyer_nickname AS "buyerNickname",
                 claim_date AS "claimDate", status, created_at AS "createdAt"`,
      [
        row.claimId ?? null,
        row.orderId || '',
        row.saleOrderId ?? null,
        row.itemId || '',
        row.variationId ?? null,
        row.sku ?? null,
        row.quantity ?? 1,
        row.productLabel ?? null,
        row.reason ?? null,
        row.buyerNickname ?? null,
        row.claimDate ?? null
      ]
    );
    const out = r.rows[0];
    if (out?.createdAt) out.createdAt = new Date(out.createdAt).toISOString();
    if (out?.claimDate) out.claimDate = new Date(out.claimDate).toISOString();
    return out;
  } catch (e) {
    console.error('insertPendingReturn:', e.message);
    return null;
  }
}

/** Devuelve true si ya existe una fila pendiente para este claim + item (evitar duplicados). */
export async function hasPendingReturnForClaimItem(claimId, itemId, variationId) {
  const p = getPool();
  if (!p || !claimId) return false;
  try {
    const v = variationId ?? null;
    const r = await p.query(
      `SELECT 1 FROM sync_pending_returns
       WHERE claim_id = $1 AND item_id = $2 AND (variation_id IS NOT DISTINCT FROM $3) AND status = 'pending'
       LIMIT 1`,
      [claimId, itemId, v]
    );
    return r.rows.length > 0;
  } catch (e) {
    return false;
  }
}

/**
 * Devuelve true si existe alguna devolución pendiente para la orden. Se busca tanto por order_id
 * (nro de venta / pack) como por sale_order_id (orden individual) porque el webhook de orders
 * conoce el id de la orden, mientras que las filas creadas desde un claim o desde el alta manual
 * guardan el pack como order_id.
 */
export async function hasPendingReturnForOrder(orderId) {
  const p = getPool();
  if (!p || !orderId) return false;
  try {
    const r = await p.query(
      `SELECT 1 FROM sync_pending_returns
       WHERE (order_id = $1 OR sale_order_id = $1) AND status = 'pending' LIMIT 1`,
      [String(orderId)]
    );
    return r.rows.length > 0;
  } catch (e) {
    return false;
  }
}

/**
 * Devuelve true si ya existe una fila pendiente para esta orden + ítem. Es el equivalente a
 * hasPendingReturnForClaimItem para las devoluciones que no tienen claim asociado (p. ej. una
 * entrega fallida, donde ML cancela la orden sin abrir reclamo).
 */
export async function hasPendingReturnForOrderItem(orderId, itemId, variationId) {
  const p = getPool();
  if (!p || !orderId || !itemId) return false;
  try {
    const v = variationId != null ? String(variationId) : null;
    const r = await p.query(
      `SELECT 1 FROM sync_pending_returns
       WHERE (order_id = $1 OR sale_order_id = $1)
         AND item_id = $2 AND (variation_id IS NOT DISTINCT FROM $3) AND status = 'pending'
       LIMIT 1`,
      [String(orderId), String(itemId), v]
    );
    return r.rows.length > 0;
  } catch (e) {
    return false;
  }
}

/**
 * Obtiene una devolución por id.
 */
export async function getPendingReturnById(id) {
  const p = getPool();
  if (!p) return null;
  try {
    const r = await p.query(
      `SELECT id, order_id AS "orderId", sale_order_id AS "saleOrderId", item_id AS "itemId", variation_id AS "variationId",
              sku, quantity, product_label AS "productLabel", status
       FROM sync_pending_returns WHERE id = $1`,
      [id]
    );
    return r.rows[0] || null;
  } catch (e) {
    console.error('getPendingReturnById:', e.message);
    return null;
  }
}

/**
 * Marca una devolución como aprobada (restaurada).
 */
export async function setReturnApproved(id) {
  const p = getPool();
  if (!p) return false;
  try {
    await p.query(
      `UPDATE sync_pending_returns SET status = 'approved', approved_at = NOW() WHERE id = $1 AND status = 'pending'`,
      [id]
    );
    return true;
  } catch (e) {
    console.error('setReturnApproved:', e.message);
    return false;
  }
}

/**
 * Encola una tarea de actualización de ML (stock o SKU).
 * Con idempotency_key, si ya existe una tarea igual pendiente la pisa (coalescing: la más nueva gana).
 * context_json: datos de auditoría opcionales (orderId, sku, channelSale, etc.) que el worker usa al completar.
 */
export async function enqueueMlTask({ kind, itemId, variationId = null, targetQty = null, targetSku = null, targetPrice = null, contextJson = null, idempotencyKey = null }) {
  const p = getPool();
  if (!p) return null;
  try {
    const r = await p.query(
      `INSERT INTO ml_pending_tasks (kind, item_id, variation_id, target_qty, target_sku, target_price, context_json, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (idempotency_key) DO UPDATE
         SET status = 'pending', target_qty = EXCLUDED.target_qty, target_sku = EXCLUDED.target_sku,
             target_price = EXCLUDED.target_price,
             context_json = EXCLUDED.context_json, next_run_at = NOW(), attempts = 0, last_error = NULL, updated_at = NOW()
       RETURNING id`,
      [kind, itemId, variationId, targetQty, targetSku, targetPrice, contextJson, idempotencyKey]
    );
    return r.rows[0]?.id ?? null;
  } catch (e) {
    console.error('enqueueMlTask:', e.message);
    return null;
  }
}

/**
 * Reclama la próxima tarea lista para procesar.
 * Usa FOR UPDATE SKIP LOCKED para que múltiples workers no agarren la misma.
 */
export async function claimNextMlTask() {
  const p = getPool();
  if (!p) return null;
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `SELECT id, kind, item_id AS "itemId", variation_id AS "variationId",
              target_qty AS "targetQty", target_sku AS "targetSku", target_price AS "targetPrice", context_json AS "contextJson", attempts
       FROM ml_pending_tasks
       WHERE (status = 'pending' OR (status = 'failed' AND attempts < 5))
         AND next_run_at <= NOW()
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
    );
    const task = r.rows[0];
    if (!task) { await client.query('COMMIT'); return null; }
    await client.query(
      `UPDATE ml_pending_tasks SET status = 'processing', locked_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [task.id]
    );
    await client.query('COMMIT');
    return task;
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('claimNextMlTask:', e.message);
    return null;
  } finally {
    client.release();
  }
}

/** Marca una tarea como done o failed, actualiza intentos y backoff. */
export async function updateMlTaskStatus(taskId, status, errorMsg = null) {
  const p = getPool();
  if (!p) return false;
  try {
    let nextRunAt = new Date();
    if (status === 'failed') {
      // Backoff exponencial: 10s, 40s, 90s, 160s, 250s
      const r = await p.query('SELECT attempts FROM ml_pending_tasks WHERE id = $1', [taskId]);
      const attempts = (r.rows[0]?.attempts ?? 0) + 1;
      nextRunAt = new Date(Date.now() + Math.pow(attempts, 2) * 10_000);
    }
    await p.query(
      `UPDATE ml_pending_tasks
       SET status = $1, last_error = $2, attempts = attempts + 1,
           next_run_at = $3, locked_at = NULL, updated_at = NOW()
       WHERE id = $4`,
      [status, errorMsg, nextRunAt, taskId]
    );
    return true;
  } catch (e) {
    console.error('updateMlTaskStatus:', e.message);
    return false;
  }
}

/** Lista tareas activas (pending/processing/failed) para la UI, paginadas. */
export async function getPendingMlTasks(limit = 20, offset = 0) {
  const p = getPool();
  if (!p) return { tasks: [], total: 0, activeCount: 0, failedCount: 0 };
  try {
    const countResult = await p.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status IN ('pending', 'processing'))::int AS "activeCount",
         COUNT(*) FILTER (WHERE status = 'failed')::int AS "failedCount"
       FROM ml_pending_tasks
       WHERE status IN ('pending', 'processing', 'failed')`
    );
    const { total, activeCount, failedCount } = countResult.rows[0] ?? { total: 0, activeCount: 0, failedCount: 0 };
    const r = await p.query(
      `SELECT id, kind, item_id AS "itemId", variation_id AS "variationId",
              target_qty AS "targetQty", target_sku AS "targetSku", target_price AS "targetPrice",
              status, attempts, last_error AS "lastError",
              created_at AS "createdAt", updated_at AS "updatedAt", next_run_at AS "nextRunAt"
       FROM ml_pending_tasks
       WHERE status IN ('pending', 'processing', 'failed')
       ORDER BY updated_at DESC
       LIMIT $1 OFFSET $2`,
      [Math.min(limit, 100), offset]
    );
    return {
      tasks: r.rows.map(row => ({
        ...row,
        targetPrice: row.targetPrice != null ? Number(row.targetPrice) : null,
        createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
        updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
        nextRunAt: row.nextRunAt ? new Date(row.nextRunAt).toISOString() : null,
      })),
      total,
      activeCount,
      failedCount
    };
  } catch (e) {
    console.error('getPendingMlTasks:', e.message);
    return { tasks: [], total: 0, activeCount: 0, failedCount: 0 };
  }
}

/**
 * Tareas todavía en vuelo (pending/processing), solo con lo necesario para identificar a qué
 * ítem/variación afectan. Lo usa Precio y stock para distinguir "todavía no lo apliqué" de
 * "los canales difieren de verdad": sin esto, una tarea encolada se ve igual que un conflicto.
 *
 * A diferencia de getPendingMlTasks (que pagina para la tab Cola ML), acá hacen falta TODAS:
 * una tarea que quede fuera de la página mostraría un conflicto falso en su fila. Es una lista
 * corta — las tareas se procesan cada 500ms — y las filas pesan tres campos.
 *
 * No incluye 'failed' a propósito: si la tarea falló, el canal quedó desincronizado de verdad
 * y la fila DEBE mostrar el conflicto. El reintento vive en la tab Cola ML.
 */
export async function getActiveMlTasks() {
  const p = getPool();
  if (!p) return [];
  try {
    const r = await p.query(
      `SELECT kind, item_id AS "itemId", variation_id AS "variationId"
         FROM ml_pending_tasks
        WHERE status IN ('pending', 'processing')`
    );
    return r.rows;
  } catch (e) {
    console.error('getActiveMlTasks:', e.message);
    return [];
  }
}

/** Reinicia una tarea failed para que el worker la reintente. */
export async function retryMlTask(taskId) {
  const p = getPool();
  if (!p) return false;
  try {
    const r = await p.query(
      `UPDATE ml_pending_tasks
       SET status = 'pending', attempts = 0, last_error = NULL, next_run_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'failed'`,
      [taskId]
    );
    return (r.rowCount ?? 0) > 0;
  } catch (e) {
    console.error('retryMlTask:', e.message);
    return false;
  }
}

/** Estado puntual de una tarea (cualquier status, incluido done). */
export async function getMlTaskStatus(taskId) {
  const p = getPool();
  if (!p) return null;
  try {
    const r = await p.query(
      `SELECT id, kind, status, last_error AS "lastError", attempts, updated_at AS "updatedAt"
       FROM ml_pending_tasks WHERE id = $1`,
      [taskId]
    );
    return r.rows[0] ?? null;
  } catch (e) {
    console.error('getMlTaskStatus:', e.message);
    return null;
  }
}

/**
 * Espera a que una tarea encolada de ML termine (done/failed) o hasta agotar el timeout.
 * Las escrituras a ML (stock_ml) las aplica el worker en segundo plano (cada 500ms), así que el
 * historial no refleja el cambio hasta que la tarea termina. Para acciones manuales donde el
 * usuario espera ver el resultado ya reflejado (reintentar venta, revertir), se espera acá en vez
 * de devolver "ok" antes de que exista el registro en sync_audit.
 */
export async function waitForMlTask(taskId, timeoutMs = 15000, pollMs = 400) {
  if (!taskId) return null;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await getMlTaskStatus(taskId);
    if (!status || status.status === 'done' || status.status === 'failed') return status;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  return null;
}
