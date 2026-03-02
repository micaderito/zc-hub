# Mercado Libre: notificaciones (webhooks) de órdenes

A diferencia de Tienda Nube, **Mercado Libre no usa registro de webhooks por API**. La URL y los temas se configuran una sola vez en el panel de la aplicación.

## Qué tenés que configurar

1. Entrá al **gestor de aplicaciones**: [applications.mercadolibre.com](https://applications.mercadolibre.com/) (con la cuenta donde creaste la app).

2. Abrí **tu aplicación** y entrá a la configuración / editar detalles.

3. **URL de retorno de llamada (Callback URL)**  
   Poné la URL pública donde tu backend recibe los POST. Debe ser HTTPS (en desarrollo podés usar ngrok):
   ```text
   https://TU-URL-NGROK.ngrok-free.dev/api/webhooks/mercadolibre
   ```
   Es la misma base que `WEBHOOK_BASE_URL` en tu `.env` + `/api/webhooks/mercadolibre`.

4. **Tópicos**  
   Activá al menos uno de estos para recibir ventas y cancelaciones:
   - **orders_v2** (recomendado): notificaciones de creación y cambios en ventas confirmadas.
   - **orders** (legacy): también lo soporta este backend.

5. Guardá los cambios. No hace falta “desconectar” ni volver a autorizar: ML empieza a enviar notificaciones a esa URL para los temas elegidos.

## Qué hace este backend

Cuando ML envía un POST a `/api/webhooks/mercadolibre` con `topic` `orders` o `orders_v2` y un `resource` tipo `/orders/123456`, el backend:

- Hace GET a la API de ML para obtener el detalle de la orden.
- Si la orden está pagada/confirmada → descuenta stock en Tienda Nube (por SKU vinculado).
- Si la orden está cancelada → restaura stock en Tienda Nube.

Asegurate de tener **sincronización activada** y productos vinculados por SKU en la página Conflictos / Precio y stock.

---

## Token de Mercado Libre (no hace falta refrescar a mano)

El **access_token** de ML vence. Este backend lo refresca de dos formas:

1. **Al usarlo**: cada vez que llega un webhook de ML o entrás a una página que llama a la API (Conflictos, Precio y stock, etc.), se usa `getMlToken()` y, si hace falta, se refresca antes.
2. **En segundo plano (cada 6 horas)**: si ML está conectado, el backend llama a la API de ML para renovar el token cada 6 horas. Así, **aunque no entres a la web ni haya ventas**, el token se mantiene vivo.

**En local**: si apagás la compu o parás el proceso, el backend no corre y no puede refrescar. Cuando volvés a levantar el servidor, el token puede estar vencido y a veces el refresh falla (por ejemplo si pasó mucho tiempo). En ese caso ves “Sesión vencida” y tenés que **Desconectar** y **Conectar** de nuevo.

**Deployado**: el proceso corre 24/7 y el refresco cada 6 h hace que el token se renueve solo. No tenés que entrar a la web para que siga funcionando la sincronización.

Si en algún momento el refresh falla (token revocado por ML, etc.), en Inicio vas a ver **“Sesión vencida”** en Mercado Libre; en ese caso hay que **Desconectar** y **Conectar** de nuevo una sola vez.

**Error 429 (Too Many Requests):** ML no publica un número exacto de requests por segundo; la doc pide *"disminuir y/o mejorar la distribución de requisiciones a lo largo del tiempo"* ([buenas prácticas](https://developers.mercadolibre.com.ar/buenas-practicas-para-uso-de-la-plataforma)). En Precio y stock, al hacer "Sincronizar" o "Actualizar precios", **no** se vuelve a pedir el análisis completo a ML; solo se actualiza la UI con lo que guardaste. Refresco global solo con el botón "Actualizar". El backend **reintenta hasta 3 veces** ante 429: si ML manda `Retry-After`, se respeta; si no, backoff exponencial (10s, 20s, 30s). Si aun así ves 429, esperá 1–2 minutos y probá de nuevo.

---

## Estrategia ante rate limit (qué hacemos y qué no)

| Práctica | Estado |
|----------|--------|
| **No refrescar toda la lista después de cada edición** | ✅ Tras Sincronizar/Actualizar precios solo actualizamos ese ítem en la UI (overrides locales + caché). Refresco global solo con "Actualizar". |
| **Debounce al refrescar** | ✅ El botón "Actualizar" usa debounce (600 ms) para no disparar varios GET si se invalida varias veces. |
| **Reintentos ante 429 + Retry-After / backoff** | ✅ Hasta 3 reintentos; respetamos `Retry-After`; si no viene, backoff exponencial. |
| **Single-flight y caché en backend** | ✅ Solo una ejecución de análisis a la vez por proceso; caché en DB (90 s) para no repetir el análisis en cada request. |
| **Webhook no queme cuota al pedo** | ✅ `getOrder` (webhook) usa el mismo retry ante 429. |
| **Bulk edit + "Aplicar cambios"** | ❌ No: cada fila tiene su botón; no hay grilla con un solo "Aplicar" que envíe un batch. |
| **Cola en backend (serializar updates a ML)** | ✅ POST update-prices se encola: cada request espera a que termine la anterior + 450 ms antes de llamar a ML, así varios "Sincronizar" seguidos no saturan la API. |
| **Devolver error si ML/TN falla (no 200)** | ✅ Si el PUT a ML o TN falla (ej. 429 tras reintentos), el backend responde 502 y el front no aplica el override; el usuario ve el mensaje y puede reintentar. |
| **Retry 429 en los PUT (precio/stock)** | ✅ updateItemPrice, updateItemOrVariationStock y getItem usan fetchWith429Retry. |
| **UI "Estamos sincronizando..." ante 429** | ❌ No: el usuario puede ver lista vacía o error; no mostramos mensaje específico de "puede tardar unos segundos". |

Si en el futuro quisieras reducir aún más 429: cola de updates a ML con un worker que haga max 1 request cada 250–500 ms y dedupe por ítem; o grilla con "Aplicar cambios" que envíe un solo batch al backend.
