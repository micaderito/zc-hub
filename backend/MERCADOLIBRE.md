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

**Error 429 (Too Many Requests):** ML limita la cantidad de llamadas por minuto. Si ves "ML token error: 429" al conectar o al refrescar, esperá **1–2 minutos** sin hacer clic de nuevo y probá otra vez. El backend reintenta una vez después de esperar si recibe 429 en OAuth o refresh.
