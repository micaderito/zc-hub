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
 *
 * Roles: 'admin' hace todo; 'lectura' solo ve. La guarda de escritura vive ACÁ (no en cada router)
 * para que ninguna ruta protegida quede abierta por olvido: un usuario de lectura no puede mandar
 * nada que no sea GET/HEAD/OPTIONS salvo lo que está en READ_ONLY_ALLOWED_WRITES. El rol sale de la
 * base (misma caché que activo/token_version), no del JWT: cambiarlo aplica sin volver a loguearse.
 */
import { verifyToken } from '../lib/authTokens.js';
import { getAppUserById, hasDatabase } from '../db.js';

const CACHE_TTL_MS = 60 * 1000;
const stateCache = new Map(); // id -> { activo, tokenVersion, role, expiresAt }

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Escrituras que SÍ puede hacer un usuario de lectura (método + path completo, sin query):
 * - su propia sesión: cerrar sesión y cambiar su contraseña;
 * - "Actualizar": refrescan datos que vienen de ML/TN, no cambian nada en los canales ni en lo
 *   que cargó la usuaria (ventas, devoluciones, cierre de jobs de publicación trabados);
 * - Para preparar: tildar "Preparado" y "Entendido" (lo usa quien arma los paquetes).
 */
const READ_ONLY_ALLOWED_WRITES = [
  /^POST \/api\/session\/(logout|password)$/,
  /^POST \/api\/sales\/sync$/,
  /^POST \/api\/sync\/returns\/fetch$/,
  /^POST \/api\/products\/publish-jobs\/reconcile$/,
  /^(PUT|DELETE) \/api\/dispatch\/[^/]+\/[^/]+\/prepared$/,
  /^PUT \/api\/dispatch\/[^/]+\/[^/]+\/cancel-seen$/,
];

export function isWriteAllowedForReadOnly(method, path) {
  const m = String(method || 'GET').toUpperCase();
  if (READ_METHODS.has(m)) return true;
  const key = `${m} ${String(path || '').split('?')[0].replace(/\/+$/, '')}`;
  return READ_ONLY_ALLOWED_WRITES.some((re) => re.test(key));
}

async function getAuthUserState(id) {
  const cached = stateCache.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const user = await getAppUserById(id);
  if (!user) {
    stateCache.delete(id);
    return null;
  }
  const state = { activo: user.activo, tokenVersion: user.tokenVersion, role: user.role || 'admin', expiresAt: Date.now() + CACHE_TTL_MS };
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

  if (state.role !== 'admin' && !isWriteAllowedForReadOnly(req.method, req.originalUrl)) {
    return res.status(403).json({ error: 'Tu usuario es de solo lectura', code: 'read_only' });
  }

  req.user = { id: payload.id, username: payload.username, role: state.role };
  // GET /session/me usa expiresAt para decidir si reemite el token (renovación deslizante).
  req.authPayload = payload;
  next();
}

/** Para lo que solo puede hacer un admin aunque sea un GET (panel de usuarios, conectar ML/TN). Va DESPUÉS de requireAuth. */
export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Solo un usuario administrador puede hacer esto', code: 'admin_only' });
  }
  next();
}
