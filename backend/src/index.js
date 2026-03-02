import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import { tokens, tryRefreshMlToken, loadTokens } from './store.js';
import { authRoutes } from './routes/auth.js';
import { mappingRoutes } from './routes/mapping.js';
import { syncRoutes } from './routes/sync.js';
import { webhookRoutes } from './routes/webhooks.js';
import { conflictsRoutes } from './routes/conflicts.js';

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:4200', credentials: true }));

// Tienda Nube firma el body raw; si parseamos con express.json() y luego stringify, el orden de claves cambia y el HMAC falla.
// Para POST /api/webhooks/tiendanube guardamos el body crudo en req.rawBody y parseamos nosotros.
app.use((req, res, next) => {
  const path = req.originalUrl?.split('?')[0] ?? req.url?.split('?')[0] ?? '';
  if (req.method === 'POST' && (path === '/api/webhooks/tiendanube' || path === '/api/webhooks/tiendanube/')) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      req.rawBody = raw;
      try {
        req.body = JSON.parse(raw.toString('utf8'));
      } catch {
        req.body = {};
      }
      next();
    });
  } else {
    next();
  }
});
app.use((req, res, next) => {
  if (req.rawBody !== undefined) return next();
  express.json()(req, res, next);
});

app.use('/api/auth', authRoutes);
app.use('/api/mapping', mappingRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/webhooks', (req, res, next) => {
  if (req.method === 'POST') console.log('[Webhooks] POST', req.originalUrl);
  next();
});
app.use('/api/webhooks', webhookRoutes);
app.use('/api/conflicts', conflictsRoutes);

app.get('/api/health', (_, res) => res.json({ ok: true }));

/** Refresco periódico del token de ML (cada 6 h) para que siga válido aunque no haya tráfico ni entres a la web. */
const ML_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
function scheduleMlTokenRefresh() {
  setInterval(async () => {
    if (!tokens.mercadolibre?.refresh_token) return;
    const ok = await tryRefreshMlToken();
    if (ok) console.log('[ML] Token refrescado en segundo plano.');
  }, ML_REFRESH_INTERVAL_MS);
}

(async () => {
  const ok = await initDb();
  if (ok) console.log('Base de datos (sync/audit) conectada.');
  else if (process.env.DATABASE_URL) console.warn('No se pudo conectar a la base de datos. Revisá DATABASE_URL.');
  await loadTokens();
  app.listen(PORT, () => {
    console.log(`Backend escuchando en http://localhost:${PORT}`);
    scheduleMlTokenRefresh();
  });
})();
