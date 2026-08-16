/**
 * Freno de fuerza bruta para POST /session/login. En memoria, por clave `usuario+IP` — no hace
 * falta persistir esto en la base: si el proceso reinicia, el contador vuelve a cero y no pasa nada.
 */
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

const attempts = new Map(); // key -> { count, lockedUntil }

function key(username, ip) {
  return `${String(username || '').trim().toLowerCase()}|${ip || ''}`;
}

/** Devuelve los ms que faltan para poder reintentar, o 0 si está libre. */
export function msUntilUnlocked(username, ip) {
  const entry = attempts.get(key(username, ip));
  if (!entry) return 0;
  const remaining = entry.lockedUntil - Date.now();
  return remaining > 0 ? remaining : 0;
}

/** Registra un intento fallido. Al llegar a MAX_ATTEMPTS, bloquea por LOCKOUT_MS. */
export function registerFailure(username, ip) {
  const k = key(username, ip);
  const entry = attempts.get(k) ?? { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCKOUT_MS;
    entry.count = 0;
  }
  attempts.set(k, entry);
}

/** Limpia el contador tras un login exitoso. */
export function clearFailures(username, ip) {
  attempts.delete(key(username, ip));
}
