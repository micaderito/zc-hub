/**
 * Hashing de contraseñas y firma/verificación de tokens de sesión.
 *
 * Contraseñas: scrypt de `node:crypto` en vez de bcrypt — bcrypt es un módulo nativo (compila C++)
 * y ese tipo de dependencia es justo lo que se rompe en builds de Railway/Render cuando cambia la
 * versión de Node. scrypt es igual de robusto y viene incluido.
 *
 * Sesión: JWT HS256 con `exp`. La verificación de firma/expiración es local (sin ir a la base) —
 * la revocación (usuario desactivado, "cerrar sesión en todos lados") se resuelve aparte, en
 * `middleware/requireAuth.js`, comparando `tv` (token_version) contra la base.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';

const SCRYPT_KEYLEN = 64;

function getJwtSecret() {
  if (process.env.AUTH_JWT_SECRET) return process.env.AUTH_JWT_SECRET;
  // Sin secreto fijo el backend no puede dejar de arrancar (sigue sirviendo webhooks), pero cada
  // reinicio invalida todas las sesiones — el síntoma es la señal de que falta la variable.
  if (!getJwtSecret._fallback) {
    getJwtSecret._fallback = randomBytes(32).toString('hex');
    console.warn(
      '[auth] AUTH_JWT_SECRET no está seteado: usando un secreto aleatorio para este proceso. ' +
      'Cada reinicio va a desloguear a todo el mundo. Configurá AUTH_JWT_SECRET en el .env.'
    );
  }
  return getJwtSecret._fallback;
}

function getTokenDays() {
  const n = Number(process.env.AUTH_TOKEN_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

/** Hashea una contraseña en texto plano. Formato: scrypt$<salt hex>$<hash hex>. */
export function hashPassword(plain) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(plain), salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** Compara una contraseña en texto plano contra un hash guardado. Nunca tira excepción. */
export function verifyPassword(plain, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored || '').split('$');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(String(plain), salt, expected.length);
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Firma un token de sesión. Payload: { sub: userId, username, tv: tokenVersion }. */
export function signToken({ id, username, tokenVersion }) {
  return jwt.sign(
    { sub: id, username, tv: tokenVersion },
    getJwtSecret(),
    { expiresIn: `${getTokenDays()}d` }
  );
}

/** Verifica un token. Devuelve { id, username, tokenVersion, expiresAt } o null si no es válido. */
export function verifyToken(token) {
  try {
    const payload = jwt.verify(String(token || ''), getJwtSecret());
    if (!payload?.sub) return null;
    return {
      id: Number(payload.sub),
      username: payload.username,
      tokenVersion: Number(payload.tv),
      expiresAt: payload.exp ? payload.exp * 1000 : null,
    };
  } catch {
    return null;
  }
}

/** Días que faltan para que un token expire, a partir de su payload decodificado. */
export function daysUntilExpiry(expiresAt) {
  if (!expiresAt) return 0;
  return (expiresAt - Date.now()) / (1000 * 60 * 60 * 24);
}

export const TOKEN_DAYS = getTokenDays();
