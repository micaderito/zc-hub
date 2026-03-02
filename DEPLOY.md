# Deploy: GitHub Pages (front) + Render (back)

## Resumen

- **Frontend**: GitHub Pages (estático desde `frontend/dist/frontend`).
- **Backend**: Render (Web Service Node).

---

## Paso a paso (después de subir el código a GitHub)

### Parte 1: Backend en Render

1. Entrá a **[render.com](https://render.com)** e iniciá sesión (o creá cuenta con GitHub).
2. **Dashboard** → **New +** → **Web Service**.
3. Conectá el repo de GitHub: elegí la organización/usuario y el repo (ej. `zonacuaderno-hub`). Si no aparece, autorizá a Render en GitHub.
4. Configurá el servicio:
   - **Name**: el que quieras (ej. `zonacuaderno-hub`). La URL será `https://NOMBRE.onrender.com`.
   - **Region**: el más cercano a vos.
   - **Root Directory**: `backend` (importante: así Build y Start corren dentro de `backend`).
   - **Runtime**: Node.
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
5. En **Environment** (Variables de entorno) agregá cada variable. Reemplazá `TU-USUARIO` por tu usuario de GitHub y `TU-SERVICIO` por el **Name** del paso 4 (o la URL que te dé Render):
   - `CORS_ORIGIN` = `https://TU-USUARIO.github.io` (sin barra final)
   - `ML_REDIRECT_URI` = `https://TU-SERVICIO.onrender.com/api/auth/mercadolibre/callback`
   - `TN_REDIRECT_URI` = `https://TU-SERVICIO.onrender.com/api/auth/tiendanube/callback`
   - `WEBHOOK_BASE_URL` = `https://TU-SERVICIO.onrender.com`
   - `ML_CLIENT_ID`, `ML_CLIENT_SECRET`, `TN_CLIENT_ID`, `TN_CLIENT_SECRET` (los que tenés en `backend/.env`)
   - `DATABASE_URL` = connection string de Supabase (o tu Postgres)
6. **Create Web Service**. Esperá a que termine el primer deploy (verde).
7. Anotá la URL del backend: **https://TU-SERVICIO.onrender.com** (la vas a usar en el front).

---

### Parte 2: Frontend en GitHub Pages

1. En tu repo en **GitHub** → **Settings** → **Secrets and variables** → **Actions**.
2. **New repository secret**:
   - **Name**: `BACKEND_API_URL`
   - **Value**: `https://TU-SERVICIO.onrender.com/api` (la URL de Render del paso 7 **más** `/api`).
3. **Settings** → **Pages** (en el menú izquierdo del repo).
4. En **Build and deployment**:
   - **Source**: elegí **GitHub Actions** (no "Deploy from a branch").
5. El deploy se dispara con cada push a `main`. Para lanzarlo ahora: **Actions** → workflow **"Deploy to GitHub Pages"** → **Run workflow** → **Run workflow**.
6. Cuando termine (check verde), tu sitio queda en:
   - `https://TU-USUARIO.github.io/zonacuaderno-hub/` (si el repo se llama `zonacuaderno-hub`).

Si el repo tiene otro nombre, en `frontend/angular.json` (configuración `github`) cambiá el `baseHref` para que coincida (ej. `"/nombre-del-repo/"`).

---

## 1. Backend en Render (detalle)

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
   - **Si usás el workflow de GitHub Actions** (recomendado): en el repo → **Settings → Secrets and variables → Actions** creá un secreto `BACKEND_API_URL` con el valor `https://TU-SERVICIO.onrender.com/api`. El workflow reemplaza el placeholder en el build y la URL nunca queda en el código del repo.
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

5. **CORS**: El backend ya usa `CORS_ORIGIN`; en Render tené definido `CORS_ORIGIN=https://TU-USUARIO.github.io` (sin barra final).

---

## 3. Después del deploy

- **Mercado Libre**: En [applications.mercadolibre.com](https://applications.mercadolibre.com) actualizá la **Callback URL** a `https://TU-BACKEND.onrender.com/api/webhooks/mercadolibre` y los temas (orders_v2).
- **Tienda Nube**: Reconectá la app desde el front (Inicio → Conectar Tienda Nube) para que el backend registre los webhooks con la URL de Render; o usá el botón "Registrar webhooks Tienda Nube" en Sincronización.

---

## 4. Gratis, 24/7 y sin configurar cron

En plan gratuito, **Render duerme** tras ~15 min sin tráfico; los webhooks pueden fallar. Si no querés pagar ni configurar ningún cron/external ping, la única opción real es una **VM gratis siempre encendida**:

- **Oracle Cloud Free Tier**: te dan 1–2 VMs “Always Free” que no se apagan. Ahí corrés el backend con Node y queda 24/7 sin dormir ni cron. Requiere crear cuenta en Oracle, crear la VM, instalar Node y PM2 (y opcionalmente nginx + HTTPS con Let’s Encrypt para los webhooks).

Guía paso a paso: **[DEPLOY-ORACLE.md](DEPLOY-ORACLE.md)**.

---

## 5. Notas (tokens y CORS)

- **Tokens:** Con `DATABASE_URL` (Supabase) los tokens OAuth se guardan en la tabla `oauth_tokens` y sobreviven reinicios y redeploys. No hace falta reconectar ML ni TN. En local se usa también `data/tokens.json`.
- Si cambiás el nombre del repo o la URL de GitHub Pages, actualizá `baseHref` en `angular.json` (config `github`) y `CORS_ORIGIN` en el backend (Render u Oracle).
