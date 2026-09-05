/**
 * Worker asincrónico para procesar tareas de ML (stock/SKU) desde la cola en Postgres.
 * Usa claimNextMlTask (FOR UPDATE SKIP LOCKED) para ser safe con múltiples réplicas.
 *
 * Tipos de tarea:
 *   stock_ml     — aplica un delta de stock en ML (target_qty negativo = deducir, positivo = restaurar).
 *                  El worker hace GET + computa nueva qty + PUT para evitar races con delta relativo.
 *   stock_ml_set — fija el stock de un ítem/variación en ML al valor absoluto target_qty (lo usa el
 *                  botón "sincronizar stock" de la pantalla de precios/stock; a diferencia de stock_ml
 *                  no depende del valor previo, así que no necesita el GET intermedio).
 *   sku_ml       — actualiza seller_sku de un ítem/variación en ML.
 *   sku_tn       — actualiza seller_sku de una variante en Tienda Nube.
 *   price_ml     — actualiza el precio (target_price) de un ítem/variación en ML y registra el
 *                  cambio en price_audit (historial de precios del producto).
 *   stock_probe  — LEE el stock real del canal donde se vendió y registra ese movimiento en el
 *                  historial. No escribe nada: es el reintento del "¿qué hizo la plataforma?"
 *                  cuando el GET del momento de la venta falló (429 agotado, 5xx). Ver
 *                  recordMlSideMovement/recordTnSideMovement en syncService.js.
 */

import { claimNextMlTask, updateMlTaskStatus, hasDatabase, touchMlTaskLock, MLTASK_HEARTBEAT_MS } from '../db.js';
import { insertAuditLog, insertPriceAudit, attributeStockChangeToSale } from '../db.js';
import { patchMlPrice, patchMlStock, patchMlSku, patchTnSku, refreshMlItemInSnapshot, refreshTnProductInSnapshot, readMlSnapshotRow } from '../services/conflictsService.js';
import { rememberStockWrite, forgetStockWrite, mlStockEchoKey } from './stockEcho.js';
import { getMlToken, tokens } from '../store.js';
import * as ml from './mercadolibre.js';
import * as tn from './tiendanube.js';

const POLL_INTERVAL_MS = 500;
let workerTimer = null;

export async function processTask(task) {
  const { id, kind, itemId, variationId, targetQty, targetSku, targetPrice, attempts } = task;
  const ctx = task.contextJson ? JSON.parse(task.contextJson) : null;

  // Latido: mientras la tarea corre refrescamos su lock. Así un `locked_at` viejo significa
  // "el proceso se murió" y no "la tarea tarda", y claimNextMlTask puede recuperarla sin riesgo
  // de pisar una tarea viva (una tarea puede tardar minutos si ML está devolviendo 429).
  const heartbeat = setInterval(() => {
    touchMlTaskLock(id).catch(e => console.error('[MLQueue] touchMlTaskLock:', e.message));
  }, MLTASK_HEARTBEAT_MS);
  heartbeat.unref?.();

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
      await patchMlStock(itemId, vid ?? null, newQty).catch(e => console.error('[MLQueue] patchMlStock:', e.message));
      console.log(`[MLQueue] Tarea ${id} stock_ml: ${itemId} ${stockBefore} → ${newQty}`);

      // Escribir audit log si tenemos contexto
      if (ctx?.audit) {
        await insertAuditLog({
          ...ctx.audit,
          stockBefore,
          stockAfter: newQty,
        }).catch(e => console.error('[MLQueue] insertAuditLog:', e.message));
      }

    } else if (kind === 'stock_ml_set') {
      const accessToken = await getMlToken();
      if (!accessToken) throw new Error('Sin token ML');

      const vid = variationId || undefined;
      const qty = Math.max(0, Math.floor(Number(targetQty)));
      const echoKey = mlStockEchoKey(itemId, vid ?? null);

      // El valor previo se lee de la foto ANTES del PUT, no después: nuestro propio PUT dispara
      // el webhook `items` de ML casi en el acto, y ese refresh puede mover la foto al valor nuevo
      // antes de que lleguemos a leerla acá abajo — ahí "el previo" sería el valor NUEVO, el cambio
      // parecería un no-op y la fila del historial se perdería (incidente 2026-09-05, confirmado en
      // logs: el webhook `items` llegó antes que este punto del código). Ver readMlSnapshotRow.
      const before = await readMlSnapshotRow(itemId, vid ?? null).catch(e => {
        console.error('[MLQueue] readMlSnapshotRow:', e.message);
        return null;
      });

      // El eco también se anota ANTES del PUT, por la misma carrera: si se anotara recién en
      // patchMlStock (después del PUT), el webhook podría llegar en el medio sin eco disponible y
      // registrar la escritura propia como "Cambio en ML" (externo). Si el PUT falla, se olvida
      // (ver catch más abajo) para no tapar un cambio externo real que después deje el stock en
      // ese mismo valor.
      rememberStockWrite(echoKey, qty);
      let ok;
      try {
        ok = await ml.updateItemOrVariationStock(accessToken, itemId, vid, qty);
      } catch (e) {
        forgetStockWrite(echoKey);
        throw e;
      }
      if (!ok) {
        forgetStockWrite(echoKey);
        throw new Error('updateItemOrVariationStock devolvió false');
      }

      await updateMlTaskStatus(id, 'done');
      // La foto ya se movió (por el webhook o por lo que sigue): la dejamos consistente igual,
      // aunque el historial ya no dependa de lo que devuelva este parche.
      await patchMlStock(itemId, vid ?? null, qty).catch(e => console.error('[MLQueue] patchMlStock:', e.message));
      console.log(`[MLQueue] Tarea ${id} stock_ml_set: ${itemId}${vid ? '/' + vid : ''} → ${qty}`);

      // Historial: solo se registra si el stock efectivamente se movió — un "sincronizar" sobre un
      // valor que ya estaba no es un cambio y solo ensuciaría el historial.
      if (before && before.stock !== qty) {
        await insertAuditLog({
          source: 'manual',
          sku: ctx?.sku || before.sku || '',
          productLabel: 'Cambio manual',
          productDisplay: ctx?.productDisplay ?? null,
          updatedChannel: 'mercadolibre',
          stockBefore: before.stock,
          stockAfter: qty,
        }).catch(e => console.error('[MLQueue] insertAuditLog:', e.message));
      } else if (!before) {
        console.warn(`[MLQueue] Tarea ${id} stock_ml_set: sin fila en el snapshot para ${itemId}${vid ? '/' + vid : ''}, no se registra en el historial (sin SKU no hay dónde mostrarla).`);
      } else {
        console.log(`[MLQueue] Tarea ${id} stock_ml_set: ${itemId}${vid ? '/' + vid : ''} ya estaba en ${qty}, no se registra (no es un cambio).`);
      }

    } else if (kind === 'sku_ml') {
      const accessToken = await getMlToken();
      if (!accessToken) throw new Error('Sin token ML');
      const ok = variationId
        ? await ml.updateVariationSku(accessToken, itemId, variationId, targetSku)
        : await ml.updateItemSku(accessToken, itemId, targetSku);
      if (!ok) throw new Error('updateSku ML devolvió false');
      await updateMlTaskStatus(id, 'done');
      await patchMlSku(itemId, variationId ?? null, targetSku).catch(e => console.error('[MLQueue] patchMlSku:', e.message));
      console.log(`[MLQueue] Tarea ${id} sku_ml: ${itemId} → ${targetSku}`);

    } else if (kind === 'price_ml') {
      const accessToken = await getMlToken();
      if (!accessToken) throw new Error('Sin token ML');
      const price = Number(targetPrice);
      if (!(price > 0)) throw new Error(`price_ml con precio inválido: ${targetPrice}`);

      // El precio previo se lee de la foto ANTES del PUT — mismo motivo que en stock_ml_set: el
      // webhook `items` de ML puede refrescar la foto por nuestra propia escritura antes de que
      // lleguemos a mirarla, y leído después "el previo" sería el valor NUEVO.
      const before = await readMlSnapshotRow(itemId, variationId || null).catch(e => {
        console.error('[MLQueue] readMlSnapshotRow:', e.message);
        return null;
      });

      // updateItemOrVariationPrice lanza si ML rechaza (propaga el mensaje real de la API)
      await ml.updateItemOrVariationPrice(accessToken, itemId, variationId || null, price);
      await updateMlTaskStatus(id, 'done');
      // Precio aplicado en ML: parchamos el snapshot in-place (en ítems legacy ML aplica el mismo
      // precio a TODAS las variaciones del ítem, y patchMlPrice hace exactamente eso). La foto ya
      // puede estar al día por el webhook; esto la deja consistente igual.
      await patchMlPrice(itemId, price).catch(e => console.error('[MLQueue] patchMlPrice:', e.message));
      console.log(`[MLQueue] Tarea ${id} price_ml: ${itemId}${variationId ? '/' + variationId : ''} → $${price}`);

      // Historial: solo se registra si el precio efectivamente se movió — reaplicar el mismo
      // precio no es un cambio y solo ensuciaría el historial (mismo criterio que stock_ml_set).
      if (before && before.price !== price) {
        await insertPriceAudit({
          sku: ctx?.sku || before.sku || '',
          channel: 'mercadolibre',
          priceBefore: before.price,
          priceAfter: price,
          source: ctx?.source || 'bulk',
          productLabel: ctx?.productLabel ?? null,
        }).catch(e => console.error('[MLQueue] insertPriceAudit:', e.message));
      } else if (!before) {
        console.warn(`[MLQueue] Tarea ${id} price_ml: sin fila en el snapshot para ${itemId}${variationId ? '/' + variationId : ''}, no se registra en el historial.`);
      } else {
        console.log(`[MLQueue] Tarea ${id} price_ml: ${itemId}${variationId ? '/' + variationId : ''} ya estaba en $${price}, no se registra (no es un cambio).`);
      }

    } else if (kind === 'stock_probe') {
      // Reintento de la lectura del canal donde se vendió. `itemId` es el ítem de ML o el producto
      // de TN según ctx.channel; el resto del contexto es lo necesario para atribuir el movimiento
      // a su venta.
      const c = ctx?.probe;
      if (!c) throw new Error('stock_probe sin contexto');

      let refreshed;
      if (c.channel === 'mercadolibre') {
        const accessToken = await getMlToken();
        if (!accessToken) throw new Error('Sin token ML');
        refreshed = await refreshMlItemInSnapshot(accessToken, itemId);
      } else {
        const { access_token, store_id } = tokens.tiendanube || {};
        if (!access_token) throw new Error('Sin token TN');
        refreshed = await refreshTnProductInSnapshot(access_token, store_id, itemId);
      }
      // Si la lectura volvió a fallar, la tarea falla y la cola la reintenta con backoff. Que no
      // haya nada que atribuir NO es un error: significa que el canal no movió stock por esta
      // venta, y eso es justamente lo que el historial tiene que poder mostrar.
      if (!refreshed?.ok) throw new Error(`No se pudo leer el stock en ${c.channel}`);

      await updateMlTaskStatus(id, 'done');
      const attributed = await attributeStockChangeToSale({
        channel: c.channel,
        channelSale: c.channel,
        sku: c.sku,
        delta: c.delta,
        orderId: c.orderId,
        packId: c.packId,
        saleItemId: c.saleItemId,
        productLabel: c.productLabel,
        productDisplay: c.productDisplay,
        source: c.source,
      }).catch(e => {
        console.error('[MLQueue] stock_probe attributeStockChangeToSale:', e.message);
        return false;
      });
      console.log(`[MLQueue] Tarea ${id} stock_probe: ${c.channel} ${itemId} SKU ${c.sku} → ${attributed ? 'movimiento atribuido a la venta' : 'sin movimiento que atribuir'}`);

    } else if (kind === 'sku_tn') {
      const { access_token, store_id } = tokens.tiendanube || {};
      if (!access_token) throw new Error('Sin token TN');
      const ok = await tn.updateVariantSku(access_token, store_id, itemId, variationId, targetSku);
      if (!ok) throw new Error('updateVariantSku TN devolvió false');
      await updateMlTaskStatus(id, 'done');
      await patchTnSku(itemId, variationId, targetSku).catch(e => console.error('[MLQueue] patchTnSku:', e.message));
      console.log(`[MLQueue] Tarea ${id} sku_tn: producto ${itemId} variante ${variationId} → ${targetSku}`);

    } else {
      throw new Error(`Tipo de tarea desconocido: ${kind}`);
    }

  } catch (e) {
    const msg = e?.message || String(e);
    await updateMlTaskStatus(id, 'failed', msg);
    console.warn(`[MLQueue] Tarea ${id} (${kind}) falló (intento ${attempts + 1}): ${msg}`);
  } finally {
    clearInterval(heartbeat);
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
