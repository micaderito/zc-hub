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
    // Locks vencidos: tareas que quedaron en 'processing' porque el worker que las tenía se murió.
    // claimNextMlTask las busca en cada tick, así que necesitan su propio índice — el parcial de
    // arriba solo cubre pending/failed.
    await p.query(`
      CREATE INDEX IF NOT EXISTS idx_ml_pending_tasks_stale_lock
      ON ml_pending_tasks(locked_at)
      WHERE status = 'processing';
    `);
    // Migración: agrega target_price a tablas ya creadas (price_ml).
    await p.query(`ALTER TABLE ml_pending_tasks ADD COLUMN IF NOT EXISTS target_price NUMERIC(15,2);`);

    // ── Sección de Precios (fase 2) ─────────────────────────────────────────────
    // Valores fijos del motor de precios: una sola fila, precargada con los del Excel y editable
    // desde Ajustes. Ver backend/src/lib/pricing.js (DEFAULT_SETTINGS) para el significado.
    await p.query(`
      CREATE TABLE IF NOT EXISTS pricing_settings (
        id INTEGER PRIMARY KEY DEFAULT 1,
        commission_pct NUMERIC(6,3) NOT NULL DEFAULT 15,
        taxes NUMERIC(15,2) NOT NULL DEFAULT 300,
        shipping_cost NUMERIC(15,2) NOT NULL DEFAULT 6500,
        free_shipping_threshold NUMERIC(15,2) NOT NULL DEFAULT 33000,
        card_multiplier NUMERIC(6,3) NOT NULL DEFAULT 1.3,
        round_step INTEGER NOT NULL DEFAULT 50,
        default_margin_pct NUMERIC(6,3) NOT NULL DEFAULT 100,
        default_discount_1 NUMERIC(6,3) NOT NULL DEFAULT 25,
        default_discount_2 NUMERIC(6,3) NOT NULL DEFAULT 5,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT pricing_settings_singleton CHECK (id = 1)
      );
    `);
    await p.query(`INSERT INTO pricing_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;`);

    // Tramos de comisión fija de ML: hasta max_price (precio publicado), la fija es fixed_fee.
    // NULL en max_price = tramo superior (sin tope). Precargados con los del Excel.
    await p.query(`
      CREATE TABLE IF NOT EXISTS ml_fee_tiers (
        id SERIAL PRIMARY KEY,
        max_price NUMERIC(15,2),
        fixed_fee NUMERIC(15,2) NOT NULL,
        sort_order INTEGER NOT NULL
      );
    `);
    const tierCount = await p.query(`SELECT COUNT(*)::int AS n FROM ml_fee_tiers`);
    if ((tierCount.rows[0]?.n ?? 0) === 0) {
      await p.query(
        `INSERT INTO ml_fee_tiers (max_price, fixed_fee, sort_order) VALUES
           (15000, 1115, 1), (25000, 2300, 2), (33000, 2810, 3), (NULL, 0, 4)`
      );
    }

    // Costo vigente de cada producto del hub. source='manual' (proveedores sin PDF, se carga a
    // mano por bulto o unidad) o 'list' (viene de una lista importada — fase 3). margin_override
    // permite ganancia propia por producto (Chino/Pagoda la varían).
    await p.query(`
      CREATE TABLE IF NOT EXISTS product_costs (
        sku VARCHAR(128) PRIMARY KEY,
        source VARCHAR(16) NOT NULL DEFAULT 'manual',
        bulk_price NUMERIC(15,2),
        bulk_qty INTEGER,
        unit_cost NUMERIC(15,2),
        discount_1 NUMERIC(6,3) NOT NULL DEFAULT 0,
        discount_2 NUMERIC(6,3) NOT NULL DEFAULT 0,
        margin_override NUMERIC(6,3),
        label VARCHAR(512),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Historial de cambios de PRECIO, gemela de sync_audit pero con semántica de precio: los
    // montos son NUMERIC (no enteros) y hay uno por canal. Se mantiene aparte en vez de meter
    // columnas de precio en sync_audit, cuyo nombre y consumidores asumen stock. El modal de
    // historial del producto consulta las dos y las fusiona en una sola línea de tiempo.
    await p.query(`
      CREATE TABLE IF NOT EXISTS price_audit (
        id SERIAL PRIMARY KEY,
        sku VARCHAR(128) NOT NULL,
        channel VARCHAR(32) NOT NULL,
        price_before NUMERIC(15,2),
        price_after NUMERIC(15,2) NOT NULL,
        source VARCHAR(16) NOT NULL DEFAULT 'bulk',
        product_label VARCHAR(512),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_price_audit_sku_created ON price_audit (sku, created_at DESC);`);

    // ── Listas del proveedor y mapeo (fase 4) ──────────────────────────────────
    // Catálogo de códigos del proveedor. Vive aparte de las listas importadas para que el mapeo
    // SKU↔código sobreviva a cada importación nueva: cuando entra la lista de marzo, los códigos
    // ya están mapeados y solo cambian los precios. Un código puede no tener SKU (producto que el
    // proveedor vende y el hub no).
    await p.query(`
      CREATE TABLE IF NOT EXISTS supplier_codes (
        code VARCHAR(128) PRIMARY KEY,
        supplier VARCHAR(64) NOT NULL DEFAULT 'punto_cero',
        description VARCHAR(512),
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await p.query(`
      CREATE TABLE IF NOT EXISTS price_lists (
        id SERIAL PRIMARY KEY,
        supplier VARCHAR(64) NOT NULL DEFAULT 'punto_cero',
        label VARCHAR(256) NOT NULL,
        source_filename VARCHAR(512),
        discount_1 NUMERIC(6,3) NOT NULL DEFAULT 0,
        discount_2 NUMERIC(6,3) NOT NULL DEFAULT 0,
        imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await p.query(`
      CREATE TABLE IF NOT EXISTS price_list_items (
        id SERIAL PRIMARY KEY,
        list_id INTEGER NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
        code VARCHAR(128) NOT NULL,
        description VARCHAR(512),
        unit_price NUMERIC(15,2),
        bulk_qty INTEGER,
        bulk_price NUMERIC(15,2)
      );
    `);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_price_list_items_list ON price_list_items (list_id);`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_price_list_items_code ON price_list_items (code);`);

    // El puente SKU del hub ↔ código del proveedor. Se llena UNA vez (a mano o confirmando una
    // sugerencia) y de ahí en más no se vuelve a preguntar. Un SKU puede no tener código (producto
    // de otra marca, con costo cargado a mano).
    await p.query(`
      CREATE TABLE IF NOT EXISTS sku_code_map (
        sku VARCHAR(128) PRIMARY KEY,
        code VARCHAR(128) NOT NULL,
        supplier VARCHAR(64) NOT NULL DEFAULT 'punto_cero',
        match_source VARCHAR(16) NOT NULL DEFAULT 'manual',
        confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_sku_code_map_code ON sku_code_map (code);`);

    // ── Alertas de stock (fase 5) ────────────────────────────────────────────────
    // Una alerta por SKU: la usuaria elige a mano qué producto vigilar y con qué umbral — nunca hay
    // default global (ver CLAUDE.md). `state` guarda si la regla está disparada, para no repetir el
    // aviso mientras el stock siga bajo (histéresis): solo se inserta una notificación en la
    // transición ok→triggered; al subir estrictamente por encima del umbral vuelve a 'ok'.
    await p.query(`
      CREATE TABLE IF NOT EXISTS stock_alerts (
        sku VARCHAR(128) PRIMARY KEY,
        threshold INTEGER NOT NULL,
        product_label VARCHAR(512),
        state VARCHAR(16) NOT NULL DEFAULT 'ok',
        muted_until TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Una fila por aviso disparado (no por regla): la lista "Para reponer" agrupa estas filas por
    // SKU desde una fecha de corte. Nada se borra al cerrar un período (ver stock_alerts_last_order_at
    // más abajo, en sync_settings): el historial completo sigue disponible eligiendo "Todo".
    await p.query(`
      CREATE TABLE IF NOT EXISTS stock_notifications (
        id SERIAL PRIMARY KEY,
        sku VARCHAR(128) NOT NULL,
        product_label VARCHAR(512),
        threshold INTEGER NOT NULL,
        stock_ml INTEGER,
        stock_tn INTEGER,
        stock_effective INTEGER NOT NULL,
        read_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    // Contador de la campanita: solo interesan las no leídas, siempre ordenadas por fecha.
    await p.query(`
      CREATE INDEX IF NOT EXISTS idx_stock_notifications_unread
      ON stock_notifications (created_at DESC) WHERE read_at IS NULL;
    `);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_stock_notifications_sku_created ON stock_notifications (sku, created_at DESC);`);

    // ── Packs: la unidad de compra al proveedor (fase 5) ────────────────────────
    // Un pack agrupa SKUs que se compran juntos al proveedor: "assorted" (surtido, la mezcla la
    // arma el proveedor) o "single" (N unidades del mismo modelo). No todos los productos tienen
    // pack — sin fila en pack_skus, el SKU se pide suelto. La alerta sigue siendo siempre por
    // producto; el pack solo agrupa y suma para el pedido.
    await p.query(`
      CREATE TABLE IF NOT EXISTS product_packs (
        id SERIAL PRIMARY KEY,
        name VARCHAR(256) NOT NULL,
        unit_count INTEGER NOT NULL DEFAULT 8,
        mode VARCHAR(16) NOT NULL DEFAULT 'assorted',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    // Un SKU pertenece a lo sumo a un pack (PK = sku). Puente aparte de stock_alerts porque el pack
    // es del PRODUCTO: vale igual para un SKU que no tiene ninguna alerta configurada.
    await p.query(`
      CREATE TABLE IF NOT EXISTS pack_skus (
        sku VARCHAR(128) PRIMARY KEY,
        pack_id INTEGER NOT NULL REFERENCES product_packs(id) ON DELETE CASCADE
      );
    `);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_pack_skus_pack ON pack_skus (pack_id);`);

    // ── Depósito Marañón ──────────────────────────────────────────────────────
    // Stock físico guardado en el depósito, aparte del publicado en ML/TN. item_type='producto'
    // linkea un SKU real del catálogo (autocomplete contra ML/TN); 'embalaje' es material sin
    // canal (rollos, cinta) que nunca fue ni va a ser un producto publicado, por eso sku es NULL.
    await p.query(`
      CREATE TABLE IF NOT EXISTS deposito_stock (
        id SERIAL PRIMARY KEY,
        sku VARCHAR(128),
        label VARCHAR(512) NOT NULL,
        item_type VARCHAR(16) NOT NULL DEFAULT 'producto' CHECK (item_type IN ('producto', 'embalaje')),
        quantity INTEGER NOT NULL DEFAULT 0,
        unit VARCHAR(32) NOT NULL DEFAULT 'unidades',
        notes VARCHAR(1024),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_deposito_stock_sku ON deposito_stock (sku);`);
    // Precarga los dos insumos de embalaje que ya se guardan en Marañón. Solo si la tabla está
    // vacía: así una fila borrada a mano (ya no se compra ese insumo) no resucita en cada reinicio.
    const depositoCount = await p.query(`SELECT COUNT(*)::int AS n FROM deposito_stock`);
    if ((depositoCount.rows[0]?.n ?? 0) === 0) {
      await p.query(
        `INSERT INTO deposito_stock (label, item_type, unit, quantity) VALUES
           ('Rollo de burbupack', 'embalaje', 'rollos', 0),
           ('Rollo de cartón corrugado', 'embalaje', 'rollos', 0)`
      );
    }

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
 * Marca una devolución como descartada: sale de la lista sin tocar stock.
 *
 * Existe porque no toda fila pendiente termina en una restauración. Una cancelación por falta de
 * stock deja la unidad donde estaba (en ningún lado), así que la única acción correcta es sacarla
 * de la lista; sin esto quedaría pendiente para siempre y la lista dejaría de servir como aviso.
 * @returns {boolean} true si había una fila pendiente con ese id.
 */
export async function setReturnDismissed(id) {
  const p = getPool();
  if (!p) return false;
  try {
    const r = await p.query(
      `UPDATE sync_pending_returns SET status = 'dismissed' WHERE id = $1 AND status = 'pending'`,
      [id]
    );
    return r.rowCount > 0;
  } catch (e) {
    console.error('setReturnDismissed:', e.message);
    return false;
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
 * Cuánto puede pasar sin latido antes de dar por muerto al worker que tenía la tarea.
 *
 * El worker refresca `locked_at` cada MLTASK_HEARTBEAT_MS mientras procesa (ver touchMlTaskLock),
 * así que un `locked_at` viejo NO significa "tarea lenta" sino "el proceso se cayó" — un deploy,
 * un OOM, un reinicio del host. Por eso el umbral puede ser corto: son ~4 latidos perdidos.
 *
 * Sin latido no habría forma de distinguir una tarea trabada de una legítimamente larga: con ML
 * en 429 sostenido, el circuit breaker de mlLimiter puede pausar el caño hasta 5 min por intento,
 * y reclamar una tarea viva duplicaría un stock_ml (que es un delta, no un valor absoluto).
 */
export const MLTASK_HEARTBEAT_MS = 30_000;
export const MLTASK_STALE_LOCK_MS = 4 * MLTASK_HEARTBEAT_MS;

/**
 * Reclama la próxima tarea lista para procesar.
 * Usa FOR UPDATE SKIP LOCKED para que múltiples workers no agarren la misma.
 *
 * Además de pending/failed, recupera las tareas que quedaron en 'processing' con el lock vencido:
 * son las que estaba corriendo un worker que se murió (deploy a mitad de camino, típicamente).
 * Sin esto quedaban trabadas para siempre — 'processing' no volvía a entrar nunca en esta query.
 * La recuperación cuenta como intento (attempts + 1) para que una tarea que voltee al proceso una
 * y otra vez termine en failed en vez de reiniciarlo en loop.
 */
export async function claimNextMlTask() {
  const p = getPool();
  if (!p) return null;
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `SELECT id, kind, item_id AS "itemId", variation_id AS "variationId",
              target_qty AS "targetQty", target_sku AS "targetSku", target_price AS "targetPrice",
              context_json AS "contextJson", attempts, status
       FROM ml_pending_tasks
       WHERE (
               ((status = 'pending' OR (status = 'failed' AND attempts < 5)) AND next_run_at <= NOW())
               OR (status = 'processing' AND attempts < 5
                   AND locked_at IS NOT NULL AND locked_at < NOW() - ($1::int * INTERVAL '1 millisecond'))
             )
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [MLTASK_STALE_LOCK_MS]
    );
    const task = r.rows[0];
    if (!task) { await client.query('COMMIT'); return null; }
    const reclaimed = task.status === 'processing';
    await client.query(
      `UPDATE ml_pending_tasks
       SET status = 'processing', locked_at = NOW(), updated_at = NOW(),
           attempts = attempts + $2,
           last_error = CASE WHEN $2 = 1 THEN 'Recuperada: el worker anterior se cortó a mitad de la tarea' ELSE last_error END
       WHERE id = $1`,
      [task.id, reclaimed ? 1 : 0]
    );
    await client.query('COMMIT');
    if (reclaimed) {
      console.warn(`[MLQueue] Tarea ${task.id} (${task.kind}) recuperada: lock vencido, el worker anterior no terminó.`);
    }
    const { status, ...claimed } = task;
    return { ...claimed, attempts: task.attempts + (reclaimed ? 1 : 0) };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('claimNextMlTask:', e.message);
    return null;
  } finally {
    client.release();
  }
}

/**
 * Latido del worker sobre la tarea que está procesando: refresca `locked_at` para que otro worker
 * (o este mismo tras un reinicio) no la dé por abandonada mientras sigue viva. No toca `updated_at`
 * para no mover la columna "Actualizado" que ve la usuaria en la UI cada 30s.
 */
export async function touchMlTaskLock(taskId) {
  const p = getPool();
  if (!p) return false;
  try {
    const r = await p.query(
      `UPDATE ml_pending_tasks SET locked_at = NOW() WHERE id = $1 AND status = 'processing'`,
      [taskId]
    );
    return (r.rowCount ?? 0) > 0;
  } catch (e) {
    console.error('touchMlTaskLock:', e.message);
    return false;
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
              created_at AS "createdAt", updated_at AS "updatedAt", next_run_at AS "nextRunAt",
              (status = 'processing' AND locked_at IS NOT NULL
               AND locked_at < NOW() - ($3::int * INTERVAL '1 millisecond')) AS "stuck"
       FROM ml_pending_tasks
       WHERE status IN ('pending', 'processing', 'failed')
       ORDER BY updated_at DESC
       LIMIT $1 OFFSET $2`,
      [Math.min(limit, 100), offset, MLTASK_STALE_LOCK_MS]
    );
    return {
      tasks: r.rows.map(row => ({
        ...row,
        targetPrice: row.targetPrice != null ? Number(row.targetPrice) : null,
        stuck: row.stuck === true,
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

/**
 * Reinicia una tarea para que el worker la reintente.
 *
 * Acepta las 'failed' y también las 'processing' con el lock vencido (trabadas por un worker que
 * murió): el worker las recupera solo, pero el botón evita esperar el timeout. Una 'processing'
 * con lock fresco NO se puede reintentar a mano — está corriendo de verdad y reencolarla
 * duplicaría el cambio.
 */
export async function retryMlTask(taskId) {
  const p = getPool();
  if (!p) return false;
  try {
    const r = await p.query(
      `UPDATE ml_pending_tasks
       SET status = 'pending', attempts = 0, last_error = NULL, next_run_at = NOW(),
           locked_at = NULL, updated_at = NOW()
       WHERE id = $1
         AND (status = 'failed'
              OR (status = 'processing' AND locked_at IS NOT NULL
                  AND locked_at < NOW() - ($2::int * INTERVAL '1 millisecond')))`,
      [taskId, MLTASK_STALE_LOCK_MS]
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

// ── Sección de Precios (fase 2) ───────────────────────────────────────────────

/**
 * Devuelve los valores fijos del motor de precios (fila única) + los tramos de comisión, en el
 * formato camelCase que consume lib/pricing.js (settings + tiers). Si no hay DB, devuelve null y
 * el que llama usa DEFAULT_SETTINGS.
 */
export async function getPricingSettings() {
  const p = getPool();
  if (!p) return null;
  try {
    const r = await p.query(
      `SELECT commission_pct AS "commissionPct", taxes, shipping_cost AS "shippingCost",
              free_shipping_threshold AS "freeShippingThreshold", card_multiplier AS "cardMultiplier",
              round_step AS "roundStep", default_margin_pct AS "defaultMarginPct",
              default_discount_1 AS "defaultDiscount1", default_discount_2 AS "defaultDiscount2",
              updated_at AS "updatedAt"
       FROM pricing_settings WHERE id = 1`
    );
    const row = r.rows[0];
    if (!row) return null;
    const tiersRes = await p.query(
      `SELECT max_price AS "maxPrice", fixed_fee AS "fixedFee"
       FROM ml_fee_tiers ORDER BY sort_order ASC`
    );
    const num = (v) => (v == null ? v : Number(v));
    return {
      commissionPct: num(row.commissionPct),
      taxes: num(row.taxes),
      shippingCost: num(row.shippingCost),
      freeShippingThreshold: num(row.freeShippingThreshold),
      cardMultiplier: num(row.cardMultiplier),
      roundStep: num(row.roundStep),
      defaultMarginPct: num(row.defaultMarginPct),
      defaultDiscount1: num(row.defaultDiscount1),
      defaultDiscount2: num(row.defaultDiscount2),
      updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
      tiers: tiersRes.rows.map((t) => ({
        maxPrice: t.maxPrice == null ? Infinity : Number(t.maxPrice),
        fixedFee: Number(t.fixedFee),
      })),
    };
  } catch (e) {
    console.error('getPricingSettings:', e.message);
    return null;
  }
}

/** Actualiza los valores fijos del motor. Solo pisa las claves presentes en `patch`. */
export async function savePricingSettings(patch = {}) {
  const p = getPool();
  if (!p) return false;
  const COLS = {
    commissionPct: 'commission_pct', taxes: 'taxes', shippingCost: 'shipping_cost',
    freeShippingThreshold: 'free_shipping_threshold', cardMultiplier: 'card_multiplier',
    roundStep: 'round_step', defaultMarginPct: 'default_margin_pct',
    defaultDiscount1: 'default_discount_1', defaultDiscount2: 'default_discount_2',
  };
  const sets = [];
  const vals = [];
  for (const [key, col] of Object.entries(COLS)) {
    if (patch[key] != null && Number.isFinite(Number(patch[key]))) {
      vals.push(Number(patch[key]));
      sets.push(`${col} = $${vals.length}`);
    }
  }
  if (sets.length === 0) return true;
  try {
    await p.query(`UPDATE pricing_settings SET ${sets.join(', ')}, updated_at = NOW() WHERE id = 1`, vals);
    return true;
  } catch (e) {
    console.error('savePricingSettings:', e.message);
    return false;
  }
}

/** Reemplaza los tramos de comisión fija (borra y reinserta en una transacción). */
export async function saveMlFeeTiers(tiers) {
  const p = getPool();
  if (!p || !Array.isArray(tiers) || tiers.length === 0) return false;
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM ml_fee_tiers');
    let order = 0;
    for (const t of tiers) {
      order += 1;
      const maxPrice = t.maxPrice == null || !Number.isFinite(Number(t.maxPrice)) ? null : Number(t.maxPrice);
      await client.query(
        `INSERT INTO ml_fee_tiers (max_price, fixed_fee, sort_order) VALUES ($1, $2, $3)`,
        [maxPrice, Number(t.fixedFee) || 0, order]
      );
    }
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('saveMlFeeTiers:', e.message);
    return false;
  } finally {
    client.release();
  }
}

/** El costo vigente de un SKU, o null. */
export async function getProductCost(sku) {
  const p = getPool();
  if (!p) return null;
  try {
    const r = await p.query(`${PRODUCT_COST_SELECT} WHERE sku = $1`, [sku]);
    return r.rows[0] ? mapProductCost(r.rows[0]) : null;
  } catch (e) {
    console.error('getProductCost:', e.message);
    return null;
  }
}

/** Todos los costos cargados (para el preview). */
export async function getAllProductCosts() {
  const p = getPool();
  if (!p) return [];
  try {
    const r = await p.query(`${PRODUCT_COST_SELECT} ORDER BY updated_at DESC`);
    return r.rows.map(mapProductCost);
  } catch (e) {
    console.error('getAllProductCosts:', e.message);
    return [];
  }
}

const PRODUCT_COST_SELECT = `SELECT sku, source, bulk_price AS "bulkPrice", bulk_qty AS "bulkQty",
  unit_cost AS "unitCost", discount_1 AS "discount1", discount_2 AS "discount2",
  margin_override AS "marginOverride", label, updated_at AS "updatedAt" FROM product_costs`;

function mapProductCost(row) {
  const num = (v) => (v == null ? null : Number(v));
  return {
    sku: row.sku,
    source: row.source,
    bulkPrice: num(row.bulkPrice),
    bulkQty: row.bulkQty == null ? null : Number(row.bulkQty),
    unitCost: num(row.unitCost),
    discount1: num(row.discount1),
    discount2: num(row.discount2),
    marginOverride: num(row.marginOverride),
    label: row.label,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  };
}

/** Alta/edición del costo de un SKU (upsert). */
export async function upsertProductCost(sku, data = {}) {
  const p = getPool();
  if (!p || !sku) return false;
  const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  try {
    await p.query(
      `INSERT INTO product_costs (sku, source, bulk_price, bulk_qty, unit_cost, discount_1, discount_2, margin_override, label, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       ON CONFLICT (sku) DO UPDATE SET
         source = EXCLUDED.source, bulk_price = EXCLUDED.bulk_price, bulk_qty = EXCLUDED.bulk_qty,
         unit_cost = EXCLUDED.unit_cost, discount_1 = EXCLUDED.discount_1, discount_2 = EXCLUDED.discount_2,
         margin_override = EXCLUDED.margin_override, label = EXCLUDED.label, updated_at = NOW()`,
      [
        sku, data.source || 'manual', num(data.bulkPrice), num(data.bulkQty), num(data.unitCost),
        num(data.discount1) ?? 0, num(data.discount2) ?? 0, num(data.marginOverride), data.label ?? null,
      ]
    );
    return true;
  } catch (e) {
    console.error('upsertProductCost:', e.message);
    return false;
  }
}

/** Borra el costo de un SKU. */
export async function deleteProductCost(sku) {
  const p = getPool();
  if (!p || !sku) return false;
  try {
    await p.query('DELETE FROM product_costs WHERE sku = $1', [sku]);
    return true;
  } catch (e) {
    console.error('deleteProductCost:', e.message);
    return false;
  }
}

/**
 * Registra un cambio de precio en el historial. `priceBefore` puede venir null (si el snapshot no
 * tenía la fila); la fila se guarda igual porque el "a cuánto quedó" ya es información útil.
 */
export async function insertPriceAudit(row) {
  const p = getPool();
  if (!p || !row?.sku || row.priceAfter == null) return false;
  try {
    await p.query(
      `INSERT INTO price_audit (sku, channel, price_before, price_after, source, product_label)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        row.sku,
        row.channel,
        row.priceBefore ?? null,
        row.priceAfter,
        row.source || 'bulk',
        row.productLabel ?? null,
      ]
    );
    return true;
  } catch (e) {
    console.error('insertPriceAudit:', e.message);
    return false;
  }
}

/** Historial de precios de un SKU (ambos canales), más reciente primero. */
export async function getPriceHistoryBySku(sku, limit = 50, offset = 0) {
  const p = getPool();
  if (!p) return { rows: [], total: 0 };
  try {
    const countResult = await p.query('SELECT COUNT(*)::int AS total FROM price_audit WHERE sku = $1', [sku]);
    const r = await p.query(
      `SELECT id, sku, channel, price_before AS "priceBefore", price_after AS "priceAfter",
              source, product_label AS "productLabel", created_at AS "createdAt"
       FROM price_audit WHERE sku = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [sku, Math.min(limit, 200), offset]
    );
    return {
      rows: r.rows.map((row) => ({
        ...row,
        priceBefore: row.priceBefore == null ? null : Number(row.priceBefore),
        priceAfter: Number(row.priceAfter),
        createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
      })),
      total: countResult.rows[0]?.total ?? 0,
    };
  } catch (e) {
    console.error('getPriceHistoryBySku:', e.message);
    return { rows: [], total: 0 };
  }
}

// ── Listas del proveedor y mapeo (fase 4) ─────────────────────────────────────

/**
 * Guarda una lista importada: la lista, sus ítems, y refresca el catálogo de códigos
 * (`supplier_codes`), todo en una transacción. Los códigos nuevos se dan de alta y los ya
 * conocidos actualizan `last_seen_at` y su descripción.
 */
export async function savePriceList({ supplier = 'punto_cero', label, sourceFilename = null, discount1 = 0, discount2 = 0, items = [] }) {
  const p = getPool();
  if (!p) return null;
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const listRes = await client.query(
      `INSERT INTO price_lists (supplier, label, source_filename, discount_1, discount_2)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [supplier, label, sourceFilename, Number(discount1) || 0, Number(discount2) || 0]
    );
    const listId = listRes.rows[0].id;

    for (const it of items) {
      if (!it?.code) continue;
      await client.query(
        `INSERT INTO price_list_items (list_id, code, description, unit_price, bulk_qty, bulk_price)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [listId, it.code, it.description ?? null, it.unitPrice ?? null, it.bulkQty ?? null, it.bulkPrice ?? null]
      );
      await client.query(
        `INSERT INTO supplier_codes (code, supplier, description)
         VALUES ($1, $2, $3)
         ON CONFLICT (code) DO UPDATE SET last_seen_at = NOW(),
           description = COALESCE(EXCLUDED.description, supplier_codes.description)`,
        [it.code, supplier, it.description ?? null]
      );
    }
    await client.query('COMMIT');
    return listId;
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('savePriceList:', e.message);
    return null;
  } finally {
    client.release();
  }
}

/** Listas importadas, más reciente primero. */
export async function getPriceLists(limit = 20) {
  const p = getPool();
  if (!p) return [];
  try {
    const r = await p.query(
      `SELECT l.id, l.supplier, l.label, l.source_filename AS "sourceFilename",
              l.discount_1 AS "discount1", l.discount_2 AS "discount2", l.imported_at AS "importedAt",
              (SELECT COUNT(*)::int FROM price_list_items i WHERE i.list_id = l.id) AS "itemCount"
       FROM price_lists l ORDER BY l.imported_at DESC LIMIT $1`,
      [Math.min(limit, 100)]
    );
    return r.rows.map((row) => ({
      ...row,
      discount1: Number(row.discount1),
      discount2: Number(row.discount2),
      importedAt: row.importedAt ? new Date(row.importedAt).toISOString() : null,
    }));
  } catch (e) {
    console.error('getPriceLists:', e.message);
    return [];
  }
}

/** Ítems de una lista (o de la más reciente si no se pasa id), indexados por código. */
export async function getPriceListItems(listId = null) {
  const p = getPool();
  if (!p) return [];
  try {
    const r = listId
      ? await p.query(
          `SELECT code, description, unit_price AS "unitPrice", bulk_qty AS "bulkQty", bulk_price AS "bulkPrice"
           FROM price_list_items WHERE list_id = $1`, [listId])
      : await p.query(
          `SELECT i.code, i.description, i.unit_price AS "unitPrice", i.bulk_qty AS "bulkQty", i.bulk_price AS "bulkPrice"
           FROM price_list_items i
           WHERE i.list_id = (SELECT id FROM price_lists ORDER BY imported_at DESC LIMIT 1)`);
    return r.rows.map((row) => ({
      ...row,
      unitPrice: row.unitPrice == null ? null : Number(row.unitPrice),
      bulkQty: row.bulkQty == null ? null : Number(row.bulkQty),
      bulkPrice: row.bulkPrice == null ? null : Number(row.bulkPrice),
    }));
  } catch (e) {
    console.error('getPriceListItems:', e.message);
    return [];
  }
}

/** Catálogo completo de códigos del proveedor. */
export async function getSupplierCodes(supplier = 'punto_cero') {
  const p = getPool();
  if (!p) return [];
  try {
    const r = await p.query(
      `SELECT code, description, first_seen_at AS "firstSeenAt", last_seen_at AS "lastSeenAt"
       FROM supplier_codes WHERE supplier = $1 ORDER BY code`, [supplier]);
    return r.rows;
  } catch (e) {
    console.error('getSupplierCodes:', e.message);
    return [];
  }
}

/** Todos los mapeos SKU→código confirmados. */
export async function getSkuCodeMap(supplier = 'punto_cero') {
  const p = getPool();
  if (!p) return [];
  try {
    const r = await p.query(
      `SELECT sku, code, match_source AS "matchSource", confirmed_at AS "confirmedAt"
       FROM sku_code_map WHERE supplier = $1`, [supplier]);
    return r.rows.map((row) => ({
      ...row,
      confirmedAt: row.confirmedAt ? new Date(row.confirmedAt).toISOString() : null,
    }));
  } catch (e) {
    console.error('getSkuCodeMap:', e.message);
    return [];
  }
}

/** Confirma (o corrige) el mapeo de un SKU. Se hace una vez y no se vuelve a preguntar. */
export async function upsertSkuCodeMap(sku, code, matchSource = 'manual', supplier = 'punto_cero') {
  const p = getPool();
  if (!p || !sku || !code) return false;
  try {
    await p.query(
      `INSERT INTO sku_code_map (sku, code, supplier, match_source, confirmed_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (sku) DO UPDATE SET code = EXCLUDED.code, supplier = EXCLUDED.supplier,
         match_source = EXCLUDED.match_source, confirmed_at = NOW()`,
      [sku, code, supplier, matchSource]
    );
    return true;
  } catch (e) {
    console.error('upsertSkuCodeMap:', e.message);
    return false;
  }
}

/** Borra el mapeo de un SKU (para rehacerlo). */
export async function deleteSkuCodeMap(sku) {
  const p = getPool();
  if (!p || !sku) return false;
  try {
    await p.query('DELETE FROM sku_code_map WHERE sku = $1', [sku]);
    return true;
  } catch (e) {
    console.error('deleteSkuCodeMap:', e.message);
    return false;
  }
}

// ── Alertas de stock (fase 5) ─────────────────────────────────────────────────

const STOCK_ALERT_SELECT = `SELECT sku, threshold, product_label AS "productLabel", state,
  muted_until AS "mutedUntil", created_at AS "createdAt", updated_at AS "updatedAt" FROM stock_alerts`;

function mapStockAlert(row) {
  return {
    sku: row.sku,
    threshold: Number(row.threshold),
    productLabel: row.productLabel,
    state: row.state,
    mutedUntil: row.mutedUntil ? new Date(row.mutedUntil).toISOString() : null,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  };
}

export async function listStockAlerts() {
  const p = getPool();
  if (!p) return [];
  try {
    const r = await p.query(`${STOCK_ALERT_SELECT} ORDER BY updated_at DESC`);
    return r.rows.map(mapStockAlert);
  } catch (e) {
    console.error('listStockAlerts:', e.message);
    return [];
  }
}

export async function getStockAlert(sku) {
  const p = getPool();
  if (!p || !sku) return null;
  try {
    const r = await p.query(`${STOCK_ALERT_SELECT} WHERE sku = $1`, [sku]);
    return r.rows[0] ? mapStockAlert(r.rows[0]) : null;
  } catch (e) {
    console.error('getStockAlert:', e.message);
    return null;
  }
}

/**
 * Alta/edición de una regla. En un alta nueva arranca en 'ok' (default de la columna); en una
 * edición NO toca `state` a propósito, para que evaluateStockAlerts decida en la próxima pasada
 * si hay que notificar según el umbral nuevo, en vez de resetear a ciegas una regla ya disparada.
 */
export async function upsertStockAlert(sku, { threshold, productLabel } = {}) {
  const p = getPool();
  if (!p || !sku || !Number.isFinite(Number(threshold))) return false;
  try {
    await p.query(
      `INSERT INTO stock_alerts (sku, threshold, product_label, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (sku) DO UPDATE SET
         threshold = EXCLUDED.threshold, product_label = EXCLUDED.product_label, updated_at = NOW()`,
      [sku, Number(threshold), productLabel ?? null]
    );
    return true;
  } catch (e) {
    console.error('upsertStockAlert:', e.message);
    return false;
  }
}

/** Borra una regla (no toca el historial de notificaciones ni el pack del SKU). */
export async function deleteStockAlert(sku) {
  const p = getPool();
  if (!p || !sku) return false;
  try {
    await p.query('DELETE FROM stock_alerts WHERE sku = $1', [sku]);
    return true;
  } catch (e) {
    console.error('deleteStockAlert:', e.message);
    return false;
  }
}

/**
 * Cambia el estado de una regla. Con `expectedState`, el UPDATE es condicional (mismo patrón que
 * tryClaimOrderProcessing): solo un caller concurrente gana la transición, así dos evaluaciones en
 * simultáneo (ej. dos webhooks seguidos) no insertan la misma notificación dos veces.
 */
export async function setStockAlertState(sku, state, { expectedState } = {}) {
  const p = getPool();
  if (!p || !sku) return false;
  try {
    const params = [state, sku];
    let sql = 'UPDATE stock_alerts SET state = $1, updated_at = NOW() WHERE sku = $2';
    if (expectedState) {
      params.push(expectedState);
      sql += ' AND state = $3';
    }
    sql += ' RETURNING 1';
    const r = await p.query(sql, params);
    return (r.rowCount ?? 0) > 0;
  } catch (e) {
    console.error('setStockAlertState:', e.message);
    return false;
  }
}

/** "Silenciar N días": no dispara notificación aunque cruce el umbral, hasta esa fecha. */
export async function muteStockAlert(sku, days) {
  const p = getPool();
  if (!p || !sku) return false;
  const n = Math.max(1, Number(days) || 7);
  try {
    await p.query(
      `UPDATE stock_alerts SET muted_until = NOW() + ($1 * INTERVAL '1 day'), updated_at = NOW() WHERE sku = $2`,
      [n, sku]
    );
    return true;
  } catch (e) {
    console.error('muteStockAlert:', e.message);
    return false;
  }
}

const NOTIFICATION_SELECT = `SELECT id, sku, product_label AS "productLabel", threshold,
  stock_ml AS "stockMl", stock_tn AS "stockTn", stock_effective AS "stockEffective",
  read_at AS "readAt", created_at AS "createdAt" FROM stock_notifications`;

function mapNotification(row) {
  return {
    id: row.id,
    sku: row.sku,
    productLabel: row.productLabel,
    threshold: Number(row.threshold),
    stockMl: row.stockMl == null ? null : Number(row.stockMl),
    stockTn: row.stockTn == null ? null : Number(row.stockTn),
    stockEffective: Number(row.stockEffective),
    readAt: row.readAt ? new Date(row.readAt).toISOString() : null,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
  };
}

/** Inserta un aviso disparado. `stockEffective` es min(ML, TN) al momento del disparo. */
export async function insertStockNotification(row) {
  const p = getPool();
  if (!p || !row?.sku || row.stockEffective == null) return false;
  try {
    await p.query(
      `INSERT INTO stock_notifications (sku, product_label, threshold, stock_ml, stock_tn, stock_effective)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [row.sku, row.productLabel ?? null, row.threshold, row.stockMl ?? null, row.stockTn ?? null, row.stockEffective]
    );
    return true;
  } catch (e) {
    console.error('insertStockNotification:', e.message);
    return false;
  }
}

/** Bandeja de notificaciones, más reciente primero. */
export async function listStockNotifications({ unreadOnly = false, limit = 50, offset = 0 } = {}) {
  const p = getPool();
  if (!p) return { rows: [], total: 0 };
  try {
    const where = unreadOnly ? 'WHERE read_at IS NULL' : '';
    const countResult = await p.query(`SELECT COUNT(*)::int AS total FROM stock_notifications ${where}`);
    const r = await p.query(
      `${NOTIFICATION_SELECT} ${where} ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [Math.min(limit, 200), offset]
    );
    return { rows: r.rows.map(mapNotification), total: countResult.rows[0]?.total ?? 0 };
  } catch (e) {
    console.error('listStockNotifications:', e.message);
    return { rows: [], total: 0 };
  }
}

/** Para el contador de la campanita. */
export async function countUnreadNotifications() {
  const p = getPool();
  if (!p) return 0;
  try {
    const r = await p.query('SELECT COUNT(*)::int AS n FROM stock_notifications WHERE read_at IS NULL');
    return r.rows[0]?.n ?? 0;
  } catch (e) {
    console.error('countUnreadNotifications:', e.message);
    return 0;
  }
}

/** Marca leídas por id, o todas con `{ all: true }`. */
export async function markNotificationsRead({ ids, all = false } = {}) {
  const p = getPool();
  if (!p) return false;
  try {
    if (all) {
      await p.query('UPDATE stock_notifications SET read_at = NOW() WHERE read_at IS NULL');
    } else if (Array.isArray(ids) && ids.length) {
      await p.query(
        'UPDATE stock_notifications SET read_at = NOW() WHERE id = ANY($1::int[]) AND read_at IS NULL',
        [ids.map(Number)]
      );
    }
    return true;
  } catch (e) {
    console.error('markNotificationsRead:', e.message);
    return false;
  }
}

const RESTOCK_CUTOFF_KEY = 'stock_alerts_last_order_at';

/** Fecha desde la que cuenta "Para reponer" (null = sin cerrar nunca un pedido, cuenta desde el principio). */
export async function getRestockCutoff() {
  const p = getPool();
  if (!p) return null;
  try {
    const r = await p.query('SELECT value FROM sync_settings WHERE key = $1', [RESTOCK_CUTOFF_KEY]);
    return r.rows[0]?.value || null;
  } catch (e) {
    console.error('getRestockCutoff:', e.message);
    return null;
  }
}

/** "Marcar pedido como hecho": corta el período desde ahora (o desde el valor que se pase). */
export async function setRestockCutoff(iso = new Date().toISOString()) {
  const p = getPool();
  if (!p) return false;
  try {
    await p.query(
      `INSERT INTO sync_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
      [RESTOCK_CUTOFF_KEY, iso]
    );
    return true;
  } catch (e) {
    console.error('setRestockCutoff:', e.message);
    return false;
  }
}

/**
 * Candidatos a reponer: una fila por SKU con el primer disparo desde `since`, cuántas veces avisó
 * y el último umbral/etiqueta vistos (por si cambiaron entre medio). `since` en `null` trae todo
 * el historial (período "Todo").
 */
export async function listRestockCandidates(since) {
  const p = getPool();
  if (!p) return [];
  try {
    const r = await p.query(
      `SELECT sku,
              (array_agg(product_label ORDER BY created_at DESC))[1] AS "productLabel",
              MIN(created_at) AS "firstTriggeredAt",
              COUNT(*)::int AS "timesTriggered",
              (array_agg(threshold ORDER BY created_at DESC))[1] AS "threshold"
       FROM stock_notifications
       WHERE created_at >= $1
       GROUP BY sku
       ORDER BY "firstTriggeredAt" ASC`,
      [since || new Date(0).toISOString()]
    );
    return r.rows.map((row) => ({
      sku: row.sku,
      productLabel: row.productLabel,
      firstTriggeredAt: row.firstTriggeredAt ? new Date(row.firstTriggeredAt).toISOString() : null,
      timesTriggered: row.timesTriggered,
      threshold: Number(row.threshold),
    }));
  } catch (e) {
    console.error('listRestockCandidates:', e.message);
    return [];
  }
}

// ── Packs: la unidad de compra al proveedor (fase 5) ──────────────────────────

/** Todos los packs, con la lista de SKUs que agrupa cada uno. */
export async function listPacks() {
  const p = getPool();
  if (!p) return [];
  try {
    const packs = await p.query(
      `SELECT id, name, unit_count AS "unitCount", mode, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM product_packs ORDER BY name ASC`
    );
    const skuRows = await p.query('SELECT sku, pack_id AS "packId" FROM pack_skus');
    const bySku = new Map();
    for (const row of skuRows.rows) {
      if (!bySku.has(row.packId)) bySku.set(row.packId, []);
      bySku.get(row.packId).push(row.sku);
    }
    return packs.rows.map((row) => ({
      id: row.id,
      name: row.name,
      unitCount: Number(row.unitCount),
      mode: row.mode,
      skus: bySku.get(row.id) || [],
      createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
      updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    }));
  } catch (e) {
    console.error('listPacks:', e.message);
    return [];
  }
}

/** Alta/edición de un pack. Sin `id`, crea uno nuevo y devuelve su id (o `null` si falló). */
export async function upsertPack({ id, name, unitCount, mode } = {}) {
  const p = getPool();
  if (!p || !name) return null;
  const units = Math.max(1, Number(unitCount) || 8);
  const packMode = mode === 'single' ? 'single' : 'assorted';
  try {
    if (id) {
      const r = await p.query(
        `UPDATE product_packs SET name = $1, unit_count = $2, mode = $3, updated_at = NOW()
         WHERE id = $4 RETURNING id`,
        [name, units, packMode, id]
      );
      return r.rows[0]?.id ?? null;
    }
    const r = await p.query(
      `INSERT INTO product_packs (name, unit_count, mode) VALUES ($1, $2, $3) RETURNING id`,
      [name, units, packMode]
    );
    return r.rows[0]?.id ?? null;
  } catch (e) {
    console.error('upsertPack:', e.message);
    return null;
  }
}

/** Borra un pack; sus SKUs quedan "sin pack" (ON DELETE CASCADE en pack_skus). No toca reglas ni historial. */
export async function deletePack(id) {
  const p = getPool();
  if (!p || !id) return false;
  try {
    await p.query('DELETE FROM product_packs WHERE id = $1', [id]);
    return true;
  } catch (e) {
    console.error('deletePack:', e.message);
    return false;
  }
}

/** Mueve un SKU a un pack, o lo saca si `packId` es `null`. */
export async function setSkuPack(sku, packId) {
  const p = getPool();
  if (!p || !sku) return false;
  try {
    if (packId == null) {
      await p.query('DELETE FROM pack_skus WHERE sku = $1', [sku]);
    } else {
      await p.query(
        `INSERT INTO pack_skus (sku, pack_id) VALUES ($1, $2)
         ON CONFLICT (sku) DO UPDATE SET pack_id = EXCLUDED.pack_id`,
        [sku, packId]
      );
    }
    return true;
  } catch (e) {
    console.error('setSkuPack:', e.message);
    return false;
  }
}

// ── Depósito Marañón ──────────────────────────────────────────────────────

const DEPOSITO_SELECT = `SELECT id, sku, label, item_type AS "itemType", quantity, unit, notes,
  created_at AS "createdAt", updated_at AS "updatedAt" FROM deposito_stock`;

function mapDepositoItem(row) {
  return {
    id: row.id,
    sku: row.sku,
    label: row.label,
    itemType: row.itemType,
    quantity: Number(row.quantity),
    unit: row.unit,
    notes: row.notes,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  };
}

/** Todo el stock de depósito, productos primero. */
export async function getDepositoItems() {
  const p = getPool();
  if (!p) return [];
  try {
    const r = await p.query(`${DEPOSITO_SELECT} ORDER BY item_type, label`);
    return r.rows.map(mapDepositoItem);
  } catch (e) {
    console.error('getDepositoItems:', e.message);
    return [];
  }
}

/** Alta de una fila de depósito (producto vinculado a un SKU o insumo de embalaje). */
export async function createDepositoItem(data = {}) {
  const p = getPool();
  if (!p) return null;
  try {
    const r = await p.query(
      `INSERT INTO deposito_stock (sku, label, item_type, quantity, unit, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, sku, label, item_type AS "itemType", quantity, unit, notes,
         created_at AS "createdAt", updated_at AS "updatedAt"`,
      [
        data.sku || null, data.label, data.itemType || 'producto',
        Number.isFinite(Number(data.quantity)) ? Number(data.quantity) : 0,
        data.unit || 'unidades', data.notes || null,
      ]
    );
    return mapDepositoItem(r.rows[0]);
  } catch (e) {
    console.error('createDepositoItem:', e.message);
    return null;
  }
}

/** Edición de una fila existente (pisa sku/label/tipo/unidad/notas y opcionalmente la cantidad). */
export async function updateDepositoItem(id, data = {}) {
  const p = getPool();
  if (!p) return null;
  try {
    const r = await p.query(
      `UPDATE deposito_stock SET
         sku = $2, label = $3, item_type = $4, unit = $5, notes = $6,
         quantity = COALESCE($7, quantity), updated_at = NOW()
       WHERE id = $1
       RETURNING id, sku, label, item_type AS "itemType", quantity, unit, notes,
         created_at AS "createdAt", updated_at AS "updatedAt"`,
      [
        id, data.sku || null, data.label, data.itemType || 'producto', data.unit || 'unidades',
        data.notes || null, Number.isFinite(Number(data.quantity)) ? Number(data.quantity) : null,
      ]
    );
    return r.rows[0] ? mapDepositoItem(r.rows[0]) : null;
  } catch (e) {
    console.error('updateDepositoItem:', e.message);
    return null;
  }
}

/** Suma (o resta, con delta negativo) a la cantidad. Nunca deja la cantidad por debajo de 0. */
export async function adjustDepositoQuantity(id, delta) {
  const p = getPool();
  if (!p) return null;
  try {
    const r = await p.query(
      `UPDATE deposito_stock SET quantity = GREATEST(quantity + $2, 0), updated_at = NOW()
       WHERE id = $1
       RETURNING id, sku, label, item_type AS "itemType", quantity, unit, notes,
         created_at AS "createdAt", updated_at AS "updatedAt"`,
      [id, Number(delta) || 0]
    );
    return r.rows[0] ? mapDepositoItem(r.rows[0]) : null;
  } catch (e) {
    console.error('adjustDepositoQuantity:', e.message);
    return null;
  }
}

/** Borra una fila de depósito. */
export async function deleteDepositoItem(id) {
  const p = getPool();
  if (!p) return false;
  try {
    const r = await p.query('DELETE FROM deposito_stock WHERE id = $1', [id]);
    return (r.rowCount ?? 0) > 0;
  } catch (e) {
    console.error('deleteDepositoItem:', e.message);
    return false;
  }
}
