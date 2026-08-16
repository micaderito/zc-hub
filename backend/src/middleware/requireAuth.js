/**
 * Middleware que exige un usuario logueado. Se monta por router (ver index.js), no global, así
 * los endpoints públicos (webhooks, callbacks OAuth, health) quedan visibles de un vistazo y los
 * tests de rutas que montan su router sobre un express() pelado no dependen de este archivo.
 *
 * La verificación del JWT (firma + exp) es local. Pero un token válido no alcanza: si el usuario
 * fue desactivado o alguien pidió "cerrar sesión en todos lados" (bumpAppUserTokenVersion), el
 * token viejo tiene que dejar de servir aunque todavía no haya vencido. Para eso el payload lleva
 * `tv` y se lo compara contra `token_version` en la base — con una caché de 60s para no pagar un
 * SELECT en cada request. invalidateAuthUserCache() la vacía al toque cuando el propio proceso
 * hace el cambio (desactivar, cambiar contraseña, cerrar sesiones), así esos casos no esperan el TTL.
 */
import { verifyToken } from '../lib/authTokens.js';
import { getAppUserById, hasDatabase } from '../db.js';

const CACHE_TTL_MS = 60 * 1000;
const stateCache = new Map(); // id -> { activo, tokenVersion, expiresAt }

async function getAuthUserState(id) {
  const cached = stateCache.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const user = await getAppUserById(id);
  if (!user) {
    stateCache.delete(id);
    return null;
  }
  const state = { activo: user.activo, tokenVersion: user.tokenVersion, expiresAt: Date.now() + CACHE_TTL_MS };
  stateCache.set(id, state);
  return state;
}

/** Vacía la caché de un usuario. Llamar después de desactivarlo, borrarlo o subir su token_version. */
export function invalidateAuthUserCache(id) {
  stateCache.delete(id);
}

export async function requireAuth(req, res, next) {
  // Sin base no hay dónde chequear usuarios: dejar pasar sería abrir la puerta, no un modo degradado.
  if (!hasDatabase()) return res.status(503).json({ error: 'Base de datos no disponible' });

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) return res.status(401).json({ error: 'No autenticado' });

  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Sesión inválida o vencida' });

  const state = await getAuthUserState(payload.id);
  if (!state || !state.activo || state.tokenVersion !== payload.tokenVersion) {
    return res.status(401).json({ error: 'Sesión inválida o vencida' });
  }

  req.user = { id: payload.id, username: payload.username };
  // GET /session/me usa expiresAt para decidir si reemite el token (renovación deslizante).
  req.authPayload = payload;
  next();
}
