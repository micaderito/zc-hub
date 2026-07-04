/**
 * Worker asincrónico para procesar tareas de ML (stock/SKU) desde la cola en Postgres.
 * Usa claimNextMlTask (FOR UPDATE SKIP LOCKED) para ser safe con múltiples réplicas.
 *
 * Tipos de tarea:
 *   stock_ml  — aplica un delta de stock en ML (target_qty negativo = deducir, positivo = restaurar).
 *               El worker hace GET + computa nueva qty + PUT para evitar races con delta relativo.
 *   sku_ml    — actualiza seller_sku de un ítem/variación en ML.
 *   sku_tn    — actualiza seller_sku de una variante en Tienda Nube.
 *   price_ml  — actualiza el precio (target_price) de un ítem/variación en ML.
 */

import { claimNextMlTask, updateMlTaskStatus, hasDatabase } from '../db.js';
import { insertAuditLog, invalidateAnalysisCache } from '../db.js';
import { getMlToken, tokens } from '../store.js';
import * as ml from './mercadolibre.js';
import * as tn from './tiendanube.js';

const POLL_INTERVAL_MS = 500;
let workerTimer = null;

export async function processTask(task) {
  const { id, kind, itemId, variationId, targetQty, targetSku, targetPrice, attempts } = task;
  const ctx = task.contextJson ? JSON.parse(task.contextJson) : null;

  try {
    if (kind === 'stock_ml') {
      const accessToken = await getMlToken();
      if (!accessToken) throw new Error('Sin token ML');

      // GET current stock
      const item = await ml.getItem(accessToken, itemId);
      if (!item) throw new Error(`GET item ${itemId} falló`);

      const vid = variationId || undefined;
      let stockBefore;
      if (vid && item.variations?.length) {
        const v = item.variations.find(vr => String(vr.id) === String(vid));
        stockBefore = v?.available_quantity ?? 0;
      } else {
        stockBefore = item.available_quantity ?? 0;
      }

      // target_qty es delta: negativo = deducir, positivo = restaurar
      const newQty = Math.max(0, stockBefore + targetQty);
      const ok = await ml.updateItemOrVariationStock(accessToken, itemId, vid, newQty);
      if (!ok) throw new Error('updateItemOrVariationStock devolvió false');

      await updateMlTaskStatus(id, 'done');
      console.log(`[MLQueue] Tarea ${id} stock_ml: ${itemId} ${stockBefore} → ${newQty}`);

      // Escribir audit log si tenemos contexto
      if (ctx?.audit) {
        await insertAuditLog({
          ...ctx.audit,
          stockBefore,
          stockAfter: newQty,
        }).catch(e => console.error('[MLQueue] insertAuditLog:', e.message));
      }

    } else if (kind === 'sku_ml') {
      const accessToken = await getMlToken();
      if (!accessToken) throw new Error('Sin token ML');
      const ok = variationId
        ? await ml.updateVariationSku(accessToken, itemId, variationId, targetSku)
        : await ml.updateItemSku(accessToken, itemId, targetSku);
      if (!ok) throw new Error('updateSku ML devolvió false');
      await updateMlTaskStatus(id, 'done');
      console.log(`[MLQueue] Tarea ${id} sku_ml: ${itemId} → ${targetSku}`);

    } else if (kind === 'price_ml') {
      const accessToken = await getMlToken();
      if (!accessToken) throw new Error('Sin token ML');
      const price = Number(targetPrice);
      if (!(price > 0)) throw new Error(`price_ml con precio inválido: ${targetPrice}`);
      // updateItemOrVariationPrice lanza si ML rechaza (propaga el mensaje real de la API)
      await ml.updateItemOrVariationPrice(accessToken, itemId, variationId || null, price);
      await updateMlTaskStatus(id, 'done');
      // El precio ya quedó aplicado en ML: invalidamos la caché para que el análisis traiga datos frescos.
      await invalidateAnalysisCache().catch(e => console.error('[MLQueue] invalidateAnalysisCache:', e.message));
      console.log(`[MLQueue] Tarea ${id} price_ml: ${itemId}${variationId ? '/' + variationId : ''} → $${price}`);

    } else if (kind === 'sku_tn') {
      const { access_token, store_id } = tokens.tiendanube || {};
      if (!access_token) throw new Error('Sin token TN');
      const ok = await tn.updateVariantSku(access_token, store_id, itemId, variationId, targetSku);
      if (!ok) throw new Error('updateVariantSku TN devolvió false');
      await updateMlTaskStatus(id, 'done');
      console.log(`[MLQueue] Tarea ${id} sku_tn: producto ${itemId} variante ${variationId} → ${targetSku}`);

    } else {
      throw new Error(`Tipo de tarea desconocido: ${kind}`);
    }

  } catch (e) {
    const msg = e?.message || String(e);
    await updateMlTaskStatus(id, 'failed', msg);
    console.warn(`[MLQueue] Tarea ${id} (${kind}) falló (intento ${attempts + 1}): ${msg}`);
  }
}

export async function tick() {
  try {
    const task = await claimNextMlTask();
    if (task) await processTask(task);
  } catch (e) {
    console.error('[MLQueue] Error en tick:', e.message);
  }
}

export function startMlTaskWorker() {
  if (!hasDatabase()) {
    console.log('[MLQueue] Sin base de datos — worker desactivado.');
    return;
  }
  if (workerTimer) return;
  workerTimer = setInterval(tick, POLL_INTERVAL_MS);
  console.log('[MLQueue] Worker iniciado (polling cada 500ms).');
}

export function stopMlTaskWorker() {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
    console.log('[MLQueue] Worker detenido.');
  }
}
