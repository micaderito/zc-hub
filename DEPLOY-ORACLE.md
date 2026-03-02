# Backend en Oracle Cloud Free Tier (24/7, gratis, sin cron)

Oracle Cloud ofrece **VMs “Always Free”** que no se apagan. Podés correr el backend Node ahí y tenerlo 24/7 sin pagar ni configurar ningún cron.

---

## Requisitos

- Cuenta en [Oracle Cloud](https://www.oracle.com/cloud/free/) (tarjeta para verificación; no suelen cobrar si solo usás Always Free).
- Opcional pero recomendado para webhooks: un **dominio** apuntando a la IP de la VM (para poner HTTPS con Let’s Encrypt). Sin dominio podés usar `http://IP:4000` solo para probar; ML y TN necesitan HTTPS para webhooks en producción.

---

## 1. Crear la VM en Oracle Cloud

1. Entrá a [cloud.oracle.com](https://cloud.oracle.com), iniciá sesión o creá cuenta.
2. **Create a VM instance** (Compute → Instances → Create Instance).
3. Dejá nombre y compartment por defecto. En **Image and shape**:
   - **Image**: Canonical Ubuntu 22.04 (o la que prefieras).
   - **Shape**: elegí una opción **Always Free** (ej. VM.Standard.E2.1.Micro o Ampere A1 si está disponible en tu región).
4. **Networking**: que cree una VCN o usá una existente. En **Configure boot volume** no hace falta cambiar nada.
5. **Add SSH keys**: subí tu clave pública o que Oracle genere una y descargala.
6. **Create**. Esperá a que el estado sea **Running**. Anotá la **Public IP** y, si descargaste clave, la **Private Key** para SSH.

---

## 2. Abrir el puerto del backend

Los webhooks y el front van a llamar a tu backend por HTTP/HTTPS. Hay que abrir el puerto en la nube:

1. En Oracle Cloud: **Networking** → **Virtual Cloud Networks** → tu VCN → **Security Lists** → Default Security List.
2. **Add Ingress Rules**:
   - Source: `0.0.0.0/0`
   - Destination port: `4000` (o el que use tu backend; por defecto es 4000).
   - Save.

Si más adelante usás nginx con HTTPS en el puerto 443, agregá también una regla para el puerto **443**.

---

## 3. Conectarte por SSH e instalar Node

Con la IP pública y tu clave privada:

```bash
ssh -i /ruta/a/tu-llave-privada.key ubuntu@TU_IP_PUBLICA
```

(En Windows podés usar PuTTY o WSL.)

Dentro de la VM:

```bash
# Actualizar e instalar Node 20 (LTS)
sudo apt update && sudo apt install -y curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # debería ser v20.x
```

---

## 4. Clonar el repo y configurar el backend

```bash
# Clonar (reemplazá por tu usuario/repo)
git clone https://github.com/TU-USUARIO/zonacuaderno-hub.git
cd zonacuaderno-hub/backend

# Dependencias
npm install

# Variables de entorno: creá .env con lo mismo que en local
nano .env
```

En `.env` poné las mismas variables que en tu `backend/.env.example` (y las que ya usás en local), adaptando las URLs al servidor:

- `PORT=4000`
- `CORS_ORIGIN=https://TU-USUARIO.github.io` (sin barra final)
- `ML_REDIRECT_URI=http://TU_IP_PUBLICA:4000/api/auth/mercadolibre/callback` (más adelante cambiás a HTTPS con dominio)
- `TN_REDIRECT_URI=http://TU_IP_PUBLICA:4000/api/auth/tiendanube/callback`
- `WEBHOOK_BASE_URL=http://TU_IP_PUBLICA:4000`
- `ML_CLIENT_ID`, `ML_CLIENT_SECRET`, `TN_CLIENT_ID`, `TN_CLIENT_SECRET`
- `DATABASE_URL` = tu connection string de Supabase

Guardá el archivo (Ctrl+O, Enter, Ctrl+X en nano).

---

## 5. Correr el backend con PM2 (y que arranque al reiniciar)

```bash
# Instalar PM2
sudo npm install -g pm2

# Arrancar el backend (desde la carpeta backend)
cd /home/ubuntu/zonacuaderno-hub/backend
pm2 start npm --name backend -- start

# Que arranque al reiniciar la VM
pm2 startup
# Ejecutá el comando que te imprima (sudo env ...)
pm2 save
```

Comprobá que responda:

```bash
curl http://localhost:4000/api/health
```

Desde tu compu: `http://TU_IP_PUBLICA:4000/api/health`. Si ves `{"ok":true}`, el backend está expuesto.

---

## 6. Frontend apuntando a este backend

En GitHub → **Settings** → **Secrets and variables** → **Actions**, el secreto **BACKEND_API_URL** tiene que ser la URL de este backend:

- Sin dominio: `http://TU_IP_PUBLICA:4000/api`
- Con dominio y HTTPS (más adelante): `https://api.tudominio.com/api`

En **Render** (o donde tengas el backend) no hace falta hacer nada si ya no lo usás; el front solo debe usar la URL del backend de Oracle.

---

## 7. (Opcional) Dominio + HTTPS para webhooks

Mercado Libre y Tienda Nube suelen exigir **HTTPS** para los webhooks. Para eso:

1. Comprá un dominio (o usá uno que ya tengas) y creá un registro **A** apuntando a la IP pública de la VM (ej. `api.tudominio.com` → TU_IP_PUBLICA).
2. En la VM instalá **nginx** y **certbot**:

   ```bash
   sudo apt install -y nginx certbot python3-certbot-nginx
   sudo certbot --nginx -d api.tudominio.com
   ```

3. Configurá nginx para hacer proxy al backend (puerto 4000). Ejemplo en `/etc/nginx/sites-available/backend`:

   ```nginx
   server {
       listen 80;
       server_name api.tudominio.com;
       location / {
           proxy_pass http://127.0.0.1:4000;
           proxy_http_version 1.1;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
       }
   }
   ```

   Habilitá el sitio, probá y dejá que certbot configure HTTPS:

   ```bash
   sudo ln -s /etc/nginx/sites-available/backend /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   sudo certbot --nginx -d api.tudominio.com
   ```

4. En Oracle Security List abrí el puerto **443** (y 80 si certbot lo usa).
5. Actualizá las variables de entorno del backend (y reiniciá con `pm2 restart backend`):
   - `ML_REDIRECT_URI=https://api.tudominio.com/api/auth/mercadolibre/callback`
   - `TN_REDIRECT_URI=https://api.tudominio.com/api/auth/tiendanube/callback`
   - `WEBHOOK_BASE_URL=https://api.tudominio.com`
6. En el front (secreto **BACKEND_API_URL**): `https://api.tudominio.com/api`.
7. En las apps de ML y TN, configurá las URLs de callback y webhooks con `https://api.tudominio.com/...`.

---

## Resumen

- **Backend 24/7**: VM Always Free de Oracle + Node + PM2.
- **Sin cron**: la VM no duerme; no hace falta ningún ping externo.
- **Tokens**: con `DATABASE_URL` (Supabase) los tokens se guardan en la DB y sobreviven reinicios.
- **HTTPS**: necesario para webhooks en producción; se resuelve con dominio + nginx + Let’s Encrypt como en el punto 7.
