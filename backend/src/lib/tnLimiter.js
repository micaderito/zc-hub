/**
 * Limitador global para TODAS las llamadas HTTP a la API de Tienda Nube.
 *
 * Por qué: TN usa un leaky bucket por tienda+app (burst ~40, sostenido ~2 req/s en el plan
 * base; ×10 en Next/Evolution). Antes cada camino hacía sus requests por su cuenta: los GET del
 * crawl pasaban por un espaciado global de 500ms, pero los WRITES (update-prices, sync de
 * órdenes, SKU) NO compartían ese gate. Con writes concurrentes (varios /update-prices en
 * paralelo o edición + webhooks de orden solapados) se superaban los 2 req/s → 429 → y si el
 * único retry no alcanzaba, el write se perdía. Este módulo hace que TODA llamada (GET y write)
 * pase por un único caño con:
 *   - tope de concurrencia (MAX_CONCURRENT en vuelo a la vez),
 *   - espaciado mínimo entre arranques (MIN_SPACING_MS) para no superar ~2 req/s,
 *   - una pausa global (cooldown) cuando TN responde 429, para que un solo 429 frene a TODAS
 *     las llamadas pendientes en vez de dejar que cada una choque.
 *
 * Es a propósito chico y sin dependencias, y espeja a `mlLimiter.js`. El estado es por proceso:
 * con una sola instancia del backend alcanza; si se escala a varias réplicas, cada una tendría
 * su propio presupuesto (haría falta un limitador compartido, ej. Redis).
 */

/** Máximo de requests a TN en vuelo a la vez. */
const MAX_CONCURRENT = Number(process.env.TN_MAX_CONCURRENT) || 2;
/**
 * Espaciado mínimo entre arranques de request (ms). 500ms => ~2 req/s, el límite sostenido del
 * plan base de TN. Como el espaciado gatea el ARRANQUE de cada job, la tasa sostenida es ~2/s sin
 * importar la concurrencia (la concurrencia solo permite solapar cuando la respuesta tarda). Se
 * puede subir el ritmo por env en tiendas Next/Evolution (límite ×10).
 */
const MIN_SPACING_MS = Number(process.env.TN_MIN_SPACING_MS) || 500;

let active = 0;
let lastStart = 0;
/** Hasta cuándo está pausado el caño por un 429 (timestamp ms). */
let pauseUntil = 0;
/** Único timer de "despertar" pendiente, para no acumular timers redundantes. */
let timer = null;
/** @type {{ run: () => Promise<any>, resolve: (v:any)=>void, reject:(e:any)=>void }[]} */
const queue = [];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Cuánto hay que esperar antes de poder arrancar otro request (espaciado + cooldown 429). */
function waitMs() {
  const now = Date.now();
  return Math.max(0, lastStart + MIN_SPACING_MS - now, pauseUntil - now);
}

/**
 * Arranca como mucho un job ahora (si hay cupo de concurrencia, pasó el espaciado y no hay
 * cooldown vigente) y programa el próximo despertar. Mantiene a lo sumo un timer pendiente; el
 * espaciado y el cooldown se revalidan dentro del callback por si cambiaron (p.ej. un 429 que
 * extendió la pausa después de programar el timer).
 */
function schedule() {
  if (timer || active >= MAX_CONCURRENT || queue.length === 0) return;
  timer = setTimeout(() => {
    timer = null;
    if (active >= MAX_CONCURRENT || queue.length === 0) return;
    if (waitMs() > 0) {
      // Cambiaron las condiciones mientras esperábamos: reprogramar.
      schedule();
      return;
    }
    const job = queue.shift();
    active++;
    lastStart = Date.now();
    job
      .run()
      .then(job.resolve, job.reject)
      .finally(() => {
        active--;
        schedule();
      });
    // Programar el próximo arranque (quedará espaciado por MIN_SPACING_MS).
    schedule();
  }, waitMs());
}

/**
 * Encola una función que hace una request a TN y la corre respetando el límite.
 * @template T
 * @param {() => Promise<T>} run función que ejecuta el fetch y devuelve su resultado.
 * @returns {Promise<T>}
 */
export function tnSchedule(run) {
  return new Promise((resolve, reject) => {
    queue.push({ run, resolve, reject });
    schedule();
  });
}

/**
 * Pausar todo el caño durante `seconds` (lo llama el manejo de 429). Si ya había una pausa más
 * larga vigente, se mantiene la más larga.
 */
export function pauseTnFor(seconds) {
  const until = Date.now() + Math.max(0, seconds) * 1000;
  if (until > pauseUntil) pauseUntil = until;
}

/** Para tests/diagnóstico: estado actual del limitador. */
export function tnLimiterStats() {
  return { active, queued: queue.length, pausedForMs: Math.max(0, pauseUntil - Date.now()) };
}

export { sleep };
