/**
 * Limitador global para TODAS las llamadas HTTP a la API de Mercado Libre.
 *
 * Por qué: ML limita los requests por minuto. Antes cada ruta llamaba a la API
 * por su cuenta (incluso 50 GET en paralelo con Promise.all en mapping.js), así
 * que varios caminos podían "estallar" a la vez y disparar 429. Este módulo hace
 * que toda llamada pase por un único caño con:
 *   - tope de concurrencia (MAX_CONCURRENT en vuelo a la vez),
 *   - espaciado mínimo entre arranques (MIN_SPACING_MS) para no superar el límite
 *     por minuto,
 *   - una pausa global (cooldown) cuando ML responde 429, para que un solo 429
 *     frene a TODAS las llamadas pendientes en vez de dejar que cada una choque.
 *
 * Es a propósito chico y sin dependencias. El estado es por proceso: con una sola
 * instancia del backend alcanza; si algún día se escala a varias réplicas, cada
 * una tendría su propio presupuesto (ver nota en la propuesta).
 */

/** Máximo de requests a ML en vuelo a la vez. */
const MAX_CONCURRENT = Number(process.env.ML_MAX_CONCURRENT) || 6;
/**
 * Espaciado mínimo entre arranques de request (ms). ~150ms => ~400 req/min, cómodo bajo el
 * límite real de ML (~1500 req/min por vendedor) y ~2.3x más rápido que antes (350ms). Se puede
 * ajustar por env. El crawl completo ya casi no ocurre (ver snapshot en conflictsService), así que
 * este ritmo aplica sobre todo a lecturas puntuales y writes.
 */
const MIN_SPACING_MS = Number(process.env.ML_MIN_SPACING_MS) || 150;

let active = 0;
let lastStart = 0;
/** Hasta cuándo está pausado el caño por un 429 (timestamp ms). */
let pauseUntil = 0;

/**
 * Circuit breaker: cuando ML nos pone un bloqueo sostenido, TODAS las llamadas devuelven 429
 * incluso en el primer intento. El backoff por-request (1-15s) no alcanza: al vencer, arrancan
 * de nuevo MAX_CONCURRENT requests, vuelven a chocar y el bloqueo nunca se levanta (ML lo mantiene
 * mientras le sigas pegando). Este breaker cuenta 429 consecutivos a nivel de TODO el caño y, al
 * cruzar el umbral, pausa el pipe entero por un cooldown que escala (30s→1m→2m→4m, cap 5m). Un
 * solo éxito lo resetea. Así el volumen cae de ~400/min a un puñado por ventana y ML puede
 * levantar el bloqueo.
 */
const CIRCUIT_429_THRESHOLD = Number(process.env.ML_CIRCUIT_THRESHOLD) || 3;
const CIRCUIT_BASE_MS = Number(process.env.ML_CIRCUIT_BASE_MS) || 30_000;
const CIRCUIT_MAX_MS = Number(process.env.ML_CIRCUIT_MAX_MS) || 5 * 60_000;
let consecutive429 = 0;
let circuitLevel = 0;
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
 * Arranca como mucho un job ahora (si hay cupo de concurrencia, pasó el espaciado y
 * no hay cooldown vigente) y programa el próximo despertar. Mantiene a lo sumo un
 * timer pendiente; el espaciado y el cooldown se revalidan dentro del callback por
 * si cambiaron (p.ej. un 429 que extendió la pausa después de programar el timer).
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
 * Encola una función que hace una request a ML y la corre respetando el límite.
 * @template T
 * @param {() => Promise<T>} run función que ejecuta el fetch y devuelve su resultado.
 * @returns {Promise<T>}
 */
export function mlSchedule(run) {
  return new Promise((resolve, reject) => {
    queue.push({ run, resolve, reject });
    schedule();
  });
}

/**
 * Pausar todo el caño durante `seconds` (lo llama el manejo de 429). Si ya había
 * una pausa más larga vigente, se mantiene la más larga.
 */
export function pauseMlFor(seconds) {
  const until = Date.now() + Math.max(0, seconds) * 1000;
  if (until > pauseUntil) pauseUntil = until;
}

/**
 * Registra un 429 recibido de ML. Suma al contador de 429 consecutivos y, si se cruza el umbral
 * (o ya estábamos en recuperación tras un bloqueo, circuitLevel>0), abre el circuito: pausa TODO
 * el caño por un cooldown que escala con cada apertura. Devuelve el cooldown en ms si abrió el
 * circuito, o 0 si solo contó. Lo llama fetchWith429Retry en cada 429.
 */
export function recordMl429() {
  consecutive429++;
  const inRecovery = circuitLevel > 0;
  if (inRecovery || consecutive429 >= CIRCUIT_429_THRESHOLD) {
    consecutive429 = 0;
    const cooldownMs = Math.min(CIRCUIT_BASE_MS * Math.pow(2, circuitLevel), CIRCUIT_MAX_MS);
    circuitLevel = Math.min(circuitLevel + 1, 8);
    pauseMlFor(cooldownMs / 1000);
    return cooldownMs;
  }
  return 0;
}

/** Registra una respuesta OK de ML: cierra el circuito y resetea la escalada. */
export function recordMlOk() {
  consecutive429 = 0;
  circuitLevel = 0;
}

/** Para tests/diagnóstico: estado actual del limitador. */
export function mlLimiterStats() {
  return {
    active,
    queued: queue.length,
    pausedForMs: Math.max(0, pauseUntil - Date.now()),
    consecutive429,
    circuitLevel
  };
}

export { sleep };
