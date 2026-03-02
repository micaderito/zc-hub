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
    return true;
  } catch (e) {
    console.error('DB init error:', e.message);
    return false;
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

/**
 * Registra una línea del historial de sincronización.
 * @param {object} row - { channelSale, orderId, sku, productLabel?, quantity, updatedChannel, stockBefore, stockAfter }
 */
export async function insertAuditLog(row) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(
      `INSERT INTO sync_audit (channel_sale, order_id, sku, product_label, quantity, updated_channel, stock_before, stock_after)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        row.channelSale,
        row.orderId || '',
        row.sku || '',
        row.productLabel ?? null,
        row.quantity ?? 0,
        row.updatedChannel,
        row.stockBefore ?? 0,
        row.stockAfter ?? 0
      ]
    );
  } catch (e) {
    console.error('insertAuditLog:', e.message);
  }
}

/**
 * Lista el historial de sincronización (más recientes primero).
 * @param {number} limit
 * @param {number} offset
 */
export async function getAuditLog(limit = 100, offset = 0) {
  const p = getPool();
  if (!p) return { rows: [], total: 0 };
  try {
    const countResult = await p.query('SELECT COUNT(*)::int AS total FROM sync_audit');
    const total = countResult.rows[0]?.total ?? 0;
    const result = await p.query(
      `SELECT id, channel_sale AS "channelSale", order_id AS "orderId", sku, product_label AS "productLabel",
              quantity, updated_channel AS "updatedChannel", stock_before AS "stockBefore", stock_after AS "stockAfter",
              created_at AS "createdAt"
       FROM sync_audit
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [Math.min(limit, 500), offset]
    );
    const rows = result.rows.map(r => ({
      ...r,
      createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null
    }));
    return { rows, total };
  } catch (e) {
    console.error('getAuditLog:', e.message);
    return { rows: [], total: 0 };
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
 * Devuelve pendientes de devolución (solo status = 'pending').
 */
export async function getPendingReturns() {
  const p = getPool();
  if (!p) return [];
  try {
    const r = await p.query(
      `SELECT id, order_id AS "orderId", item_id AS "itemId", variation_id AS "variationId",
              sku, quantity, product_label AS "productLabel", status, created_at AS "createdAt"
       FROM sync_pending_returns
       WHERE status = 'pending'
       ORDER BY created_at DESC`
    );
    return r.rows.map(row => ({
      ...row,
      createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null
    }));
  } catch (e) {
    console.error('getPendingReturns:', e.message);
    return [];
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
      `INSERT INTO sync_pending_returns (claim_id, order_id, item_id, variation_id, sku, quantity, product_label, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
       RETURNING id, order_id AS "orderId", item_id AS "itemId", variation_id AS "variationId",
                 sku, quantity, product_label AS "productLabel", status, created_at AS "createdAt"`,
      [
        row.claimId ?? null,
        row.orderId || '',
        row.itemId || '',
        row.variationId ?? null,
        row.sku ?? null,
        row.quantity ?? 1,
        row.productLabel ?? null
      ]
    );
    const out = r.rows[0];
    if (out?.createdAt) out.createdAt = new Date(out.createdAt).toISOString();
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
 * Obtiene una devolución por id.
 */
export async function getPendingReturnById(id) {
  const p = getPool();
  if (!p) return null;
  try {
    const r = await p.query(
      `SELECT id, order_id AS "orderId", item_id AS "itemId", variation_id AS "variationId",
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
