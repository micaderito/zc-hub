import { Router } from 'express';
import { tokens, persistTokens, persistTokensAsync, clearMlTokens, clearTnTokens, getMlToken, isMlTokenKnownInvalid, isTnTokenKnownInvalid, setMlTokenKnownInvalid, setTnTokenKnownInvalid } from '../store.js';
import * as ml from '../lib/mercadolibre.js';
import * as tn from '../lib/tiendanube.js';

export const authRoutes = Router();

authRoutes.post('/mercadolibre/disconnect', (_, res) => {
  clearMlTokens();
  res.json({ ok: true });
});

authRoutes.get('/mercadolibre/url', (_, res) => {
  const redirectUri = process.env.ML_REDIRECT_URI || 'http://localhost:4000/api/auth/mercadolibre/callback';
  ml.getAuthUrl(redirectUri).then(url => res.json({ url })).catch(e => res.status(500).json({ error: e.message }));
});

authRoutes.get('/mercadolibre/callback', async (req, res) => {
  const { code } = req.query;
  const redirectUri = process.env.ML_REDIRECT_URI || 'http://localhost:4000/api/auth/mercadolibre/callback';
  const frontBase = process.env.FRONTEND_URL || (process.env.CORS_ORIGIN || 'http://localhost:4200') + '/';
  if (!code) return res.redirect(frontBase);
  try {
    const data = await ml.exchangeCodeForToken(code, redirectUri);
    setMlTokenKnownInvalid(false);
    tokens.mercadolibre = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      user_id: data.user_id,
      expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : null
    };
    await persistTokensAsync();
    res.redirect(frontBase.replace(/\/?$/, '/') + '?ml_connected=1');
  } catch (e) {
    res.redirect(frontBase.replace(/\/?$/, '/') + '?ml_error=' + encodeURIComponent(e.message));
  }
});

authRoutes.post('/tiendanube/disconnect', (_, res) => {
  clearTnTokens();
  res.json({ ok: true });
});

authRoutes.get('/tiendanube/url', (_, res) => {
  const redirectUri = process.env.TN_REDIRECT_URI || 'http://localhost:4000/api/auth/tiendanube/callback';
  tn.getAuthUrl(redirectUri).then(url => res.json({ url })).catch(e => res.status(500).json({ error: e.message }));
});

authRoutes.get('/tiendanube/callback', async (req, res) => {
  const { code } = req.query;
  const redirectUri = process.env.TN_REDIRECT_URI || 'http://localhost:4000/api/auth/tiendanube/callback';
  const frontBase = process.env.FRONTEND_URL || (process.env.CORS_ORIGIN || 'http://localhost:4200') + '/';
  const frontBaseNorm = frontBase.replace(/\/?$/, '/');
  if (!code) {
    return res.redirect(frontBaseNorm + '?tn_error=' + encodeURIComponent('Faltó el código de autorización'));
  }
  try {
    const data = await tn.exchangeCodeForToken(code, redirectUri);
    setTnTokenKnownInvalid(false);
    tokens.tiendanube = {
      access_token: data.access_token,
      store_id: data.user_id
    };
    await persistTokensAsync();
    const baseUrl = process.env.WEBHOOK_BASE_URL;
    if (baseUrl && data.access_token && data.user_id) {
      try {
        const created = await tn.registerOrderWebhooks(data.access_token, data.user_id, baseUrl);
        if (created.length) console.log('TN webhooks registrados:', created);
      } catch (err) {
        console.error('TN register webhooks:', err.message);
      }
    }
    res.redirect(frontBaseNorm + '?tn_connected=1');
  } catch (e) {
    console.error('TN callback error:', e.message);
    res.redirect(frontBaseNorm + '?tn_error=' + encodeURIComponent(e.message));
  }
});

authRoutes.get('/status', async (_, res) => {
  const hasStoredMl = !!(tokens.mercadolibre?.access_token || tokens.mercadolibre?.refresh_token);
  const hasStoredTn = !!tokens.tiendanube?.access_token;
  const mlKnownInvalid = isMlTokenKnownInvalid();
  const tnKnownInvalid = isTnTokenKnownInvalid();
  const mlToken = mlKnownInvalid ? null : await getMlToken();
  res.json({
    mercadolibre: !!mlToken,
    mercadolibreExpired: (hasStoredMl && !mlToken) || mlKnownInvalid,
    tiendanube: hasStoredTn && !tnKnownInvalid,
    tiendanubeExpired: hasStoredTn && tnKnownInvalid
  });
});
