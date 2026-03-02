# Backend en Railway (plan Hobby)

Guía para subir el backend a **Railway** con el plan Hobby. Railway no duerme como el plan gratis de Render, así que los webhooks responden 24/7 sin configurar cron.

---

## Requisitos

- Cuenta en [railway.app](https://railway.app) (con GitHub).
- Plan **Hobby** (tiene costo mensual; no duerme).
- Repo del proyecto en GitHub.

---

## Paso 1: Crear proyecto en Railway

1. Entrá a **[railway.app](https://railway.app)** e iniciá sesión con GitHub.
2. **New Project** → **Deploy from GitHub repo**.
3. Elegí el repo del proyecto (ej. `zc-hub` o `zonacuaderno-hub`). Si no aparece, autorizá a Railway en GitHub (Settings → Applications).
4. Railway va a crear un proyecto y detectar el repo. **No** uses “Add service” múltiple; vamos a configurar un solo servicio para el backend.

---

## Paso 2: Configurar el servicio (backend)

**Si el build falló:** casi siempre es porque el repo tiene frontend y backend juntos. Hay que decirle a Railway que use solo la carpeta del backend.

1. En el proyecto, hacé clic en el **servicio** que se creó (o **+ New** → **GitHub Repo** y elegí de nuevo el mismo repo).
2. Entrá a **Settings** del servicio.
3. **Root Directory** (o "Source" → "Root Directory"): poné **`backend`**. Sin esto, Railway corre desde la raíz del repo y no encuentra el `package.json` del backend → build falla. Con `backend`, Build y Start se ejecutan dentro de esa carpeta.
4. **Build Command**: dejá el que Railway propone o poné:
   ```bash
   npm install
   ```
5. **Start Command**:
   ```bash
   npm start
   ```
6. **Watch Paths** (opcional): si querés que solo se redespliegue cuando cambie el backend, podés poner `backend/**`. Por defecto Railway observa todo el repo.
7. Guardá los cambios.

---

## Paso 3: Variables de entorno

1. En el mismo servicio: **Variables** (o **Variables** en el menú).
2. Agregá cada variable. Reemplazá `TU-USUARIO` por tu usuario de GitHub y `TU-SERVICIO` por el nombre que quieras (o el que Railway asigne; la URL la ves en el paso 4):

   | Variable | Valor |
   |----------|--------|
   | `CORS_ORIGIN` | `https://TU-USUARIO.github.io` (sin barra final) |
   | `ML_REDIRECT_URI` | `https://TU-SERVICIO.up.railway.app/api/auth/mercadolibre/callback` |
   | `TN_REDIRECT_URI` | `https://TU-SERVICIO.up.railway.app/api/auth/tiendanube/callback` |
   | `WEBHOOK_BASE_URL` | `https://TU-SERVICIO.up.railway.app` |
   | `ML_CLIENT_ID` | (el de tu app ML) |
   | `ML_CLIENT_SECRET` | (el de tu app ML) |
   | `TN_CLIENT_ID` | (el de tu app TN) |
   | `TN_CLIENT_SECRET` | (el de tu app TN) |
   | `DATABASE_URL` | connection string de Supabase (o tu Postgres) |

   **Supabase desde Railway:** Railway no soporta IPv6. Si usás Supabase, **no** uses la URL directa (`db.xxx.supabase.co:5432`) porque suele resolver a IPv6 y da `ENETUNREACH`. Usá la del **pooler en modo Session**: en el dashboard de Supabase → **Connect** → **Session mode** (o "Connection pooling" → URI Session). Es de la forma `postgres://postgres.PROJECT_REF:PASSWORD@aws-0-REGION.pooler.supabase.com:5432/postgres` y funciona por IPv4.

   **No** hace falta definir `PORT`: Railway la asigna automáticamente.

3. Si todavía no tenés la URL del servicio, podés poner placeholders en `ML_REDIRECT_URI`, `TN_REDIRECT_URI` y `WEBHOOK_BASE_URL` y actualizarlas después del primer deploy (paso 4).

---

## Paso 4: Obtener la URL del backend

1. En el servicio, entrá a **Settings** → **Networking** (o **Deployments** y el dominio).
2. **Generate Domain** (o **Add domain**) para que Railway asigne una URL pública, por ejemplo:
   - `https://zc-hub-backend.up.railway.app`
3. **Anotá esa URL** (sin `/api`). Será tu `WEBHOOK_BASE_URL` y la base para los redirects.

Actualizá en **Variables**:

- `ML_REDIRECT_URI` = `https://TU-DOMINIO.up.railway.app/api/auth/mercadolibre/callback`
- `TN_REDIRECT_URI` = `https://TU-DOMINIO.up.railway.app/api/auth/tiendanube/callback`
- `WEBHOOK_BASE_URL` = `https://TU-DOMINIO.up.railway.app`

Railway suele redesplegar solo al cambiar variables; si no, hacé **Redeploy** desde el último deployment.

---

## Paso 5: Primer deploy

1. Con **Root Directory**, **Build** y **Start** ya configurados, el primer deploy se dispara al conectar el repo o al hacer **Deploy** manual.
2. En **Deployments** mirá el log: tiene que verse `npm install` y luego `npm start` y el mensaje del backend escuchando.
3. Probá en el navegador: `https://TU-DOMINIO.up.railway.app/api/health` → debería responder algo como `{"ok":true}`.

Si falla, revisá que **Root Directory** sea exactamente `backend` y que todas las variables obligatorias estén cargadas (sobre todo `DATABASE_URL` si usás Postgres).

---

## Paso 6: Frontend apuntando a Railway

1. En **GitHub** → tu repo → **Settings** → **Secrets and variables** → **Actions**.
2. Creá o actualizá el secreto **BACKEND_API_URL**:
   - **Value**: `https://TU-DOMINIO.up.railway.app/api`
   (la URL de Railway **más** `/api`).
3. El siguiente deploy del front (GitHub Actions a GitHub Pages) usará esta URL para las llamadas al backend.

---

## Paso 7: Apps ML y Tienda Nube

- **Mercado Libre**: En [applications.mercadolibre.com](https://applications.mercadolibre.com.ar) actualizá la **Callback URL** a  
  `https://TU-DOMINIO.up.railway.app/api/auth/mercadolibre/callback`  
  y los webhooks a la URL que use tu backend (ej. órdenes).
- **Tienda Nube**: Reconectá la app desde el front (Inicio → Conectar Tienda Nube) para que el backend registre los webhooks con la URL de Railway; o usá “Registrar webhooks Tienda Nube” en Sincronización.

---

## Resumen de pasos (checklist)

1. [ ] Railway → New Project → Deploy from GitHub repo → elegir repo.
2. [ ] Settings del servicio: **Root Directory** = `backend`.
3. [ ] Build: `npm install` | Start: `npm start`.
4. [ ] Variables: `CORS_ORIGIN`, `ML_*`, `TN_*`, `WEBHOOK_BASE_URL`, `DATABASE_URL` (y redirects con la URL de Railway).
5. [ ] Settings → Networking → **Generate Domain** → anotar URL.
6. [ ] Actualizar variables con la URL real (`ML_REDIRECT_URI`, `TN_REDIRECT_URI`, `WEBHOOK_BASE_URL`).
7. [ ] Probar `https://TU-DOMINIO.up.railway.app/api/health`.
8. [ ] GitHub → Secrets → `BACKEND_API_URL` = `https://TU-DOMINIO.up.railway.app/api`.
9. [ ] Actualizar callback y webhooks en las apps de ML y TN.

---

## Notas

- **PORT**: Railway inyecta `PORT`; el backend ya usa `process.env.PORT || 4000`, no hace falta configurarlo.
- **Tokens**: Con `DATABASE_URL` (Supabase) los tokens OAuth se guardan en la DB y sobreviven redeploys.
- **Redeploys**: Cada push a la rama conectada (ej. `main`) puede redesplegar; si usaste **Watch Paths** `backend/**`, solo los cambios en `backend` disparan deploy.
