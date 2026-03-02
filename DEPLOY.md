# Deploy: GitHub Pages (front) + Backend (Railway / Render)

## Resumen

- **Frontend**: GitHub Pages (estático desde `frontend/dist/frontend`).
- **Backend**: **Railway (plan Hobby)** recomendado — 24/7, no duerme. Alternativa: Render (Web Service Node; plan gratis duerme a los ~15 min).

---

## Paso a paso (después de subir el código a GitHub)

### Parte 1: Backend (Railway recomendado)

**Guía completa:** **[DEPLOY-RAILWAY.md](DEPLOY-RAILWAY.md)** — pasos para Railway plan Hobby (backend 24/7, no duerme).

Resumen rápido:

1. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → elegir repo.
2. En el servicio: **Settings** → **Root Directory** = `backend`. Build: `npm install`, Start: `npm start`.
3. **Variables**: `CORS_ORIGIN`, `ML_*`, `TN_*`, `WEBHOOK_BASE_URL`, `DATABASE_URL` (ver tabla en DEPLOY-RAILWAY.md).
4. **Settings** → **Networking** → **Generate Domain** → anotar URL (ej. `https://xxx.up.railway.app`).
5. Actualizar en Variables las URLs con ese dominio (`ML_REDIRECT_URI`, `TN_REDIRECT_URI`, `WEBHOOK_BASE_URL`).
6. La URL del backend para el front es `https://TU-DOMINIO.up.railway.app` (y el front usa `/api` → `BACKEND_API_URL` = `https://TU-DOMINIO.up.railway.app/api`).

**Alternativa (Render):** ver sección *1. Backend en Render (detalle)* más abajo.

---

### Parte 2: Frontend en GitHub Pages

1. En tu repo en **GitHub** → **Settings** → **Secrets and variables** → **Actions**.
2. **New repository secret**:
   - **Name**: `BACKEND_API_URL`
   - **Value**: `https://TU-DOMINIO.up.railway.app/api` (la URL de tu backend **más** `/api`; si usás Render sería `https://TU-SERVICIO.onrender.com/api`).
3. **Settings** → **Pages** (en el menú izquierdo del repo).
4. En **Build and deployment**:
   - **Source**: elegí **GitHub Actions** (no "Deploy from a branch").
5. El deploy se dispara con cada push a `main`. Para lanzarlo ahora: **Actions** → workflow **"Deploy to GitHub Pages"** → **Run workflow** → **Run workflow**.
6. Cuando termine (check verde), tu sitio queda en:
   - `https://TU-USUARIO.github.io/zonacuaderno-hub/` (si el repo se llama `zonacuaderno-hub`).

Si el repo tiene otro nombre, en `frontend/angular.json` (configuración `github`) cambiá el `baseHref` para que coincida (ej. `"/nombre-del-repo/"`).

---

## 1. Backend en Render (alternativa al plan Railway)

Si preferís Render en lugar de Railway:

1. En [render.com](https://render.com) creá un **Web Service** y conectalo al repo de GitHub.

2. **Configuración**:
   - **Root Directory**: `backend` (así Build y Start se ejecutan dentro de `backend`).
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Node**: versión 18 o 20 (en Render lo elegís en el panel).

3. **Variables de entorno** (Environment): agregá todas las de `backend/.env.example` con los valores reales.
   - `PORT`: Render lo asigna solo; no hace falta si usan el que dan ellos.
   - `CORS_ORIGIN`: `https://TU-USUARIO.github.io` (sin barra final; es el origen del front en GitHub Pages).
   - `ML_REDIRECT_URI`: `https://TU-SERVICIO.onrender.com/api/auth/mercadolibre/callback`
   - `TN_REDIRECT_URI`: `https://TU-SERVICIO.onrender.com/api/auth/tiendanube/callback`
   - `WEBHOOK_BASE_URL`: `https://TU-SERVICIO.onrender.com`
   - `ML_CLIENT_ID`, `ML_CLIENT_SECRET`, `TN_CLIENT_ID`, `TN_CLIENT_SECRET`
   - `DATABASE_URL`: connection string de Supabase (o tu Postgres).

4. Guardá y esperá el primer deploy. La URL del backend será algo como `https://zonacuaderno-hub.onrender.com`.

---

## 2. Frontend para GitHub Pages

1. **API URL** (la URL del backend no es un secreto para el usuario final: el navegador la usa igual; sí conviene no commitearla):
   - **Si usás el workflow de GitHub Actions** (recomendado): en el repo → **Settings → Secrets and variables → Actions** creá un secreto `BACKEND_API_URL` con el valor de tu backend + `/api` (ej. `https://TU-DOMINIO.up.railway.app/api` o `https://TU-SERVICIO.onrender.com/api`). El workflow reemplaza el placeholder en el build y la URL nunca queda en el código del repo.
   - **Si hacés deploy manual**: en `frontend/src/environments/environment.prod.ts` reemplazá `__BACKEND_API_URL__` por tu URL (ej. `https://TU-SERVICIO.onrender.com/api`). No commitees ese cambio si no querés la URL en el repo.

2. **Base href**: Si tu sitio en GitHub Pages es `https://TU-USUARIO.github.io/zonacuaderno-hub/`, el build debe usar base href `/zonacuaderno-hub/`. Ya hay una configuración `github` en el proyecto:
   ```bash
   cd frontend
   npm run build:github
   ```
   Si el nombre del repo es otro, editá en `angular.json` la config `github` y cambiá `baseHref` (ej. `"/mi-repo/"`).

3. **Subir el build a GitHub Pages**:
   - La salida del build está en `frontend/dist/frontend/` (o `frontend/dist/frontend/browser/` según la versión de Angular). Subí **el contenido** de esa carpeta (index.html y los JS/CSS) a la rama `gh-pages` o a la carpeta `docs/` en `main`.
   - Opción manual: después de `npm run build:github`, entrá a `frontend/dist/frontend`, copiá todo y en otra rama (ej. `gh-pages`) dejá solo eso en la raíz, luego push. En GitHub → Settings → Pages → Source = rama `gh-pages` / root.
   - **Opción GitHub Actions**: hay un workflow en `.github/workflows/deploy-pages.yml` que hace build, inyecta `BACKEND_API_URL` y publica en GitHub Pages. Configurá el secreto `BACKEND_API_URL` como arriba y en **Settings → Pages** elegí "GitHub Actions" como source.

4. En GitHub: **Settings → Pages** → Source: **Deploy from a branch** → rama `gh-pages` (o `main` / folder `docs`) y root `/`.

5. **CORS**: El backend ya usa `CORS_ORIGIN`; en Railway o Render tené definido `CORS_ORIGIN=https://TU-USUARIO.github.io` (sin barra final).

---

## 3. Después del deploy

- **Mercado Libre**: En [applications.mercadolibre.com](https://applications.mercadolibre.com) actualizá la **Callback URL** a la URL de tu backend (ej. `https://TU-DOMINIO.up.railway.app/api/auth/mercadolibre/callback`) y los temas (orders_v2).
- **Tienda Nube**: Reconectá la app desde el front (Inicio → Conectar Tienda Nube) para que el backend registre los webhooks con la URL de tu backend; o usá el botón "Registrar webhooks Tienda Nube" en Sincronización.

---

## 4. Backend 24/7 (sin dormir)

- **Railway plan Hobby** (recomendado): el backend no duerme; webhooks y API responden siempre. Guía: **[DEPLOY-RAILWAY.md](DEPLOY-RAILWAY.md)**.
- **Render plan gratis**: duerme tras ~15 min sin tráfico; los webhooks pueden fallar hasta el próximo request.
- **Oracle Cloud Free Tier** (gratis, 24/7): VM Always Free + Node + PM2. Guía: **[DEPLOY-ORACLE.md](DEPLOY-ORACLE.md)**.

---

## 5. Notas (tokens y CORS)

- **Tokens:** Con `DATABASE_URL` (Supabase) los tokens OAuth se guardan en la tabla `oauth_tokens` y sobreviven reinicios y redeploys. No hace falta reconectar ML ni TN. En local se usa también `data/tokens.json`.
- Si cambiás el nombre del repo o la URL de GitHub Pages, actualizá `baseHref` en `angular.json` (config `github`) y `CORS_ORIGIN` en el backend (Railway, Render u Oracle).
