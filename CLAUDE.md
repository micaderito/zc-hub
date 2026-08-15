# Zona Cuaderno Hub

App que combina el stock de **Mercado Libre** y **Tienda Nube** en una sola interfaz,
sincroniza stock por webhooks y permite crear productos en ambos canales de una vez.

- `frontend/` — Angular 18 (standalone components, signals, TanStack Query), en español (es-AR).
- `backend/` — Node.js; clientes de las APIs de ML y TN en `backend/src/lib/`.

## Diseño y UI (leer antes de tocar la interfaz)

- **Guía de estilos:** [`docs/STYLEGUIDE.md`](docs/STYLEGUIDE.md) — tokens de color, tipografía,
  componentes, modo claro/oscuro, patrones del dominio (identidad de canal, override-on-demand,
  mapeo de variantes). Es la fuente de verdad del look & feel.
- **Prototipo de referencia:** [`docs/prototype/zona-cuaderno-hub.html`](docs/prototype/zona-cuaderno-hub.html)
  — maqueta navegable del rediseño (estática). Abrir en navegador; tiene modo claro/oscuro.
- **Tokens vivos:** [`frontend/src/styles.scss`](frontend/src/styles.scss). Siempre usar las CSS
  custom properties (`--bg`, `--surface`, `--brand`, `--ml`, `--tn`, etc.), nunca hex hardcodeados.

## Convenciones clave

- **El SKU es la unidad** que une ML ↔ TN (ML: `SELLER_SKU`/`seller_custom_field`, TN: `sku`).
- **Variantes (Opción B):** el hub tiene un "producto" con variantes y cada canal elige cómo se
  proyecta (`single_with_variants` o `one_per_variant`). El mapeo SKU↔SKU vive por debajo.
  Modelo en `frontend/src/app/pages/crear-producto/product-draft.model.ts`.
- Iconos: Tabler webfont, solo outline (`ti ti-…`).

## Particularidades de la API de Mercado Libre

### Categorías (crear producto)

El selector de categoría vive en `crear-producto` y se apoya en `GET /api/products/categories/*`
(ver `backend/src/routes/products.js` + `frontend/.../core/services/catalog.service.ts`).

- **ML** (`category_id`, ej. `MLA388307`): hay que publicar en una **categoría HOJA**
  (`children_categories == []`); una intermedia rompe el `POST /items`. La UI ofrece dos caminos:
  **predictor por título** (`GET /sites/MLA/domain_discovery/search?q=…`, siempre devuelve hojas y
  atributos pre-inferidos) y **explorador de árbol** (`GET /categories/{id}`). Al fijar la categoría
  se traen sus atributos (`GET /categories/{id}/attributes`) y se precargan los `required`/`new_required`;
  para atributos tipo `list` se manda `value_id` (no solo `value_name`). Sitio fijo: `MLA` (Argentina).
- **TN** (`categories`): es un **array de IDs numéricos de categorías EXISTENTES**, NO un string de
  nombres. Se traen con `GET /v1/{store}/categories` (árbol plano: `parent` + `subcategories`) y la UI
  es un multi-select. Mandar nombres deja el producto sin categoría.

### Precio por variación: qué permite ML y qué no

La cuenta tiene el tag `user_product_seller` (verificable vía `GET /users/me`), y las
variaciones traen un `user_product_id` (ej. `MLAU2908014071`). **Eso NO alcanza para tener
precios distintos por variación.** Lo que manda es el FORMATO del ítem:

| Formato de ítem | Cómo se ve en `GET /items/{id}` | Precio por variación |
|---|---|---|
| **Legacy** | tiene array `variations[]` (cada una con su `user_product_id`) | ❌ **NO** — ML exige el mismo precio en todas |
| **User Products (PxV)** | SIN array `variations`; cada variación es un ítem `MLA` propio | ✅ Sí, editando cada ítem por separado |

Los ítems existentes de esta cuenta son **legacy** (tienen `variations[]`), así que **no
admiten precio distinto por variación**. La única operación que ML acepta para ellos es
aplicar el mismo precio a TODAS las variaciones. La app pide confirmación al usuario antes
de hacerlo ("se aplicará a todas las variaciones").
Ref: https://developers.mercadolibre.com.ar/en_us/price-per-variation

**Actualizar precio de una variación (ítem legacy):** `PUT /items/{itemId}` con el array
completo de `variations`, todas con el MISMO precio nuevo. Ver `updateItemOrVariationPrice`.

**Endpoints que NO funcionan** (probados y descartados):
- `PUT /items/{itemId}/variations/{varId}` con `{ price }` → ML reconcilia a nivel ítem y
  rechaza: *"Found different prices in variations; Item price was dropped by the highest-price variation"*.
- `PUT /items/{user_product_id}` (ej. `PUT /items/MLAU…`) → HTTP 400 `item.id.invalid`
  (el `MLAU…` no es un item id editable).
- `PUT /user-products/{user_product_id}` → 404 (no existe escritura; el `GET` sí existe pero
  devuelve metadata sin `price`).
- `GET /users/{seller}/items/search?user_product_id=MLAU…` devuelve el **mismo ítem padre**,
  no un item id por variación → confirma que en estos ítems no hay item separado por variante.

**Actualizar stock de una variación:** sí es por variación — `PUT /items/{itemId}` con el
array `variations` mandando la variación objetivo con su `available_quantity` y el resto solo
con `{ id }` (ML conserva su stock). Ver `updateItemOrVariationStock`. El stock por variación
nunca tuvo el problema del precio.

### Devoluciones: una entrega fallida NO genera un claim

Cuando el correo no puede entregar el paquete, ML **cancela la orden y devuelve el envío al
vendedor sin abrir ningún reclamo**. O sea: llega un webhook `orders_v2` con `status=cancelled`,
pero `GET /post-purchase/v1/claims/search?resource=order&type=return` devuelve **vacío**. Buscar
claims no alcanza para detectar estas devoluciones (incidente 2026-07-21: 11 órdenes de un mismo
pack restauraron stock con la mercadería todavía en viaje).

La señal real está en el **envío**: `order.shipping.id` → `GET /shipments/{id}` → `{ status, substatus }`.
El criterio que usa el hub es "¿la mercadería llegó a salir del depósito?":

| Envío | Qué significa | Stock |
|---|---|---|
| `pending`, `handling`, `ready_to_ship`, `to_be_agreed`, `cancelled` | nunca se despachó | ✅ restaura automático |
| sin `shipping.id` | no hay despacho que rastrear (a acordar, retiro en persona) | ✅ restaura automático |
| `shipped`, `delivered`, `not_delivered` (+ substatus `returning_to_sender`, `returned`, …) | la mercadería salió | ⏸ devolución pendiente de confirmar |

**El default es no restaurar.** `isSafeToAutoRestore` (`backend/src/lib/mlShipmentState.js`) mantiene
una lista blanca de estados seguros, no una lista negra de estados de devolución: un estado
desconocido cae del lado conservador. Una devolución pendiente de más la aprueba la usuaria y
termina restaurando igual; stock inventado, no.

Ojo con la excepción: **un 429 al consultar el envío no es información sobre la mercadería**. Las
cancelaciones que nunca se despacharon (y las órdenes cuyo pago ni entró) tienen que resolverse
solas, sin trabajo manual. Por eso, si ML no contesta, la orden se reencola y se reintenta hasta
`SHIPMENT_LOOKUP_MAX_ATTEMPTS` veces (worker de 1 min) en vez de decidir con datos que no tenemos;
recién agotados los reintentos queda como devolución pendiente, para que no se pierda en el limbo.
Las órdenes que nunca descontaron stock cortan antes de todo esto y no consultan nada.

Doble restauración: el flujo automático marca `restore` en `sync_processed_orders` y el manual
(`approvePendingReturn`) marca `return_restore`. Cada uno chequea la marca del otro antes de tocar
stock. Son operaciones distintas a propósito, para que aprobar el segundo ítem de una orden no se
bloquee con la marca que dejó el primero.

`sync_pending_returns` guarda `order_id` = nro de venta que ve la usuaria (el `pack_id` si la venta
salió de un carrito) y `sale_order_id` = id de la orden individual, que es el que traen los webhooks
y el que cruza con `sync_processed_orders`. Cruzar por `order_id` solo falla en ventas por pack.

### Cola de tareas (`ml_pending_tasks`): locks que vencen

El worker (`backend/src/lib/mlTaskQueue.js`, tick cada 500 ms) reclama una tarea y la pasa a
`processing`. Si el proceso se muere ahí en el medio — **un deploy es el caso típico** — nadie
vuelve a mirar esa fila: `claimNextMlTask` busca `pending`/`failed`, no `processing`. Incidente
2026-08-02: dos `stock_ml_set` quedaron "En proceso" con `intentos = 0` y sin error, esperando
para siempre.

El lock ahora **vence**. Dos piezas que van juntas:

- **Latido:** mientras la tarea corre, el worker refresca `locked_at` cada `MLTASK_HEARTBEAT_MS`
  (30 s) vía `touchMlTaskLock`.
- **Recuperación:** `claimNextMlTask` también toma las `processing` con `locked_at` más viejo que
  `MLTASK_STALE_LOCK_MS` (2 min = 4 latidos perdidos), sumando un intento para que una tarea que
  voltea al proceso una y otra vez termine en `failed` en vez de reiniciarlo en loop.

El latido no es un detalle: sin él, `locked_at` viejo también podría significar "tarea lenta" —
con ML en 429 sostenido el circuit breaker de `mlLimiter` pausa el caño hasta 5 min por intento —
y reclamar una tarea viva **duplicaría un `stock_ml`**, que es un delta, no un valor absoluto.
Con latido, un lock vencido solo puede significar que el proceso murió.

En la UI (tab **Cola ML**) esas tareas se muestran como **Trabada** (no "En proceso") y tienen
botón Reintentar; `retryMlTask` acepta `failed` o `processing` con lock vencido, nunca una
`processing` viva.

### Historial: el movimiento de LOS DOS canales

El hub solo escribe el canal espejo (vende ML → descuenta TN), así que el historial contaba media
historia: no mostraba lo que hacía el canal donde se vendió. Eso hacía invisible el caso "se
descontó en TN pero ML nunca descontó lo suyo".

Ahora cada venta registra **las dos caras**, y la del canal se toma de un dato **observado**:

1. `refreshMlItemInSnapshot` / `refreshTnProductInSnapshot` (`conflictsService.js`) leen el ítem real
   y diffean contra el snapshot; cada diferencia de stock entra al historial como
   `source: 'externo'` / `actor: 'plataforma'`. Esto también captura ediciones hechas desde el panel
   de ML/TN, que es la otra fuente típica de desincronización.
2. `attributeStockChangeToSale` (`db.js`) reetiqueta esa fila como "Venta ML"/"Venta TN" si matchea
   canal + SKU + delta dentro de 30 min. Si NO matchea, queda como cambio externo a propósito: un
   movimiento que no se corresponde con ninguna venta conocida es justo lo que hay que poder ver.

Separar detección de atribución hace que dé igual quién llegue primero, si el webhook del ítem o el
de la orden. `stockEcho.js` evita contar dos veces lo que escribió el propio hub: cada
`patchMlStock`/`patchTnStock` deja un eco (canal+ítem+valor, TTL 2 min) que el diff consume.

**Nada de esto puede perderse por un 429.** Dos guardas:

- `ml.getItemOrStatus` expone el status en vez de colapsar todo a `null`: `refreshMlItemInSnapshot`
  solo vacía las filas del snapshot ante un **404 confirmado**; ante 429 agotado o 5xx no toca nada
  (si no, una racha de 429 borraba el producto del catálogo y marcaba el evento como desincronizado
  sin que ML hubiera hecho nada). El lado TN ya distinguía 404 real de falla transitoria.
- Si la lectura falla, la venta encola una tarea **`stock_probe`** (única kind que no escribe nada:
  solo relee y registra). Reintenta con el backoff de la cola y, agotados los 5 intentos, queda
  visible en **Cola ML** con botón Reintentar. Que no haya nada que atribuir NO es error: significa
  que el canal no movió stock, y eso es exactamente lo que el historial debe mostrar.

En el modal de historial por SKU las dos caras se muestran agrupadas como un solo evento, con el
número en que quedó cada canal y un chip **desincronizado** cuando no coinciden o falta una cara.

### Tests
`backend/test/mercadolibre.test.js` cubre `updateItemOrVariationPrice` y
`updateItemOrVariationStock` (con variación, sin variación, ítem sin variaciones, y error de
ML). `backend/test/mlShipmentState.test.js` cubre la regla de restauración por estado de envío,
`backend/test/db.test.js` la recuperación de locks vencidos y `backend/test/mlTaskQueue.test.js`
el latido, y `backend/test/routesWebhooks.test.js` el flujo completo de cancelación (entrega fallida, envío
despachado, envío no consultable, caché por pack). El historial de los dos canales está cubierto en
`backend/test/conflictsService.test.js` (diff + eco + 429/5xx que no tocan el snapshot),
`backend/test/syncService.test.js` (atribución y encolado del reintento) y
`backend/test/mlTaskQueue.test.js` (`stock_probe`). Correr con `npm test` en `backend/`.
