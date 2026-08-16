/**
 * Panel de administración de usuarios del hub (sin roles: cualquier usuario logueado administra a
 * cualquier otro). Montado con requireAuth en index.js — nadie entra sin sesión.
 *
 * Dos reglas para no dejar la app inaccesible desde el propio panel:
 * - Nadie puede borrarse ni desactivarse a sí misma (req.user.id).
 * - Nunca puede quedar la app con cero usuarios activos.
 */
import { Router } from 'express';
import {
  getAppUsers, getAppUserById, getAppUserByUsername, createAppUser, updateAppUser, deleteAppUser,
  bumpAppUserTokenVersion, countActiveAppUsers,
} from '../db.js';
import { hashPassword } from '../lib/authTokens.js';
import { invalidateAuthUserCache } from '../middleware/requireAuth.js';

export const usersRoutes = Router();

function validateUsername(username) {
  const u = String(username || '').trim();
  if (u.length < 3) return 'El usuario debe tener al menos 3 caracteres';
  return null;
}

function validatePassword(password) {
  if (String(password || '').length < 8) return 'La contraseña debe tener al menos 8 caracteres';
  return null;
}

usersRoutes.get('/', async (_req, res) => {
  try {
    res.json({ items: await getAppUsers() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

usersRoutes.post('/', async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const displayName = String(req.body?.displayName || '').trim() || null;

  const usernameError = validateUsername(username);
  if (usernameError) return res.status(400).json({ error: usernameError });
  const passwordError = validatePassword(password);
  if (passwordError) return res.status(400).json({ error: passwordError });

  try {
    const existing = await getAppUserByUsername(username);
    if (existing) return res.status(400).json({ error: 'Ya existe un usuario con ese nombre' });

    const item = await createAppUser({ username, passwordHash: hashPassword(password), displayName });
    if (!item) return res.status(500).json({ error: 'No se pudo crear el usuario' });
    res.json({ ok: true, item });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

usersRoutes.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });

  const username = String(req.body?.username || '').trim();
  const displayName = String(req.body?.displayName || '').trim() || null;
  const activo = req.body?.activo !== false;
  const password = req.body?.password ? String(req.body.password) : null;

  const usernameError = validateUsername(username);
  if (usernameError) return res.status(400).json({ error: usernameError });
  if (password) {
    const passwordError = validatePassword(password);
    if (passwordError) return res.status(400).json({ error: passwordError });
  }
  if (!activo && id === req.user.id) return res.status(400).json({ error: 'No podés desactivarte a vos misma' });

  try {
    const current = await getAppUserById(id);
    if (!current) return res.status(404).json({ error: 'No se encontró el usuario' });

    const dup = await getAppUserByUsername(username);
    if (dup && dup.id !== id) return res.status(400).json({ error: 'Ya existe un usuario con ese nombre' });

    if (!activo && current.activo) {
      const activeCount = await countActiveAppUsers();
      if (activeCount <= 1) return res.status(400).json({ error: 'No podés dejar el hub sin ningún usuario activo' });
    }

    const item = await updateAppUser(id, {
      username, displayName, activo,
      passwordHash: password ? hashPassword(password) : null,
    });
    if (!item) return res.status(500).json({ error: 'No se pudo guardar' });

    // Cualquiera de estos deja tokens ya emitidos sin validez: hay que subir token_version.
    if (!activo || password) {
      await bumpAppUserTokenVersion(id);
      invalidateAuthUserCache(id);
    }
    res.json({ ok: true, item });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

usersRoutes.post('/:id/cerrar-sesiones', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
  try {
    const current = await getAppUserById(id);
    if (!current) return res.status(404).json({ error: 'No se encontró el usuario' });
    await bumpAppUserTokenVersion(id);
    invalidateAuthUserCache(id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

usersRoutes.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
  if (id === req.user.id) return res.status(400).json({ error: 'No podés borrarte a vos misma' });

  try {
    const current = await getAppUserById(id);
    if (!current) return res.status(404).json({ error: 'No se encontró el usuario' });

    if (current.activo) {
      const activeCount = await countActiveAppUsers();
      if (activeCount <= 1) return res.status(400).json({ error: 'No podés dejar el hub sin ningún usuario activo' });
    }

    const ok = await deleteAppUser(id);
    if (!ok) return res.status(404).json({ error: 'No se encontró el usuario' });
    invalidateAuthUserCache(id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
