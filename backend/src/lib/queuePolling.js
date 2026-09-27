/**
 * Polling de las colas (ml_pending_tasks, product_publish_jobs) con espaciado cuando están quietas.
 *
 * Preguntarle a la base cada 500 ms aunque no haya nada era ~110 MB/día de egress del pooler de
 * Supabase por backend prendido — dos tercios del cupo mensual del plan Free, sin hacer nada.
 * Ahora el intervalo sigue siendo de 500 ms (para no cambiar cuántas tareas corren en paralelo),
 * pero con la cola vacía se saltean ticks: 1 s, 2 s, 4 s y tope de 5 s. Encolar algo desde este
 * mismo proceso (`wakeQueue`) vuelve al ritmo rápido al instante; la demora solo aplica a trabajo
 * que llega desde otro proceso o a reintentos programados con `next_run_at`.
 */

export const QUEUE_POLL_MS = 500;
export const QUEUE_IDLE_MAX_MS = 5000;

const wakers = new Map();

export function wakeQueue(name) {
  wakers.get(name)?.();
}

/**
 * `tick` debe devolver true si encontró trabajo. Devuelve el timer (o null si ya había uno).
 */
export function startQueuePolling(name, tick, { now = Date.now } = {}) {
  let delay = 0;
  let nextAt = 0;
  let wakeGen = 0;
  const wake = () => { delay = 0; nextAt = 0; wakeGen++; };
  wakers.set(name, wake);

  const timer = setInterval(async () => {
    if (now() < nextAt) return;
    const genAtStart = wakeGen;
    let found = false;
    try {
      found = await tick();
    } catch {
      // tick ya loguea sus errores; una base que falla también cuenta como "quieta" para no martillarla
    }
    if (found) {
      wake();
    } else if (wakeGen === genAtStart) {
      delay = Math.min(delay ? delay * 2 : QUEUE_POLL_MS * 2, QUEUE_IDLE_MAX_MS);
      nextAt = now() + delay;
    }
  }, QUEUE_POLL_MS);
  return timer;
}

export function stopQueuePolling(name, timer) {
  clearInterval(timer);
  wakers.delete(name);
}
