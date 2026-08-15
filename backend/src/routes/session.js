/**
 * Login del hub (usuario/contraseña, sin roles) y ciclo de vida del token de sesión.
 *
 * POST /login es pública; /me, /logout y /password exigen requireAuth. Como todas comparten este
 * mismo router (montado en index.js SIN requireAuth, para que /login quede abierta), la guarda va
 * por ruta acá adentro, no al mount point. El mensaje de error de login es siempre el mismo para
 * usuario inexistente, contraseña incorrecta y usuario desactivado, para no filtrar cuál de los tres es.
 */
import { Router } from 'express';
import {
  getAppUserByUsername, getAppUserById, touchAppUserLastLogin, bumpAppUserTokenVersion, updateAppUser,
} from '../db.js';
import { verifyPassword, signToken, hashPassword, daysUntilExpiry } from '../lib/authTokens.js';
import { msUntilUnlocked, registerFailure, clearFailures } from '../lib/loginThrottle.js';
import { requireAuth, invalidateAuthUserCache } from '../middleware/requireAuth.js';

export const sessionRoutes = Router();

const LOGIN_ERROR = 'Usuario o contraseña incorrectos';
// Token se reemite si le quedan menos de estos días — sesión "de un mes" que en uso normal no vence nunca.
const RENEW_THRESHOLD_DAYS = 7;

function toPublicUser(user) {
  if (!user) return null;
  return { id: user.id, username: user.username, displayName: user.displayName };
}

sessionRoutes.post('/login', async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const ip = req.ip;
  if (!username || !password) return res.status(400).json({ error: 'Usuario y contraseña son requeridos' });

  const waitMs = msUntilUnlocked(username, ip);
  if (waitMs > 0) {
    return res.status(429).json({ error: `Demasiados intentos. Probá de nuevo en ${Math.ceil(waitMs / 60000)} min.` });
  }

  try {
    const user = await getAppUserByUsername(username);
    const ok = user && user.activo && verifyPassword(password, user.passwordHash);
    if (!ok) {
      registerFailure(username, ip);
      return res.status(401).json({ error: LOGIN_ERROR });
    }
    clearFailures(username, ip);
    await touchAppUserLastLogin(user.id);
    const token = signToken({ id: user.id, username: user.username, tokenVersion: user.tokenVersion });
    res.json({ token, user: toPublicUser(user) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

sessionRoutes.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await getAppUserById(req.user.id);
    if (!user || !user.activo) return res.status(401).json({ error: 'Sesión inválida o vencida' });
    const payload = { user: toPublicUser(user) };
    if (daysUntilExpiry(req.authPayload?.expiresAt) < RENEW_THRESHOLD_DAYS) {
      payload.token = signToken({ id: user.id, username: user.username, tokenVersion: user.tokenVersion });
    }
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Stateless: el token no se puede "invalidar" sin subir token_version (eso lo hace /password o el panel). Existe para que el flujo del frontend sea explícito. */
sessionRoutes.post('/logout', requireAuth, (_req, res) => {
  res.json({ ok: true });
});

sessionRoutes.post('/password', requireAuth, async (req, res) => {
  const actual = String(req.body?.actual || '');
  const nueva = String(req.body?.nueva || '');
  if (nueva.length < 8) return res.status(400).json({ error: 'La contraseña nueva debe tener al menos 8 caracteres' });
  try {
    const user = await getAppUserByUsername(req.user.username);
    if (!user || !verifyPassword(actual, user.passwordHash)) {
      return res.status(400).json({ error: 'La contraseña actual no es correcta' });
    }
    await updateAppUser(user.id, {
      username: user.username, displayName: user.displayName, activo: user.activo,
      passwordHash: hashPassword(nueva),
    });
    const newVersion = await bumpAppUserTokenVersion(user.id);
    invalidateAuthUserCache(user.id);
    // Reemite token ya con el token_version nuevo, así este mismo dispositivo no se autoexpulsa.
    const token = signToken({ id: user.id, username: user.username, tokenVersion: newVersion ?? user.tokenVersion + 1 });
    res.json({ ok: true, token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
