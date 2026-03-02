# Base de datos Postgres (Supabase) para sincronización y auditoría

La sincronización de stock (descontar en la otra plataforma cuando hay una venta en ML o TN) y el historial de cambios usan **PostgreSQL**. Recomendamos **Supabase** (plan gratuito).

## Crear la base en Supabase

1. **Cuenta**: Entrá a [supabase.com](https://supabase.com) y creá una cuenta (o con GitHub).

2. **Nuevo proyecto**:
   - "New project"
   - Nombre del proyecto (ej. `zonacuaderno-sync`)
   - Contraseña de la base de datos: **guardala**, la vas a usar en la URL de conexión. kirabcollie2206
   - Región: la más cercana (ej. South America (São Paulo)).

3. **Obtener la URL de conexión**:
   - En el panel: **Project Settings** (ícono de engranaje) → **Database**.
   - En **Connection string** elegí la pestaña **URI**.
   - Copiá la URL. Se ve así:
     ```
     postgresql://postgres.[PROJECT-REF]:[YOUR-PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
     ```
   - Reemplazá `[YOUR-PASSWORD]` por la contraseña que definiste al crear el proyecto. postgresql://postgres:kirabcollie2206@db.tcwjqyowcyzhvwoqcoux.supabase.co:5432/postgres

4. **Configurar el backend**:
   - En la carpeta del backend, en el archivo `.env`, agregá una línea:
     ```
     DATABASE_URL=postgresql://postgres.xxxxx:TU_PASSWORD@aws-0-sa-east-1.pooler.supabase.com:6543/postgres
     ```
   - (Usá tu URL completa, con tu contraseña.)

5. **Reiniciar el backend**: Al arrancar, el backend crea solas las tablas `sync_settings`, `sync_audit`, `sync_processed_orders`, `sync_pending_returns`, `oauth_tokens`, etc., si no existen. No hace falta ejecutar SQL a mano. La tabla `oauth_tokens` guarda los tokens de ML y TN para que sobrevivan reinicios/redeploys en Render.

## Estado por defecto

- La **sincronización de stock** arranca **desactivada** (`stock_sync_enabled = false`).
- Activarla desde la app: menú **Sincronización** → activar el switch.

## Sin base de datos

Si no configurás `DATABASE_URL`, la app sigue funcionando:

- La sincronización queda desactivada y no se puede activar (en la pantalla Sincronización se indica que falta configurar la base).
- No se guarda historial de cambios.
- Los webhooks de ML y TN siguen llegando, pero no se descuenta stock en la otra plataforma.
