# Zona Cuaderno – Sincronización ML y Tienda Nube

Proyecto para **sincronizar stock y precios** entre **Mercado Libre** y **Tienda Nube**, con matcheo por **SKU**. Incluye:

- **Stock en tiempo (casi) real**: cuando hay una venta en un canal, se descuenta el stock en el otro vía webhooks.
- **Precios por canal**: podés definir un precio para ML y otro para Tienda Nube.
- **Matcheo por SKU**: da igual si en ML tenés una publicación con variantes y en TN tenés productos separados; el vínculo es por SKU.

## ¿Las APIs son gratuitas?

**Sí.** Tanto la API de Mercado Libre como la de Tienda Nube son **gratuitas** para desarrolladores:

- **Mercado Libre**: te registrás en [Developers Mercado Libre](https://developers.mercadolibre.com.ar/devcenter/), creás una aplicación y obtenés `Client ID` y `Client Secret`. No se paga por usar la API.
- **Tienda Nube**: creás una aplicación en el [Panel de socios](https://partners.tiendanube.com/), obtenés `app_id` y `client_secret`. Tampoco se cobra por el uso de la API.

Lo que sí puede tener costo es tu plan de Tienda Nube o las comisiones de venta en cada plataforma; eso es independiente del uso de las APIs.

---

## Cómo conectar con cada API

### Mercado Libre

1. Entrá a [Mis aplicaciones – Mercado Libre](https://developers.mercadolibre.com.ar/devcenter/) (o el de tu país).
2. Creá una aplicación con:
   - **Redirect URI**: `http://localhost:4000/api/auth/mercadolibre/callback` (en producción, una URL HTTPS tuya).
   - Permisos: **lectura y escritura** (para leer órdenes, ítems y actualizar stock/precio).
   - **Notificaciones**: tópico **Orders** y una **Callback URL** pública (ej. `https://tudominio.com/api/webhooks/mercadolibre`).
3. Copiá **Client ID** y **Client Secret** al `.env` del backend (ver más abajo).

### Tienda Nube

1. Entrá al [Panel de socios Tienda Nube](https://partners.tiendanube.com/) → Aplicaciones → Crear aplicación.
2. Configurá:
   - **URL de redireccionamiento**: `http://localhost:4000/api/auth/tiendanube/callback` (en producción, tu URL HTTPS).
   - Permisos: **lectura y escritura de productos** (y los que necesites para órdenes si los usás).
3. Para **webhooks**: en la app, registrá una URL HTTPS (ej. `https://tudominio.com/api/webhooks/tiendanube`) para eventos como `order/paid` o `order/created`.
4. Copiá **app_id** (Client ID) y **client_secret** al `.env` del backend.

---

## Estructura del proyecto

- **`backend/`**: servidor Node/Express que:
  - Hace el flujo OAuth con ML y TN.
  - Guarda tokens y mapeos SKU ↔ ML / TN (por ahora en memoria).
  - Recibe webhooks de ML y TN y descuenta stock en el otro canal.
  - Expone APIs para el frontend (estado de conexión, mapeos, sincronizar precios).
- **`frontend/`**: aplicación Angular para:
  - Conectar/desconectar ML y TN.
  - **Conflictos**: si ya tenés productos en ambas cuentas, esta vista analiza coincidencias por SKU, ítems que solo existen en una plataforma, productos sin SKU y SKU duplicados (varios ítems con el mismo SKU). Podés resolver todo manualmente: vincular “esta publicación de ML = esta variante de TN” con un SKU, asignar o corregir SKU en ML o TN, y en duplicados editar el SKU en cada ítem para que sea único.
  - **Mapeos**: ver y editar los vínculos ya resueltos (precio ML, precio TN).
  - Disparar la sincronización de precios hacia ambos canales.

---

## Cómo correr el proyecto

### Backend

```bash
cd backend
cp .env.example .env
# Editar .env con ML_CLIENT_ID, ML_CLIENT_SECRET, TN_CLIENT_ID, TN_CLIENT_SECRET y las URLs de redirect
npm install
npm run dev
```

El backend queda en **http://localhost:4000**.

### Frontend

```bash
cd frontend
npm install
ng serve
```

La app queda en **http://localhost:4200**.

### Variables de entorno (backend)

En `backend/.env`:

| Variable | Descripción |
|----------|-------------|
| `PORT` | Puerto del backend (default 4000). |
| `CORS_ORIGIN` | Origen del frontend (ej. `http://localhost:4200`). |
| `ML_CLIENT_ID` | Client ID de tu app de Mercado Libre. |
| `ML_CLIENT_SECRET` | Client Secret de tu app de Mercado Libre. |
| `ML_REDIRECT_URI` | Redirect URI configurado en la app de ML (ej. `http://localhost:4000/api/auth/mercadolibre/callback`). |
| `TN_CLIENT_ID` | app_id de tu app de Tienda Nube. |
| `TN_CLIENT_SECRET` | client_secret de tu app de Tienda Nube. |
| `TN_REDIRECT_URI` | Redirect URI de la app de TN (ej. `http://localhost:4000/api/auth/tiendanube/callback`). |
| `WEBHOOK_BASE_URL` | URL pública del backend para que ML/TN llamen a los webhooks (en desarrollo podés usar [ngrok](https://ngrok.com/): `ngrok http 4000`). |

---

## Webhooks y stock en tiempo real

Para que el stock se actualice en el otro canal cuando vendés en uno:

1. El backend tiene que ser accesible desde internet (en local no pueden llamarte ML ni TN).
2. Usá por ejemplo **ngrok**: `ngrok http 4000` y obtenés una URL tipo `https://xxxx.ngrok.io`.
3. **Mercado Libre**: en tu aplicación, en “Notificaciones”, poné como Callback URL  
   `https://xxxx.ngrok.io/api/webhooks/mercadolibre`  
   y suscribite al tópico **orders** (o el que corresponda a órdenes).
4. **Tienda Nube**: en tu app, registrá un webhook con URL  
   `https://xxxx.ngrok.io/api/webhooks/tiendanube`  
   para los eventos de pedidos que quieras (ej. `order/paid`).

Cuando llegue una venta, el backend recibe el webhook, identifica los ítems/variantes por SKU (usando el mapeo que configuraste) y descuenta el stock en el otro canal.

---

## Flujo de uso (cuando ya tenés ambas cuentas con productos)

1. **Conectar canales**: en **Inicio** conectás Mercado Libre y Tienda Nube (OAuth).
2. **Conflictos**: entrá a **Conflictos**. Ahí se listan:
   - **Coinciden por SKU**: mismo SKU en ML y TN (ya se pueden mapear).
   - **Solo en ML / Solo en TN**: SKU que existe en una plataforma pero no en la otra → resolvé **vinculando manualmente** (elegís “esta publicación de ML = esta variante de TN” y asignás un SKU; opcionalmente se actualiza el SKU en ambas plataformas).
   - **Sin SKU**: productos sin SKU en ML o TN → podés **asignar SKU** (se actualiza en la plataforma) y/o **vincular con TN/ML** en un solo paso.
   - **SKU duplicados**: el mismo SKU usado por varios ítems en una plataforma → **editá el SKU** en cada uno para que sea único por producto/variante.
3. **Mapeos**: en **Mapeos** ves y editás los vínculos ya creados (precio ML, precio TN, y el par ML ↔ TN).
4. **Sincronizar precios**: desde Inicio o desde cada mapeo enviás los precios a ML y TN.
5. **Stock**: con webhooks y backend accesible, las ventas en un canal descuentan stock en el otro automáticamente.

---

## A futuro

- Crear publicaciones en ML y TN desde la misma herramienta (por ahora solo sincronización de stock y precios).
- Persistencia en base de datos en lugar de memoria (tokens y mapeos).
- Más opciones de sincronización (ej. stock inicial, inventario multi-almacén si las APIs lo permiten).
