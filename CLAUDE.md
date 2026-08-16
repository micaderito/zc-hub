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

Cada fila pendiente tiene dos salidas, porque no todas terminan en una restauración:
**Restaurar stock** (aprobar) suma en ML y en TN, y **Descartar** (`status = 'dismissed'`) la saca
de la lista sin tocar nada. Sin la segunda, una cancelación por falta de stock quedaría pendiente
para siempre y la lista dejaría de servir como aviso.

### Cancelación de ML: el stock de TN se espeja contra ML, no se suma a ciegas

En una venta de ML, ML descuenta su propio stock y el hub descuenta el de TN. La contracara
—cancelación → el hub le suma a TN— asumía que ML **siempre** devuelve la unidad a la publicación,
y no es así. Incidente 2026-08-11: la venta se canceló desde ML con motivo "no tengo stock"; ML
dejó su stock en 2 (correcto, la unidad no existía) y el hub dejó TN en 3, con stock real 2.

Dos cambios, en este orden:

1. **El motivo de la cancelación decide primero.** `needsManualReview`
   (`backend/src/lib/mlCancelReason.js`) lee `cancel_detail`: si la pidió el vendedor
   (`requested_by: seller`) o el motivo dice "sin stock", NO se restaura nada — queda como
   devolución pendiente para confirmar a mano. Sin `cancel_detail` (pago rechazado, timeout: la
   mayoría) sigue el camino automático, que igual verifica contra ML.
2. **El espejo.** `planMlCancellationMirror` (`syncService.js`) lee, antes de tocar nada, el
   `available_quantity` real del ítem/variación en ML y el stock de la variante en TN.
   `onMercadoLibreOrderCancelled` iguala TN al número de ML — nunca `TN + cantidad`. Si ML no sumó
   de su lado (`mlStock <= tnStock`), no se escribe nada y ese ítem sale marcado `mlNotRestored`,
   lo que deja una devolución pendiente **solo para ese ítem** (`insertPendingReturnsForOrder` con
   `only`). Como es un valor absoluto y no un delta, aplicarlo dos veces da lo mismo.

Si ML o TN no contestan, no hay espejo posible: la orden se reencola con el mismo contador que la
consulta del envío (`SHIPMENT_LOOKUP_MAX_ATTEMPTS`) y recién agotados los reintentos queda como
devolución pendiente. Un 429 no es información sobre el stock.

Dos detalles que evitan avisos de más:

- **Packs:** ML devuelve el stock de todas las órdenes del carrito de una, así que el espejo de la
  primera orden ya deja TN en el número final y las siguientes encuentran TN == ML. Eso NO es "ML
  no devolvió el stock": `mirroredPackSkus` (webhooks.js) recuerda por 10 min qué SKUs ya espejó
  cada pack.
- **Notificaciones repetidas:** ML manda varias por la misma orden. La revisión manual deja la
  marca `manual_review` en `sync_processed_orders`, porque descartar una devolución la saca del
  chequeo de duplicados y sin la marca volvería a aparecer con la próxima notificación.

### Devoluciones vía claim: el webhook de reclamos usaba el topic viejo de ML

Incidente 2026-08-12: dos devoluciones reales nunca aparecieron en `sync_pending_returns` (la
tabla estaba vacía en prod). Investigando con logs y la API real de la cuenta se encontraron tres
bugs apilados en el camino de "reclamo → devolución pendiente" (`backend/src/routes/webhooks.js`,
`backend/src/routes/sync.js`):

1. **ML migró el topic.** Ya no manda `topic: 'claims'`/`'claims_actions'`; manda
   `topic: 'post_purchase'` con el subtópico en el array `actions` (`actions: ['claims']`).
   Confirmado con logs reales de producción. El webhook filtraba por el topic viejo, así que
   **descartaba el 100% de las notificaciones de reclamos**. `isClaimsNotification()` en
   `webhooks.js` acepta ambos formatos.
2. **El discriminador de "es devolución" estaba mal.** Se filtraba por `claim.type === 'return'`,
   pero la doc de ML dice que lo correcto es `claim.related_entities.includes('return')` — un
   reclamo por producto defectuoso llega como `type: 'mediations'` con `related_entities:
   ['return']`, y ese caso se perdía. `claimHasReturn()` en `lib/mercadolibre.js` chequea ambos
   campos (el `type` se mantiene como respaldo porque la doc es inconsistente entre versiones).
3. **`ML_RETURN_CLOSED_STATUSES` excluía justo los estados donde hay que actuar.** Incluía
   `delivered` (= "devolución en manos del vendedor", el momento exacto de restaurar stock) y
   `expired` (= ML cerró la devolución sola al vencer el plazo de revisión). Una devolución
   real terminaba descartada en el momento en que dejaba de estar pendiente. Ahora la lista
   solo excluye estados donde no hay nada que restaurar (`cancelled`/`canceled`).

Las 2 devoluciones puntuales de ese incidente no perdieron stock: como el paquete no llegó a
destino, ML canceló la orden y esas cancelaciones sí pasaron por el camino de "entrega fallida"
(sección de arriba), que restauró el stock automáticamente sin depender del webhook de reclamos.
Los tres bugs de arriba solo afectan devoluciones que **sí** pasan por un claim de ML — arrepentimiento
o producto defectuoso sin que ML cancele la orden — que hasta este fix quedaban invisibles.

De paso se encontró que el filtro **"Devoluciones" del Historial** (`sync.component.ts`, columna
`source` de `sync_audit`) llevaba muerto desde siempre: la columna acepta `'venta' | 'manual' |
'devolucion'`, pero ningún camino de restauración por cancelación/devolución (`onMercadoLibreOrderCancelled`,
`onTiendaNubeOrderCancelled`, `approvePendingReturn`) le ponía `source: 'devolucion'` al insertar
en `sync_audit` — todo caía al default `'venta'`. Se agregó en los 4 puntos donde se restaura
stock por cancelación o devolución aprobada, así el filtro que ya existía en la UI queda con datos.

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

### Depósito Marañón: stock aparte de ML/TN

Sección (`/deposito`, tabla `deposito_stock`) para llevar el stock físico guardado en el depósito
Marañón — aparte del publicado en los canales. No es un espejo de nada: se carga y edita a mano.

Cada fila es `item_type = 'producto'` (vinculada a un SKU real del catálogo, con autocomplete que
reusa `GET /api/mapping/sources/{mercadolibre,tiendanube}` — los mismos endpoints que ya alimentan
el picker de mapeo) o `'embalaje'` (insumos sin canal — rollos de burbupack, cartón corrugado — que
nunca fueron ni van a ser un producto publicado, por eso `sku` es `NULL`). La ruta valida que un
`producto` tenga SKU y que un `embalaje` no lo tenga.

Los dos insumos de embalaje se precargan en `initDb()`, pero **solo si la tabla está vacía**
(mismo patrón que `ml_fee_tiers`): así una fila borrada a mano porque se dejó de comprar ese
insumo no resucita en cada reinicio del backend.

El ajuste rápido de cantidad (`PATCH /:id/ajustar`, botones +/-1 de la tabla) es un delta sobre el
valor guardado, no pisa un valor absoluto — evita que dos clics simultáneos se pisen entre sí.

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
`backend/test/mlCancelReason.test.js` qué motivos de cancelación van a revisión manual,
`backend/test/syncService.test.js` el espejo de stock (ML devolvió / ML no devolvió / sin plan /
por variación) y la atribución/encolado del reintento del historial, `backend/test/db.test.js` la
recuperación de locks vencidos, `backend/test/mlTaskQueue.test.js` el latido y `stock_probe`,
`backend/test/routesWebhooks.test.js` el flujo completo de cancelación (entrega fallida, envío
despachado, envío no consultable, caché por pack, cancelación del vendedor, reintento del espejo),
y `backend/test/routesDeposito.test.js` el CRUD de Depósito Marañón (validación producto/embalaje,
ajuste rápido de cantidad, filas inexistentes). El historial de los dos canales está cubierto
además en `backend/test/conflictsService.test.js` (diff + eco + 429/5xx que no tocan el snapshot).
Correr con `npm test` en `backend/` (necesita Node ≥ 24: con Node 20/22 el mockeo de módulos de `node:test` rompe los imports de `pg` y `node-fetch`).
