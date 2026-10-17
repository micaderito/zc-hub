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

El worker (`backend/src/lib/mlTaskQueue.js`, tick cada 500 ms, espaciado hasta 5 s con la cola
vacía — ver "Egress de Supabase" más abajo) reclama una tarea y la pasa a
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

#### El valor previo se lee ANTES de escribir en el canal, no después

Incidente 2026-09-05: se sincronizó a mano el stock de un producto (mismo valor en ML y TN) y quedó
actualizado en los dos canales, pero el historial solo registró la fila de TN — el modal mostraba
"Desincronizado" arrastrando un número de ML de días atrás. Confirmado con logs reales de
producción: el webhook `items` de ML (disparado por nuestro propio `PUT`) llegaba y refrescaba el
snapshot **antes** de que el worker mirara "de cuánto venía" para armar el audit. Como el snapshot
ya tenía el valor nuevo, el cambio parecía un no-op y la fila se descartaba.

`readMlSnapshotRow` / `readTnSnapshotRow` (`conflictsService.js`) leen el valor previo de la foto
**antes** de mandar el `PUT`/`PATCH` al canal — a diferencia de `patchMlStock`/`patchTnStock`/
`patchMlPrice`/`patchTnPrice`, que corren después y solo sirven para mantener la foto al día (su
valor de retorno ya no se usa para el historial). El eco (`rememberStockWrite`) también se anota
antes de escribir, y se olvida (`forgetStockWrite`) si el canal rechaza el write, para no tapar un
cambio externo real que después deje el stock en ese mismo valor. **Esto no adelanta cuándo se
escribe el historial**: la fila se sigue insertando solo después de que el canal confirma el
cambio (la regla que evita registrar un cambio que ML terminó rechazando con un 409 de concurrencia
sigue intacta) — lo único que cambia es de dónde sale el "antes". Sin requests extra a ML/TN: el
valor previo sale de la foto local, no de un GET adicional.

Aplica a los 4 puntos donde se lee "de cuánto venía" antes de escribir manualmente: stock ML
(`mlTaskQueue.js`, kind `stock_ml_set`), stock TN (`routes/conflicts.js`), precio ML
(`mlTaskQueue.js`, kind `price_ml`) y precio TN masivo (`pricingService.js`). No se tocó el camino
de venta/devolución (`stock_ml`, `deductStockTiendaNube`, etc.): ahí no hay una escritura manual del
usuario que dispare esta carrera de la misma forma, y ya tienen su propia cobertura de tests.

En el modal, `missingChannel()` (`product-history-dialog.component.ts`) ahora también muestra
"sin cambio" para un cambio **manual** de una sola cara (antes solo lo hacía para ventas, con
`packId`) — sigue sin mostrarlo para un cambio **externo** suelto (alguien editó un canal desde su
panel), porque ahí no hay espejo que esperar. El chip del header (`latestState()`) puede recibir el
stock real de catálogo por input (`mlStock`/`tnStock`, pasado desde Precio y stock) y lo prefiere
sobre el valor arrastrado del historial — así un evento viejo sin fila no deja "mintiendo" el chip
de arriba aunque los canales ya estén iguales.

No se hizo backfill de los eventos ya perdidos (no hay dato real que reconstruir) ni se agregó diff
en el crawl completo (nadie edita stock a mano en los paneles de ML/TN; todo pasa por la app o por
webhooks de venta/devolución).

#### Historial de PRECIOS (`price_audit`): todos los caminos que cambian un precio

Hasta 2026-10-12 solo lo escribía "Precios" (aplicar lista). Ahora cada camino deja su fila, con
`source`: `bulk` (Precios), `manual` (Precio y stock → `/conflicts/update-prices` y el editor de
publicaciones, que rotula "Edición de publicación"; el `price_ml` viaja con
`contextJson: {source:'manual'}` y TN pasa por `setTnPriceManual` en `services/tnManualWrites.js`), `sync` ("Sincronizar precios" del Dashboard,
`syncPricesForSku`, ML → TN) y `externo` (cambiado desde el panel de ML/TN o una promoción de ML,
detectado por `diffPriceRows` en `refreshMlItemInSnapshot`/`refreshTnProductInSnapshot`, solo por
webhook — igual que el stock, el crawl completo no diffea). Mismas reglas que el stock: previo leído
de la foto ANTES de escribir, no se registra si el precio no se movió, y un **eco de precio**
(`rememberPriceWrite`/`matchPriceEcho` en `stockEcho.js`) para que el webhook no registre como
externo lo que escribió el hub. A diferencia del de stock, el eco de precio **no se consume** al
primer match (vence por TTL): en ML el precio es del ítem entero, así que un write produce N filas en
el diff. Por lo mismo, un cambio de precio en un ítem legacy registra **una fila por cada SKU del
ítem** (`readMlSnapshotRows`), y "aplicar a todas las variantes" en TN una por cada SKU del producto
(`readTnSnapshotRows`). Precio 0 en la foto = desconocido, no cuenta como cambio.

El modal de historial del producto tiene dos pestañas, **Stock** y **Precio** (`initialTab`; desde
Precios abre en Precio). Las filas de ML y TN de un mismo "aplicar" (mismo `source`, < 60 s) se
muestran como un solo evento; las externas van sueltas.

#### Estructura de la página "Historial y cola" (`/sincronizacion`, `pages/sync/`)

2026-10-16: el `.scss` único pasó el tope de 16 kB por hoja y el build de prod fallaba (mismo caso que
Precios). `sync.component` quedó como página contenedora (encabezado, pestañas con `?tab=`, pestaña
Estado) y provee `SyncStore` (`sync.store.ts`: el historial —filtros, página, filas—, que sobrevive a
cambiar de pestaña y que recarga "Restaurar stock" desde Devoluciones, y las queries de devoluciones y
Cola ML, que alimentan los contadores). `historial/`, `devoluciones/` y `cola/` son `OnPush` y se montan
solo mientras se ven: Devoluciones crawlea ML al montarse (una vez por apertura, igual que antes). La
base de estilos va sin encapsulación bajo `:where(.sync-page)`; cada pestaña trae lo suyo. Fixtures de
los specs en `sync.testing.ts`.

### Actualizar precios: varias listas del proveedor + pestaña "Mapeo con el proveedor"

Incidente 2026-10-13: al importar una lista, "34 mapeos automáticos · 0 costos actualizados", y la
planilla mostraba todo "sin mapear". Tres causas (`services/pricingService.js`):

1. **Índice SKU → canal vacío tras un deploy.** `store.js` lo llena solo al correr el análisis de
   Conflictos / Precio y stock; Precios lo usaba sin poblarlo (la tabla marcaba "sin mapear", el
   import no tenía productos contra qué matchear y "Aplicar" decía "sin ítem de ML"). Ahora
   `loadCatalogContext()` lee la foto (`getCatalogRows`, sin pegarle a ML/TN) y, si el índice está
   vacío, lo puebla con `setResolutionFromAnalysis` — lo llaman `getPreview`, `previewImport`,
   `confirmImport`, `getMappingState` y `enqueueApply`. Arma también sku → nombre de la
   publicación (`buildSkuNames`) y se cachea 60 s (la foto se lee entera de Postgres = egress).
2. **"Mapeos automáticos" contaba los de OTRAS listas.** La usuaria importa 3 listas; el matcher
   da por `auto` todo mapeo ya guardado aunque su código no venga en esta lista.
   `splitMappingByList` separa `inList` (toma precio de acá) / `otherLists` / `review` /
   `unmatched` / `codesWithoutProduct`. `confirmImport` devuelve ese `summary` y el modal ya no se
   cierra: muestra qué tomó precio, qué es de otra lista y qué quedó sin código.
3. **No había forma de ver lo que no mapeó.** La planilla lista solo SKUs con costo cargado (no es
   paginación). Pestaña nueva **Mapeo con el proveedor** (`?tab=mapeo`,
   `pages/precios/mapeo/`): todos los productos de la tienda + los packs con código propio, con su
   código, de qué lista sale (`getLatestPriceListItems`: lista más reciente que trae el código) y si
   tienen costo; filtros Con/Sin código y por lista; asignar/cambiar/sacar un código a mano.
   `confirmMapping`/`confirmPackMapping` ahora **vuelcan el costo al momento** desde esa lista (un
   pack no pisa a sus modelos con mapeo individual, mismo criterio que `applyListCosts`).

Los productos sueltos llevan `name` solo para mostrar: NO va en `label`, que es lo que usa el
escalón "parecido por descripción" del matcher (con 3 listas llenaría el import de sugerencias
falsas). En la planilla los packs arrancan **plegados** (rango de precios TN/ML en el encabezado,
checkbox que selecciona todo el pack, se abren solos al buscar), y la etiqueta "sin mapear" pasó a
"no publicado" (es "el SKU no está en ML ni TN", no "sin código del proveedor").

**Pendiente de aplicar.** Importar una lista guarda los costos al toque, pero en ML/TN no cambia
nada hasta "Aplicar". Para saber qué falta, `getPreview` compara el precio a aplicar (el ajustado si
lo hay) contra el publicado hoy, leído de la foto (`buildSkuPrices`, usando la publicación que
resuelve el índice — con un SKU repetido no compara contra otra; precio 0 = desconocido):
`pendingMl`/`pendingTn` (tolerancia de medio peso). `mlQueued` = hay un `price_ml` activo para el
ítem (`getActiveMlTasks`): ya se aplicó y la cola no terminó — no cuenta como pendiente, y mientras
haya alguno la planilla se refresca cada 10 s. La caché de la foto bajó a 15 s y `enqueueApply` la
invalida. En el front: "hoy $X +Y%" bajo cada precio, chip "pendiente de aplicar", conteo por pack,
filtro **Solo pendientes** (abre los packs) y **Seleccionar pendientes**. Hasta acá la columna de
delta existía pero nunca se mostraba: la ruta no le pasaba los precios actuales a `getPreview`.

#### Códigos con letras y mapeo automático (2026-10-14)

Incidente: la pestaña Mapeo mostraba packs "sin código" con el SKU (`39000`) tal cual en la lista.
Las 3 listas reales (Mi Punto Cero, Escolar, Be Positive; fixtures `backend/test/pdf*.fixture.txt`,
texto extraído con pdfjs igual que el front) destaparon cuatro problemas:

1. **El parser solo entendía dígitos** (`supplierListParser.js`). `BP700V` salía `700` y las filas
   siguientes, "sin código", lo **heredaban**: las 46 filas de Be Positive con código `700`, todas
   "válidas". Escolar igual (`V100`→`100`, `CARPETASV100` se comía la `V`). Ahora `CODE` admite
   prefijo (`BP`/`BPN`/`V`/`R`/`LV`/`REP`/`FULL `, también en minúscula), sufijo `V` y rangos
   (`BP3505-3507`), y se guarda en mayúsculas (`canonicalCode`). El encabezado de sección pegado
   se corta lo más corto posible y no puede arrancar donde arranca un código. **Solo hereda una
   fila que no empieza con nada parecido a un código** (`CODE_LIKE`); si no, se marca "código no
   reconocido". El `*` de "no se fracciona" puede venir con un espacio antes.
2. **El mapeo solo se calculaba al importar.** `autoMapFromLists` (pricingService) corre en
   `getMappingState`, en `getPreview` (con throttle de 60 s) y en `confirmImport`: mapea lo que
   coincide con un código de alguna lista importada (`price_list_items`, no `supplier_codes`) y no
   tiene mapeo, y le vuelca el costo de la lista más reciente. Nunca pisa un mapeo existente. Si un
   pack con SKU propio no matchea, prueba con cada modelo.
3. **`savedMap` indexado por SKU**: los packs no tienen SKU único (Viejos/Nuevos comparten `39000`)
   y el mapeo de uno se le pegaba al otro como "ya confirmado" → nunca se guardaba. Ahora la clave
   es `entityKey` (`pack:<id>` / `sku:<sku>`).
4. **`CODIGO-variante` (`39000-CORAZONES`) es automático** (`base`, y `group` dentro de un código
   múltiple): es la convención de la usuaria y el código base tiene que coincidir exacto. Solo el
   parecido por descripción (`text`) queda como sugerencia.

**Sacar un código a mano deja una marca** (`match_source = 'removed'`, código vacío;
`markSkuCodeRemoved`/`markPackCodeRemoved`) para que el mapeo automático no lo vuelva a poner;
`getSkuCodeMap`/`getPackCodeMap` la ignoran (Pedidos y Precios no la ven). Mapear a mano la pisa.
En un modelo de pack, sacar su código propio lo devuelve al del pack.

En la pestaña Mapeo un pack con código propio es un grupo plegable: el encabezado tiene el código
del pack y adentro van sus modelos (`members` en `getMappingState`) con el código del que sale su
precio — "del pack" o uno propio ("Código propio" lo asigna por SKU). Lo que se mapeó solo en esa
lectura vuelve en `autoMapped` y la UI lo avisa.

**Borrar una lista** (`DELETE /api/pricing/lists/:id`, ícono en Historial de listas): borra sus
ítems y poda de `supplier_codes` los códigos que ya no están en ninguna lista ni mapeo. Los costos
ya volcados no se tocan. Las importaciones de Be Positive / Escolar anteriores a este fix tienen
códigos inventados: hay que borrarlas y volver a importar.

#### Proveedores y configuraciones de descuento (2026-10-15)

Hasta acá "proveedor" era el string fijo `'punto_cero'` y el descuento venía de la lista importada
(copiado a cada `product_costs`): no había forma de tener agendas al 30+5 y el resto al 25+5 del
mismo proveedor, ni Bic sin descuento, ni de ver qué descuento llevaba cada producto. Diseño:
`docs/plans/2026-10-15-precios-proveedores-descuentos.md`.

- **Tablas** (`initDb()`, migración `2026-10-15_suppliers_discount_profiles`): `suppliers` (`key`
  slug inmutable — los `'punto_cero'` ya guardados siguen valiendo), `discount_profiles` (configs de
  CADA proveedor, una `is_default`), `product_suppliers` (pack o SKU ↔ proveedor, con su config o
  `NULL` = sin config propia) y `product_costs.supplier_key` = **proveedor vigente**, el que manda el
  costo. La migración crea "General" con el default viejo de Ajustes y una config por cada combinación
  de % que ya tenían los costos (asignada al pack entero si todos sus modelos la comparten), así
  ningún costo se movió.
- **El descuento se resuelve en vivo** (`lib/discountResolver.js`, puro): config del SKU para su
  proveedor vigente → la del pack → la default del proveedor → sin proveedor = 0. No se copia al
  costo: editar una config mueve el precio de todo lo que la usa (y queda "pendiente de aplicar").
  `product_costs.discount_1/2` y `pricing_settings.default_discount_*` quedan sin uso. Un costo
  unitario directo no lleva descuento (ya es neto).
- **Un código por proveedor**: `sku_code_map` / `pack_code_map` / `supplier_codes` pasaron a PK
  compuesta con `supplier`. Importar, el mapeo automático (`autoMapFromLists`, ahora un pase por
  proveedor), `applyListCosts` y mapear a mano trabajan con los mapas de ESE proveedor, y solo
  vuelcan costo a un SKU cuyo vigente es ese proveedor o que todavía no tiene (y pasa a serlo): con
  dos proveedores, la lista del que no es vigente no pisa nada. **El vigente se elige a mano**
  (`PUT /api/pricing/vigente`): toma el precio de la última lista de ese proveedor con su código;
  sin precio de lista, deja el costo y lo devuelve en `withoutPrice`. A la fábrica (Pedidos) va el
  código del proveedor DEL PEDIDO (ver "Pedidos al proveedor"); `pickVigenteCodes` solo queda para
  el catálogo pedido sin proveedor.
- **Importar**: el modal pide proveedor + config (precargada con la default). La elegida va **solo**
  a lo de la lista sin config propia (`onlyIfMissing`); lo que ya tiene una (los packs de agendas)
  la conserva, y el resumen lo dice.
- **Asignación masiva** (`PUT /api/pricing/assignments`): un pack seleccionado entero se asigna como
  pack y eso limpia la config propia de sus modelos para ese proveedor (si no, una fila suelta
  vieja taparía la del pack). Elegir la default guarda `NULL`.
- **UI** (`pages/precios/`): una pestaña por proveedor (`?proveedor=`, "Todos" = todo) con tarjetas de
  sus configs (editar, hacer default, borrar — la default no se borra; borrar una deja lo que la usaba
  en la del pack/default). La tabla muestra **precio del bulto** ("12 u. · $X c/u"), columna
  **Descuento** (chip de la config + "−25% −5%", tooltip con la cadena hasta el costo unitario) y el
  valor final pasó como línea secundaria de "Te queda". Barra: "Asignar descuento…" y "Proveedor
  vigente…". Mapeo: en un proveedor edita sus códigos; en "Todos" es de solo lectura y muestra el
  código de cada proveedor. Borrar un proveedor con listas o productos vigentes da 409.
- **Fuera de Precios** (2026-10-16): el proveedor + config también se eligen en **Crear/Editar
  producto** ("Precios y ganancia": selects Proveedor y Descuento en vez de los % sueltos, que quedan
  sin uso en `DraftCost`) y en **Productos** (chip en cada tarjeta y en cada pack de la pestaña
  Packs → `zc-product-supplier-dialog`). En Productos también se puede tildar varios (por SKU, la selección sobrevive a
  cambiar de página/búsqueda) y "Asignar proveedor…" los manda juntos con `bulk: true`: cada SKU de un
  pack asigna su pack (una vez) y los sueltos van por SKU (`bulkSupplierTargets`), en vez de tratar
  la lista como las variantes de UN producto. Todo pasa por `setProductSupplier` (`PUT
  /api/pricing/product-supplier`): se asigna al pack si el producto es un pack o todos sus SKUs son
  de uno (`supplierTargets`, `discountResolver.js`), si no a cada SKU; con costo lo guarda con ese
  proveedor como vigente, sin costo solo mueve el vigente de lo que ya tenía costo de otro. Se lee
  con `GET /api/pricing/product-suppliers` (`getProductSupplierOverview`). Al crear viaja en
  `payload.supplier` y lo aplica el publish worker (`publishSupplier.js`) después de la alerta (que
  puede crear el pack), solo con alguna unidad `ok`. En la edición NO es una operación de ML/TN: se
  carga desde Precios al abrir y tiene su propio botón "Guardar en Precios".
- **Varios proveedores por producto** (2026-10-17). La base ya lo soportaba (`product_suppliers` es
  N:N); lo que faltaba era la UI. El diálogo de Productos (`zc-product-supplier-dialog`) edita la
  lista COMPLETA de un producto/pack: cada proveedor con su config, un radio para el vigente, quitar y
  agregar. Viaja como `suppliers: [{supplierKey, profileId}]` en `PUT /pricing/product-supplier`
  (`supplierKey` = vigente, 400 si hay proveedores sin vigente): los que ya no están se sacan y, si
  el vigente cambia sin costo cargado, toma el precio de su última lista (`setVigenteSupplier`, con
  `withoutPrice` si no hay). Con varios productos tildados no se edita una lista (cada uno tiene la
  suya): **Agregar** (con "que sea el vigente" opcional → `makeVigente: false`) o **Quitar**
  (`POST /pricing/product-supplier/remove`). En Crear/Editar producto: "Proveedor vigente" + "También
  se compra a" (`DraftCost.otherSuppliers`; un borrador viejo sin ese campo manda solo el vigente,
  como antes, y no saca nada). En Precios, en la pestaña de un proveedor: **Quitar de X…**
  (`/assignments/remove`). `GET /product-suppliers` suma `discounts` (la config con cada proveedor).
  **Quitar un proveedor** (`detachSupplier`) borra la asignación (del pack y de sus modelos) y deja la
  marca de código "sacado" para ese proveedor en el pack y en cada modelo: si no, el código mapeado
  lo seguiría contando como proveedor (`suppliersOf` cuenta códigos) y el mapeo automático lo volvería
  a poner con la próxima lista. Lo que lo tenía de vigente queda sin vigente (costo intacto, sin
  descuento) y vuelve en `lostVigente` para avisar. Sacar un SKU suelto de un pack cuyo pack tiene
  código de ese proveedor no alcanza (el pack lo sigue trayendo): se saca el pack.
- **Productos de un proveedor sin costo** (2026-10-17): la planilla se arma solo con `product_costs`,
  así que un proveedor con productos asignados (desde Productos / Crear producto) pero sin costo
  mostraba "0" y la planilla vacía. `GET /pricing/preview` suma `uncosted`
  (`getUncostedSupplierProducts`: SKUs con proveedor y sin costo); cuentan en la pestaña y la planilla
  los lista abajo, "Sin costo cargado", agrupados por pack, con "Cargar costo" (costo nuevo con el
  proveedor de la pestaña como vigente). En Mapeo cada producto trae `suppliers` y la pestaña de un
  proveedor arranca en **De X** (sus productos) si tiene alguno; **Toda la tienda** es la vista de
  siempre, para asignarle códigos a lo que todavía no es suyo. Ojo: "Punto Cero" = todo lo que tenía
  costo antes de que existieran los proveedores (la migración lo dejó de vigente).
- `@for (…; track …)` con `??` rompe el compilador de Angular (`tmp_N is not defined` en runtime):
  usar `track a + '|' + b`.
- **Estructura de la página** (2026-10-15, el `.scss` único pasó el tope de 16 kB por hoja de
  `angular.json` y el build de producción fallaba): `precios.component` es solo la página contenedora
  (encabezado, pestañas, qué diálogo está abierto) y provee `PreciosStore` (`precios.store.ts`: las
  queries de config y planilla, pestaña de proveedor / vista en la URL, `changedSkus`, `notice`,
  `dialog`). Adentro, todos `OnPush`: `planilla/` (tabla, selección, aplicar, `zc-assign-dialog`),
  `proveedor/` (tarjetas de configs) y `dialogs/` (Ajustes, Importar, Costo, Historial de listas,
  Proveedor, Configuración), cada diálogo solo existe mientras está abierto. Helpers puros en
  `precios.utils.ts`. Los estilos de base (botones, badges, modales, campos) van una sola vez en
  `precios.component.scss` sin encapsulación y bajo `:where(.pr-page)` — especificidad cero, así el
  estilo propio de cada componente (y los de Mapeo) los pisa; cada componente trae solo lo suyo.

### Alertas de stock: sugerencia de reposición por pack, no por modelo

En "Para reponer" (`backend/src/services/alertsService.js`, `frontend/.../pages/alertas/`), cuando
un producto tiene pack la sugerencia de "a pedir" es del PACK completo, no de cada modelo por
separado. Antes se calculaba por SKU y se sumaban los packs de cada fila del grupo, lo que
multiplicaba la cantidad real por la cantidad de modelos en el pack (un pack surtido de 8 modelos
con 3 disparados de una pedía "3 packs" en vez de 1).

- **`computeShortfall(threshold, stockEffective) = max(threshold - stock, 1)`**: cuánto falta para
  llegar justo al umbral (sin colchón del doble; es un default editable, no impuesto).
- **`computePackSuggestedQty(members, pack)`**: la cantidad de packs es `ceil(max(faltante de cada
  modelo del pack) / unidades de ESE modelo por pack)` — manda el modelo con MENOS stock, porque
  pedir lo que él necesita también cubre a los demás. Las unidades de un modelo por pack son
  `floor(unitCount / modelCount)`: el pack reparte sus `unitCount` unidades entre TODOS sus modelos
  (`modelCount` = `pack.skus.length`, el total del pack, no solo los que hoy están bajos) a partes
  iguales — un pack de 8 con 3 modelos trae ~2,6 de cada uno, se cuentan **2** (piso, nunca menos de
  1, para no sobreestimar). Con `modelCount === unitCount` da 1 (1 modelo por unidad); con un pack
  `single` (`modelCount = 1`) da `unitCount` entero — mismo cálculo para los dos `mode`, no hace
  falta bifurcar. `modelCount` se arma en `buildSkuPackIndex` a partir del pack completo, no de los
  SKUs que aparecen en la lista de "Para reponer" (que pueden ser menos si no todos dispararon alerta).
- **Un SKU con pack no tiene sugerencia propia** (`RestockRow.suggested = null`): la sugerencia real
  es la del pack, repetida en `row.pack.suggestedPacks` de cada fila del grupo para que agrupar en
  el front sea trivial. La celda "A pedir" de ese modelo queda vacía y editable a mano (para pedir
  un extra puntual de un modelo específico), no lo pisa la sugerencia calculada.
- **Ajustes manuales (`restock_order_overrides`, `PUT /alerts/restock/override`)**: la usuaria puede
  pisar tanto la sugerencia de un SKU como la de un pack completo; `qty: null` borra el ajuste y
  vuelve al valor calculado. Son del pedido en curso, no config permanente — "Marcar pedido como
  hecho" los limpia (`clearRestockOverrides` en `closeRestockPeriod`).
- **SKU propio del pack** (`product_packs.sku`, opcional, NO único): el proveedor a veces le pone
  su propio código al pack armado, distinto del SKU de cada modelo. Se edita en Productos → Packs
  y se muestra al lado del nombre del pack en "Para reponer". Puede repetirse entre packs: un
  mismo producto a veces viene en pack de modelos viejos y en pack de modelos nuevos, y el
  proveedor le da el mismo código a los dos — sigue siendo el mismo producto, solo cambian los
  modelos que trae. Por eso NO hay constraint de unicidad en la columna (se sacó el índice único
  que había).
- **Stock en Depósito Marañón** (`RestockRow.depositoStock`, sumando filas `producto` de
  `deposito_stock` con ese SKU): se muestra en la fila para saber, antes de pedirle al proveedor,
  si ya hay unidades a mano guardadas en el depósito. Es informativo — no descuenta del faltante
  calculado ni cambia el estado de la fila.
- **Descartar una fila (`restock_dismissed`, `PUT /alerts/restock/:sku/dismiss`)**: una vez que el
  estado pasa a "Ya repuesto" la usuaria puede sacar esa fila del pedido en curso a mano (no la
  quiere pedir de nuevo). El descarte no es un default global: vuelve a aparecer solo si el SKU
  dispara una alerta NUEVA después de descartarla (`dismissed_at` comparado contra el último
  `created_at` de `stock_notifications` para ese SKU en `getRestockList`) — así un yo-yo de stock
  (repuesto → bajo otra vez) no la esconde para siempre. Se limpia al cerrar el período, mismo
  motivo que `restock_order_overrides`: es del pedido en curso, no config permanente.

### Pedidos al proveedor (`/pedidos`): las alertas sugieren, la usuaria decide

"Para reponer" mezclaba avisar con armar el pedido, y el pedido no quedaba guardado. Pero no todo lo
que avisa se pide (hay en el depósito; en un pack surtido de 8 modelos se agotó uno solo) y a veces
se pide algo que no avisó (compra para tener). Ahora el pedido es una entidad propia
(`supplier_orders` + `supplier_order_lines`, `services/ordersService.js`, `routes/orders.js`,
`frontend/.../pages/pedidos/`) y la pestaña "Para reponer" de Alertas se reemplazó por un aviso con
link (`/alertas?tab=reponer` redirige a `/pedidos`). Diseño: `docs/plans/2026-10-08-pedidos-proveedor-design.md`.

- **Nada entra solo al pedido.** El catálogo (`GET /api/orders/catalog`, `buildCatalog`) lista cada
  unidad de compra con filtro *Con alerta / Todos*: stock ML/TN, depósito, estado de la alerta (reusa
  `getRestockList` desde el último pedido), último pedido y si ya está **en camino** en uno
  pendiente. "Agregar sugeridos" es un atajo explícito.
- **Siempre se pide por pack.** La unidad es el pack del hub; un SKU sin pack se pide por el bulto de
  Precios (`product_costs.bulk_qty`, 1 si no hay). Un pack surtido muestra TODOS sus modelos aunque
  haya avisado uno; los diseños/colores que se quieren van en la columna libre **Detalle**.
- **Código** (lo que necesita la fábrica): `pack_code_map` → `product_packs.sku` → (pack de un solo
  modelo) `sku_code_map` del modelo; SKU suelto: `sku_code_map`. **Descripción**: la de
  `supplier_codes` para ese código, si no el nombre. Ambos se copian a la línea y son editables.
- **Precio de lista por pack** = precio por unidad del bulto de Precios (`bulk_price / bulk_qty`) ×
  unidades del pack. Editable por línea **solo para ese pedido** (nunca escribe en Precios):
  `price_source = 'manual'`. Las líneas `'precios'` de un borrador se refrescan al abrirlo
  (`refreshLinePrices`) y al duplicar; las editadas no. Ítems libres (productos que el hub no tiene)
  son siempre `'manual'`.
- **Descuentos encadenados por pedido**: `discount_1` sobre el subtotal y `discount_2` sobre lo que
  queda. Default 25% + 5% en `sync_settings` (`supplier_order_defaults`), editable desde la lista.
- **Estados**: `borrador` (varios a la vez, autoguardado con `PUT /:id` que reemplaza las líneas) →
  `pendiente` (`POST /:id/place`, corre el corte de alertas como el viejo "Marcar pedido como hecho")
  → `recibido` (`PUT /:id/receive` con `close`; `partial` si alguna línea llegó corta, sin dato = no
  llegó). **Recibir no toca stock** (ni ML/TN ni depósito): solo registra. Solo un borrador se edita
  o se borra (409 si no).
- **Repetir / Duplicar** (`POST /:id/duplicate`): `mode: 'missing'` copia solo lo que faltó con la
  cantidad faltante; `status: 'pendiente'` es "Repetir y marcar como pedido".
- **Vista para la fábrica** (`factory-sheet.ts`): hoja con código · descripción · cantidad · detalle,
  siempre en fondo blanco (sin tokens, es lo que se manda afuera). "Descargar imagen" la dibuja en
  canvas (sin dependencias) y "Copiar como tabla" pone HTML + TSV en el portapapeles.
- **Proveedor del pedido** (`supplier_orders.supplier_key`, 2026-10-15; los anteriores quedaron
  `'punto_cero'` — el `UPDATE … WHERE supplier_key IS NULL` corre en cada `initDb()` a propósito, por
  si un backend viejo sigue creando pedidos). Se elige al crear ("Nuevo pedido" abre un modal con los
  proveedores; con uno solo crea directo) y no se cambia después; duplicar/repetir lo conserva. Sin FK
  (el pedido es historial): borrar un proveedor con pedidos da 409 (`getSupplierUsage().orders`).
  - **Descuentos**: el pedido nuevo arranca con la config **default del proveedor** (misma cadena:
    el 1.º sobre la lista, el 2.º sobre lo que queda); `supplier_order_defaults` es solo el fallback
    de un proveedor sin config, y la lista ya no muestra su editor. `GET /api/orders/suppliers`
    devuelve cada proveedor con su descuento default y todas sus configs (`profiles`). En el editor
    del pedido (borrador) un selector **Config de descuento** ofrece las configs de ese proveedor:
    elegir una pisa los dos %. Los % siguen editables a mano para un pedido especial. La config NO se
    guarda en el pedido (sin migración): el selector muestra la que coincide con los % del pedido, o
    "Personalizado" si ninguna coincide.
  - **Catálogo** (`GET /api/orders/catalog?supplier=`): solo las unidades que se le compran a ese
    proveedor según `buildDiscountContext`/`suppliersOf` (asignación en Precios, código mapeado o
    vigente; en un pack, la unión de sus modelos — `unitSuppliers`) **más las que no tienen ningún
    proveedor** (`suppliers: []`), que el editor esconde detrás del tilde "Sin proveedor". El código y
    la descripción son los de ESE proveedor (`codesForSupplier`); el SKU propio del pack
    (`product_packs.sku`) solo se usa si el pack no tiene otro proveedor vigente. El precio sigue
    siendo el de Precios (= del vigente): si el vigente es otro, la fila dice "precio de X".
  - Lista: filtro por proveedor (los chips de estado cuentan sobre él) y el proveedor en cada fila.
- `createSupplierOrder` calcula `ordered_at` en JS: reusar un `$n` como valor de columna y en un
  `CASE` hace que Postgres deduzca dos tipos (mismo bug que tuvo `finishPublishJob`).

Los endpoints viejos de "Para reponer" (`/api/alerts/restock*`, overrides, descartes) siguen en el
backend —`getRestockList` alimenta el estado de alerta del catálogo— pero ya no tienen UI.

### Para despachar (`/despachos`): pendientes de envío de ML y TN, en vivo

Lista de paquetes que todavía no salieron, para armar y llevar al correo (la cuenta usa
`drop_off`: se lleva al correo/punto antes de un horario). `services/dispatchService.js`,
`routes/dispatch.js`, `frontend/.../pages/despachos/`. **Se lee en vivo de las APIs**, no de webhooks
ni de una tabla: son pocos pedidos por día y lo que importa es el estado de ahora.

- **ML no tiene "envíos pendientes del vendedor"** y `/orders/search` no filtra por estado del envío.
  Se traen las órdenes de los últimos `ML_LOOKBACK_DAYS` (15) con `getOrdersWindow`, se descartan las
  que no son `paid` (o tienen tag `delivered`), y por cada envío distinto `GET /shipments/:id`:
  pendiente = `handling`/`ready_to_ship` y `logistic.type` ≠ `fulfillment` (Full lo despacha ML).
- **Horario límite**: `GET /shipments/:id/sla` → `expected_date` (fecha + hora, el "antes de las X")
  y `status` (`delayed` = atrasado). Sin SLA cae al `lead_time.estimated_handling_limit` (solo día).
- **"Despachá el X día"** = **`pending/buffered`** (confirmado en los logs: el status es `pending`, no
  `ready_to_ship` — hasta 2026-10-10 se descartaban y faltaban en Próximos días) = substatus `buffered`: la etiqueta recién se habilita en
  `lead_time.buffering.date`. Va a la pestaña "Próximos días", no a "Hoy". **Ojo, feriados**:
  `buffering.date` no los salta (lun 12/10/2026 feriado: buffering = lunes, SLA = martes, ML dice
  "despachar mañana"), así que el día que se muestra es el más tardío entre buffering y el SLA
  (`mlDeadlineInfo`).
- **Carritos**: un paquete = `pack_id ?? order_id` (mismo criterio que ventas), con todas las líneas.
- **Despachado ≠ atrasado**: con drop_off, al dejar el paquete en el punto el envío **sigue
  `ready_to_ship`** hasta que el correo lo levanta y pasa a `shipped`. **Confirmado con los logs de la
  cuenta (2026-10-10): el substatus real es `in_packing_list`** (el punto lo escaneó en su lista) —
  se toma como despachado SOLO con `logistic.type` `drop_off`/`xd_drop_off`, porque en Colecta
  significa "entró en la lista de retiro". También `dropped_off`/`in_hub`/`picked_up`. `mlDispatchInfo` lo da por despachado y `isPendingShipment` lo excluye (si no, con
  el SLA vencido aparecía "Atrasado" algo que ya se había entregado). Lo entregado **hoy** (hora AR)
  va a la sección plegada "Ya despachados" (`bucket: 'dispatched'`); lo de días anteriores no se
  muestra. La hora sale de `substatus_history` y si no de `status_history.date_shipped`.
  "Atrasado" = venció **y** no se despachó. El chip de logística ("Llevar al punto") no se muestra
  para drop_off/xd_drop_off: es lo de siempre.
- **Fotos**: `getItems` multiget → `pictures[].secure_url` de la variación (por `picture_ids`, en su
  orden) o del ítem; thumbnail = misma URL con sufijo `-I`. TN trae `products[].image.src` en la orden.
- **TN**: `listOrders` (`lib/tiendanube.js`) con `status=open&payment_status=paid` y
  `shipping_status=unpacked` + `unfulfilled` (dedupe por id). TN no tiene horario límite: va a "Hoy",
  por antigüedad. TN contesta 404 a una página vacía: es lista vacía, no error.
- **Cancelados**: lo cancelado en las últimas 48 h que nunca salió (ML: pagado alguna vez + envío que
  `isSafeToAutoRestore` da por no despachado; TN: `status=cancelled&updated_at_min`) se muestra arriba
  en rojo "Cancelado, no despachar", con "desarmalo" si estaba tildado como preparado. "Entendido" lo oculta.
- **Marcas del hub** (`dispatch_marks`, PK `channel + sale_id`): `prepared_at`/`prepared_by` (tilde
  "Preparado") y `cancel_seen_at`. Se purgan a los 30 días en `initDb()`. Se mergean en cada request,
  así un tilde se ve al instante aunque la lista venga de la caché.
- **Costo para ML**: caché en memoria de 60 s (`?refresh=1` la saltea — botón "Actualizar") y los
  envíos en estado final (`shipped`, `delivered`, …) se memorizan por proceso: no se reconsultan.
  El front refresca solo cada 5 min y al volver a la pestaña.
- **Velocidad**: todo pasa por `mlLimiter`, así que el piso es la cantidad de requests; lo que se
  evitó son las barreras entre etapas. `loadMl` es un pipeline **por envío** (llega el envío →
  arrancan su SLA y las notas de sus órdenes) en vez de envíos (todos) → SLA (todos) → notas
  (todas); `getOrdersWindow` pide las páginas 2..N en paralelo; y una carga en vuelo se comparte
  (`inFlight`): abrir la página + "Actualizar" no dispara dos tandas. Cada carga loguea
  `[Despachos] ML en X ms — órdenes … · envíos+SLA+notas … · fotos …` para ver en prod dónde va el tiempo.
- **Notas = 2 de cada 3 pedidos** (logs de prod 2026-10-13: 133 pedidos por carga, 89 de notas →
  ~20 s, justo 133 × 150 ms del limitador). `GET /orders/:id/notes` es por ORDEN y no hay endpoint
  por pack ni campo `notes` en `/orders/search` (campos reales logueados 2026-10-13; trae un
  `comment`, sin verificar qué contiene — no se usa). Pero la usuaria carga la nota a la venta entera y **ML la repite en todas las órdenes del
  carrito** (confirmado en prod 2026-10-13), así que se pide **una orden por envío**, no una por
  producto (`noteOrderId` en cada paquete). Igual es un pedido por VENTA (no hay forma de pedir las
  notas de varias de una), así que **van aparte**: `GET /api/dispatch/notes` (`getDispatchNotes`) y
  el front las pide recién cuando llegó la lista (query con `generatedAt` en la clave) — la lista se
  ve sin esperarlas, con "Cargando notas de ML…", y si alguna falló (`failed`) se avisa. Se piden
  DESPUÉS y no en paralelo a propósito: comparten el limitador de ML y le sacarían turnos a los
  envíos. Siempre frescas (sin memo, a pedido de la usuaria; se comparten solo entre requests de la
  misma lista) y también para los despachados de hoy; a esos no se les pide el SLA. El SLA
  por envío sí se recuerda 10 min (`SLA_TTL_MS`): casi no cambia y "atrasado" igual se calcula
  contra la hora. El estado del envío se pide SIEMPRE (es lo que dice si ya salió).
- Si un canal falla (429, token), el otro se devuelve igual con `errors.{ml,tn}` y la UI lo avisa:
  una lista vacía nunca debe significar "no hay pedidos" cuando en realidad ML no contestó.
- **Notas de la venta**: las mismas que se cargan en el panel de cada canal, en un recuadro arriba
  de los productos. ML: `GET /orders/:id/notes` (`ml.getOrderNotes`) de una orden pagada por venta,
  aparte de la lista (ver arriba); si falla (429), el paquete sale igual sin nota.
  TN: `owner_note` (la de la vendedora) y `note` (la del comprador, rotulada "Comprador:"), que ya
  vienen en la orden, así que llegan con la lista.
- `zc-photo-lightbox` (`shared/components/photo-lightbox/`) es reusable: foto grande, flechas/teclado, Esc.
  Ojo: las flechas se centran con `top: calc(50% - 18px)`, NO con `transform` — el `button:active`
  global (`transform: scale(.98)`) pisaba el `translateY(-50%)`, el botón saltaba al apretarlo y el
  click caía afuera (con el teclado andaba, con el mouse no). Mismo cuidado con cualquier botón
  posicionado con `transform`.

**Sin verificar contra la cuenta real** (las credenciales locales son de un usuario de prueba sin
órdenes): la forma exacta de `/shipments/:id/sla` y de `lead_time.buffering` en el formato nuevo,
y que `logistic.type` de la cuenta sea `drop_off`. Tampoco los substatus de "entregado en el punto" ni la
forma de `substatus_history`/`status_history` con `x-format-new`: `loadMl` loguea
`[Despachos] envíos ML: {status/substatus: n}` para confirmarlo en prod. Confirmar la primera vez en prod comparando con
"Ventas → Preparar envío" de ML. El webhook `shipments` de ML podría invalidar la caché antes; no
hace falta para que funcione.

### Dashboard de ventas por provincia (`/ventas`): duplica ventas de ML localmente

Informe mensual para el contador: total facturado por provincia, sin canceladas ni devoluciones.
El hub no guardaba ventas —es un sistema de stock, no de facturación— y armar esto on-the-fly
costaría 1 request a ML por orden en cada visita (`GET /orders/:id` no trae provincia; hace falta
un `GET /shipments/:id` extra). Por eso se duplica localmente en `ml_sales_orders`/`ml_sales_items`
(`backend/src/db.js`) y **navegar a `/ventas` nunca le pega a ML** — `salesService.getSalesReport`
solo lee esas tablas. "Facturado" = Σ `unit_price × quantity` de los ítems, **sin envío** (acuerdo
explícito con la usuaria); el resto de los montos (`shipping_cost`, `total_amount`, `ml_fees`) se
guarda igual por si hace falta después. Se guardan también las canceladas y devueltas
(`computed_status`), para que la exclusión sea auditable sin volver a pegarle a ML.

**"Ventas" cuenta paquetes, no líneas de orden.** Incidente 2026-08-19: la usuaria comparó el
informe contra el Excel de ML de julio y el dashboard mostraba 236 ventas contra ~75-76 que había
contado a mano. Causa: cuando una compra tiene varios productos (carrito/pack), ML le da a **cada
producto su propio `order_id`** — todos comparten el mismo `pack_id`, pero son órdenes separadas
en `/orders/search`. Contar filas de `ml_sales_orders` cuenta productos disfrazados de ventas: un
pack de 9 productos aparecía como "9 ventas". Confirmado con el Excel real de la cuenta: 237 líneas
"Entregado" ≈ las 236 que mostraba la app, contra 51 paquetes en las mismas ~3 semanas (~78
proyectado al mes, en línea con el conteo a mano).

`aggregateSalesReport` (`salesService.js`) arma la clave de venta como `pack_id ?? order_id`
(`saleKey`) y cuenta paquetes **distintos**, no filas — tanto para el KPI total como por provincia
(`Set` por provincia, no un contador que suma 1 por fila). "Productos vendidos" (`kpis.unidades`)
NO cambió: sigue siendo la suma de `quantity` de todos los ítems, y es justamente lo que hace
visible la diferencia con "Ventas" en la UI (dos tiles separados, con el rótulo "Ventas
(paquetes)"). El total facturado tampoco cambió — nunca fue el problema, ya sumaba bien todas las
líneas; el bug era solo de conteo.

**Por qué duplicar obliga a mantenerlo sincronizado**: un comprador puede cancelar o devolver una
compra hasta 30 días después. `backend/src/services/salesService.js` resuelve esto en tres capas:

1. **Webhooks (tiempo real, capa principal)**: `upsertSaleFromOrder` se llama desde
   `routes/webhooks.js` al principio de `processMlOrderPayload` (venta pagada y cancelada) y desde
   `approvePendingReturn` en `syncService.js` (`markSaleReturned`, para devoluciones vía claim —
   ahí ML no cancela la orden, así que `classifyOrder` no la reclasifica sola). Reusa la orden que
   esos caminos ya trajeron: **cero requests extra a ML**. Va en su propio `try/catch`
   (fire-and-forget) para que un fallo acá nunca frene el descuento/restauración de stock.
2. **Barrido de seguridad** (`sweepRecentSales`): reprocesa (orden + envío) los últimos
   `REPROCESS_WINDOW_DAYS` (30) — la ventana coincide con el plazo de cancelación/devolución del
   comprador. Corre solo (chequeo cada hora contra `lastSyncAt` persistido, dispara si pasaron más
   de 24h — `scheduleSalesSweep` en `index.js`) y también con el botón "Actualizar"
   (`POST /api/sales/sync` → `triggerSync`, que dispara el backfill si nunca corrió). Una orden ya
   guardada con el mismo `ml_status` y fuera de esa ventana se saltea SIN pedir el envío — es lo
   que hace barato el "Actualizar" mensual.
3. **Backfill inicial** (`syncMlSales`, una sola vez): año en curso completo.

`ml.getOrdersWindow` (`backend/src/lib/mercadolibre.js`) pagina `orders/search` con los filtros de
fecha nuevos (`order.date_created.from/to`, `sort`) y, si `paging.total` supera 1000 (el tope de
`offset` de ML), parte el rango de fechas al medio y recursa — con el volumen de esta cuenta
(cientos de órdenes/mes) casi nunca se llega, pero sin la guarda se perderían órdenes en silencio.

**Ojo, sin verificar contra un payload real de esta cuenta**: la forma exacta de la provincia en
`GET /shipments/:id` (`extractShipmentLocation` en `salesService.js`, cubre
`destination.shipping_address` y `receiver_address`) y si `orders/search` respeta
`order.date_last_updated.from` (por eso el barrido usa solo reproceso por `date_created`, no ese
filtro). Confirmar la primera vez que corra el backfill contra la cuenta real.

`GET /api/sales/report` agrega KPIs + comparativa contra el período anterior (mismo largo en
días, no el mes calendario — ver el comentario en `computePreviousPeriod`) + provincias + top
productos + evolución diaria, todo del rango pedido. `GET /api/sales/export` arma el mismo cálculo
en CSV (separador `;`, coma decimal) para mandarle al contador.

### Crear producto: modelo User Products de ML, publicación en background e historial

Incidente 2026-09-06: publicar un producto con variantes en ML fallaba siempre con *"The body does
not contains some or none of the following properties [family_name, price, available_quantity];
The field variations is invalid with family name"*. No era un bug de armado del payload: la cuenta
ya está migrada al modelo **User Products** (`user_product_seller` en `GET /users/me`, ver
`backend/src/lib/mlUserProducts.js`, cacheado 1 h). En ese modelo `POST /items` **rechaza**
`variations[]` y **rechaza** que el vendedor mande `title` — hay que mandar `family_name` y crear
**un ítem por variación**; ML agrupa los que comparten `family_name` + dominio + condición +
atributos PARENT_PK en una sola familia (una ficha con selectores para el comprador). Por eso
`single_with_variants` bajo User Products también termina en N `POST /items`, no en uno solo — la
diferencia con `one_per_variant` es que ahí cada ítem lleva su **propio** `family_name` (no
comparten ficha). `buildMlItems` (`backend/src/services/productPublish.js`) bifurca por
`opts.userProducts`; el modelo legacy (`variations[]`, un producto = un ítem) se mantiene intacto
para cuentas que no estén migradas.

Como consecuencia, cada eje de variante necesita mapear a un atributo REAL de la categoría de ML
(ej. `COLOR`) para que ML pueda agrupar la familia — antes el eje era texto libre. En "Variantes"
cada eje tiene un selector con los atributos `allowVariations` de la categoría elegida (la ruta de
atributos, `GET /categories/mercadolibre/:id/attributes`, ya no los excluye: los devuelve marcados
con `allowVariations: true` en vez de esconderlos). `axisAttributes()` arma el atributo del ítem —
`value_id` si el valor coincide con una opción cerrada del atributo (lo que ML prefiere, normalizado
sin acentos/mayúsculas), si no `value_name`; sin mapeo, atributo personalizado (`{name, value_name}`,
sin `id` de categoría, que ML también acepta). `categoryAttrs()` excluye el atributo ya usado como
eje de la lista general, para no mandarlo dos veces.

**`allowVariations` que NO es eje = característica normal.** `loadMlAttributes` mete TODOS los
atributos a `d.ml.attributes` (antes filtraba los `allowVariations`). El store los esconde de
`mlRequiredAttrs`/`mlOptionalAttrs` **solo si están mapeados a un eje** (`attrUsedAsAxis`), y
`buildPayloads` no los manda dos veces. Así un atributo como `YEAR` ("Año" en agendas, que ML marca
`allow_variations`) que la usuaria NO usa como eje aparece en "Más características (opcionales)" para
completar una vez (`Año = 2027`) y viaja en todas las publicaciones. `refreshMlVariationAttrs` (path
de restaurar un borrador) ahora además **mergea** los atributos de la categoría que falten en
`d.ml.attributes` sin pisar los valores ya cargados — así un borrador migrado toma campos que ML
agregó después.

**Atributos `conditional_required` (par `SALE_FORMAT` ↔ `UNITS_PER_PACK`).** Incidente 2026-09-07:
publicar en categorías de librería (cuadernos, agendas) fallaba con *"Attribute [UNITS_PER_PACK] to
be added…; 'Unidades por pack': Completá este campo porque completaste 'Unidad'"*. Causa: el
predictor de categoría pre-infiere `SALE_FORMAT` ("Formato de venta": Unidad/Pack), y ML marca
`UNITS_PER_PACK` con el tag `conditional_required` — obligatorio SOLO cuando `SALE_FORMAT` tiene
valor, cosa que la ruta de atributos ignoraba (`required` solo miraba `required`/`new_required`), así
que `UNITS_PER_PACK` caía en la sección "opcionales" plegada y nunca se completaba. ML no publica la
condición en el payload (solo el tag), así que el par conocido va hardcodeado en
`CONDITIONAL_REQUIRED_TRIGGERS` (`product-draft.model.ts`). Tres piezas:
- **Ruta** `GET /categories/mercadolibre/:id/attributes`: expone `conditionalRequired` (tag
  `conditional_required`), aparte de `required`.
- **Front**: `store.attrIsRequired(attr)` = `required || (conditionalRequired && su disparador tiene
  valor)` — sube el atributo a la sección de obligatorios y le pone el asterisco.
  `prefillConditionalRequired()` precarga `UNITS_PER_PACK` en `1` (lo llama `setMlAttributeValue` y
  la carga inicial de atributos) — correcto para "Unidad" y para esta app (se publica por unidad).
- **Backend, red de seguridad**: `withUnitsPerPack()` en `productPublish.js` — si el body lleva
  `SALE_FORMAT` y `UNITS_PER_PACK` falta, viene vacío, con basura o con un `value_id` espurio (que
  ML rechaza con *"El valor que ingresaste … es incorrecto"*, típico de un borrador migrado de
  antes del fix), lo **normaliza** a un entero positivo por `value_name` (default `1`). No pisa un
  entero válido que ya mandó el usuario.

**Otros tres bugs del mismo reporte, sin relación con User Products:**

- **Descripción de TN corrida**: TN renderiza `description` como HTML, y se le mandaba texto plano
  tal cual. `plainTextToHtml()` (`backend/src/lib/richText.js`) convierte doble salto de línea en
  párrafo y salto simple en `<br>` — pero si el texto YA trae una etiqueta reconocible, lo deja
  pasar intacto (el campo admite HTML a mano). TN modela `description` como objeto por idioma
  (`{es, pt?}`, igual que `name`): se aplica a CADA idioma presente, no al objeto entero.
- **Orden de fotos de TN equivocado**: en `one_per_variant`, la galería de cada producto salía
  filtrando la galería GENERAL (`galleryIds.filter(id => assigned.has(id))`), que preserva el
  orden de la galería, no el que la usuaria eligió PARA ESA VARIANTE en el modal
  (`variant-photos-dialog`). Ahora usa `variant.tn.image_ids` en su propio orden — la portada es la
  primera foto de ESE orden.
- **`"Color: Rojo"` en vez de `"Color"` + `"Rojo"`**: el front metía el nombre del eje dentro del
  valor de cada variante TN para compensar que nunca se mandaba `attributes` (nombres de eje) a
  nivel producto. Ahora `buildPayloads()` arma `tn.attributes` desde `d.axes` y los valores de
  variante viajan limpios; `buildTnProducts` solo lo manda en `single_with_variants` (un producto
  con variantes adentro) — en `one_per_variant` cada producto es una sola variante y no aplica.

**Instagram / Google Shopping en TN**: `mpn`, `age_group` y `gender` son campos de VARIANTE en la
API de TN. Se cargan una única vez en "Datos comunes" (`common.mpn/ageGroup/gender`, default
`'adult'`/`'unisex'`) y se copian a cada variante al publicar (`normalizeTnVariant`).

**Publicar un solo canal**: ya existía de punta a punta (`channels` en el payload, `publishProduct`
público) pero sin botón — el único disparador era "Reintentar" tras un fallo. El botón "Publicar en
ambos" pasa a ser un botón partido con menú ("Solo Mercado Libre" / "Solo Tienda Nube"). De paso,
`publish-results.component.html` indexaba `results()[1].status` asumiendo SIEMPRE 2 resultados —
con un solo canal (`results()[1]` es `undefined`) explotaba; ahora usa `results().every(...)`.

#### Imágenes en Supabase Storage (Fase 0: habilita el resto)

Railway (Hobby) tiene disco efímero: `data/tmp-images/` se borraba en cada deploy y rompía
borradores no publicados. `backend/src/services/imageStore.js` mantiene su interfaz (`saveImage`,
`getImage`, `saveThumbBuffer`, `getThumb`, `removeImage`, `purgeOld` — todas ASYNC ahora) pero
elige backend según haya `SUPABASE_URL`/`SUPABASE_SERVICE_KEY`: con esas variables, Supabase
Storage (bucket público `SUPABASE_BUCKET`, default `product-images`, un objeto `<id>/original.<ext>`
+ `<id>/meta.json` + `<id>/thumb.jpg` por imagen); sin ellas, cae al disco de siempre (solo sirve
para dev). `getImageUrl(id)` da la URL pública si hay Supabase, `null` si no.

Con URL pública, ML y TN descargan la foto solos en vez de recibirla por multipart/base64 — con 10
fotos por variación esto es la diferencia entre 1 request y 10. `resolveMlImages()` intenta
`getImageUrl` antes de subir por multipart; el body de ML mezcla refs `{source: url}` y `{id:
picture_id}` sin problema. Para TN, `embedTnImages()` arma `images:[{src,position}]` para el propio
`POST /products` (confirmado que la API lo acepta en la creación) — si falta la URL de alguna
imagen, cae entero al camino viejo (`uploadTnImages`, un POST por foto + reconciliación de orden).
Con URLs, la posición la fija TN al crear; igual queda una verificación final contra
`GET .../images` que corrige con PUT si el orden real no coincidió (`reconcileTnImageOrder`) —
**sin verificar en vivo contra la API real**, a confirmar la primera vez que se publique con
Supabase configurado.

Borrado de huérfanas: `purgeOld(isReferenced, now)` — con Supabase no hace nada (el borrado es en
cascada al borrar el borrador, ver abajo); en disco, solo borra lo vencido (72 h) que además no
aparezca en ningún `draft_json` (`backend/src/index.js`, `collectReferencedImageIds` arma un Set
con TODOS los ids de imagen de TODOS los borradores buscando el patrón de 32 hex como substring —
barato, no hace falta parsear la estructura del draft).

**Aviso de capacidad (tope de 1 GB del plan Free de Supabase Storage — los 50 MB son el máximo por
ARCHIVO, un límite aparte y no configurable, no la capacidad total).** `getStorageUsage()` suma
recursivamente TODO lo que hay en el bucket (no solo lo referenciado por un borrador: una foto
subida y nunca guardada, o restos de un fallo a mitad de publicar, ocupan espacio real igual y no
se limpian solas en Supabase). La API de Storage lista un nivel por vez (como S3 con delimitador
"/"): cada carpeta es un id de imagen y hay que bajar un nivel más para sumar sus archivos — con
1 GB de tope y fotos de un par de MB, el nivel raíz puede superar sin problema las 1000 entradas
por llamada, así que pagina con `offset` hasta que una página vuelve incompleta. Se cachea 60 s
(`GET /api/products/storage-usage`) para no recorrer el bucket entero en cada polling del panel. El
panel "Mis borradores" (`drafts-panel.component.*`) muestra un aviso a partir del 85% (crítico
desde el 90%) — se refresca solo junto con la lista de borradores (entrar a la página, guardar o
borrar uno), sin acción extra de la usuaria.

#### Publicación en background con historial (Fase 2)

Publicar tardaba varios minutos (varias variantes, dos canales, fotos) de forma SÍNCRONA — cerrar
la pestaña cortaba todo — y reintentar un canal fallido duplicaba lo ya creado (no había memoria de
qué se había publicado). Los borradores vivían solo en `localStorage`, así que tampoco había forma
de retomarlos desde otro navegador ni de conservar qué pasó.

**Tablas nuevas** (`backend/src/db.js`, `initDb()`): `product_drafts` (el `ProductDraft` como
`draft_json`, más `status`: `draft|publishing|published|partial|error`), `product_publish_jobs` (un
intento de publicar — `channels`, `payload_json` INMUTABLE, el snapshot exacto que se publicó, no
el borrador que pudo seguir editándose mientras el job corría) y `product_publish_units` (una fila
por ítem ML / producto TN dentro de un job — `unit_key` es el SKU, o `''` cuando el job entero es
una sola unidad atómica, ver `mlUnitKey`/`planTnUnits` en `productPublish.js`).

`product_publish_units` es a la vez el PROGRESO y la IDEMPOTENCIA: reintentar re-encola el MISMO
job y el worker (`backend/src/services/publishWorker.js`) saltea las `unit_key` que ya están `'ok'`
— así fallar en la unidad 3 de 5 y reintentar no duplica las 2 primeras. Mismo patrón de lock que
`ml_pending_tasks` (`claimNextPublishJob`: `FOR UPDATE SKIP LOCKED`, latido cada 30 s, lock vencido
a los 5 min — más largo que los 2 min de la cola de ML porque publicar de verdad tarda más), pero
es una tabla e idempotencia APARTE: `ml_pending_tasks.idempotency_key` hace coalescing con `DO
UPDATE` (la tarea más nueva pisa a la anterior), que es exactamente lo que NO se quiere para una
creación (pisar una publicación encolada con otra). `recomputeDraftStatus(draftId)` arma el
`status` del borrador mirando, POR CANAL, el job terminado más reciente que lo haya incluido —
así un reintento de un solo canal (`channels: ['tn']`) no pisa lo que ya se sabía del otro.

Endpoints nuevos bajo `/api/products` (`routes/products.js`): CRUD de `/drafts` (borrar limpia en
cascada jobs/unidades Y las imágenes referenciadas, vía el mismo regex de 32 hex que el purgado),
`POST /drafts/:id/publish` (encola, devuelve `202 { jobId }`), `GET /jobs/:id` (progreso, para
polling), `POST /jobs/:id/retry`, `DELETE /jobs/:id`. El `POST /` síncrono viejo se mantiene
mientras dure la migración del front; el plan es retirarlo.

**Frontend**: los borradores pasan de `localStorage` al backend. `ProductDraftStore.saveDraft()` /
`openDraft()` / `deleteDraft()` / `restoreMostRecentDraft()` / `refreshSavedDraftsList()` ahora son
async y pegan a `CatalogService` (`createDraft`/`updateDraft`/`getDraft`/`deleteDraft`/`listDrafts`).
Migración ÚNICA de lo que hubiera en `localStorage` (`migrateLocalDraftsToBackend`, flag
`zc-crear-producto-drafts-migrated-to-backend`): si no hay nada que migrar, NO marca el flag —
representa "ya subí datos reales", no "ya miré una vez", así que no se "gasta" en un chequeo vacío.
Dos cosas del borrador NO se persisten (son metadata de la categoría de ML, no del producto):
`mlMaxPictures`/`mlMaxPicturesPerVar` y los candidatos a eje (`mlVariationAttrs`) — al restaurar un
borrador con categoría, `crear-producto.component.ts` los vuelve a pedir (`refreshMlCategoryLimits`/
`refreshMlVariationAttrs`).

`publish()` guarda el borrador (crea el id si hace falta), encola el job y pollea `GET /jobs/:id`
cada 1,5 s hasta `done`/`error`, actualizando `publishProgress` (una fila por unidad) en cada
vuelta — visible en pantalla mientras corre, sin bloquear si se cierra la pestaña (el job sigue en
el servidor). El borrador YA NO SE BORRA al publicar con éxito (antes sí): el `status` que ve "Mis
borradores" lo recalcula el propio backend cuando el job termina, y el historial de publicación
queda conservado para poder reintentar un canal después. "Editar publicación" (mismo form cargando
una publicación ya creada, actualizando ambos canales) queda fuera de esta rama — editar en ML
tiene reglas propias (no se puede tocar `title`, `family_name` solo se cambia sin ventas) que
ameritan su propio diseño.

**El panel de publicación sobrevive a cerrar la pantalla.** Antes, `publishing`/`publishProgress`/
`publishResults` eran señales en memoria: salir de `/crear` y volver cargaba el borrador y nada más
—no se sabía si el último intento anduvo, falló o seguía corriendo—. Ahora `GET /drafts/:id` ya
traía `jobs[]`; `ProductDraftStore.lastPublishJob` guarda el más reciente y un `effect` en
`crear-producto.component.ts` (una sola vía para el restore de `ngOnInit` y para "Mis borradores",
que llama a `store.openDraft` sin pasar por el componente) llama a `resumeLastPublishJob`: si el
job sigue `pending`/`processing` retoma el polling (el job vive en el server), y si ya terminó
repuebla `publishProgress` + `publishResults` desde `GET /jobs/:id` **sin republicar**. El guard
`resumedJobId` evita rehacerlo; el `effect` usa `allowSignalWrites` porque el resume pone
`publishing` en true antes del primer await. "Reintentar" desde ese panel reusa `publish([canal])`
(job nuevo con los datos actuales del borrador) — así toma una corrección de datos (ej. el atributo
que faltaba), a diferencia de `POST /jobs/:id/retry`, que reusa el `payload_json` congelado.

**Progreso real "X de Y" + barra.** `runChannel` solo insertaba una fila en `product_publish_units`
al confirmar/fallar cada unidad, así que el front nunca tenía el total. Ahora `runMlChannel`/
`runTnChannel` llaman a `seedPublishUnits(jobId, canal, unitKeys)` **antes** de publicar —
`INSERT ... ON CONFLICT DO NOTHING`, así un reintento no pisa las que ya quedaron `ok`/`error`—.
Con eso `publishTotals()` (computed) da `total`/`done`/`ok`/`err`/`pending` desde la primera vuelta
y `publishPhase()` (`running`/`partial`/`done`/`idle`) decide el encabezado (spinner "Publicando…
(3 de 8)" / alerta "Se publicó con errores" / check "Publicado"). El viejo `<zc-publish-results>`
se fusionó en este panel (`.publish-progress`): las filas en error muestran un chip "Falló", un
resumen en castellano (`publishErrorSummary`, ej. `UNITS_PER_PACK` → "Falta completar 'Unidades por
pack'") y el texto crudo de la API colapsado en `<details>`; con todo `ok` las N filas se pliegan.

**Cancelar una publicación (en curso o trabada).** El worker corta el fan-out de un canal en el
primer error, así que las unidades que venían después quedan `pending` para siempre; y un deploy a
mitad de un job lo deja en `processing` hasta que vence el lock (~5 min). `cancelPublishJob()`
(`db.js`) marca el job `cancelled` — `claimNextPublishJob` no lo re-toma (solo mira
`pending`/`processing` con lock vencido), `recomputeDraftStatus` lo ignora (solo `done`/`error`), y
`finishPublishJob` no lo revive (`WHERE status <> 'cancelled'`). El worker consulta
`isPublishJobCancelled(job.id)` **entre unidad y unidad** (`runChannel`) para frenar un fan-out en
vivo — lo ya creado en ML/TN NO se revierte (son publicaciones reales). Ruta
`POST /api/products/jobs/:id/cancel` (409 si el job ya terminó). En el front: `publishPhase()` suma
`'cancelled'`, hay botón "Cancelar" mientras corre (`cancelPublish()` → corta el polling ya, sin
esperar la respuesta) y el panel explica que lo publicado queda.

**Validación pre-publicar (botón deshabilitado).** `ProductDraftStore.publishBlockers` (computed)
arma la lista de faltantes que ML/TN rechazan sí o sí — nombre, SKU, categoría de ML, atributos
obligatorios de ML sin completar (usa `attrIsRequired`, así entran los `conditionalRequired`
disparados), categorías de TN, precio/stock (base o por variante), SKUs de variante repetidos, ejes
sin variantes generadas. `canPublish` = lista vacía. La lista se muestra arriba de las acciones y
**el botón "Publicar en ambos" (y el ▾) quedan deshabilitados** con `!canPublish()`. `publish()` no
se auto-bloquea (el gate es el botón; el reintento de un canal no pasa por la validación).

**Idempotencia de la creación en TN + fotos de a una.** Dos problemas encontrados probando en prod:
TN devolvía 500 en `POST /products` (baja las imágenes DENTRO del request; su doc recomienda máx. 9
y nosotros mandábamos 10+) dejando el producto creado con fotos incompletas, y el reintento
re-encolado volvía a llamar `createProduct` → "me creó 3 veces la misma variante". Cambios en
`productPublish.js` + `tiendanube.js`:
- **`publishTnUnit` crea el producto PELADO** (sin `images` en el body) y sube las fotos **de a una**
  con `tn.createProductImage({src, position})` — `src` = URL pública de Supabase (descarga
  server-to-server). Función nueva `syncTnProductImages`: lee las que el producto ya tiene
  (`getProductImages`), sube solo las que faltan (por posición, en orden) y corrige el orden. Reusa
  `getImageUrl`/`getImage` de `imageStore`. Reemplaza a `embedTnImages` + `tnImageMapFromCreated`
  (que mapeaba por índice y descolocaba las fotos si TN creaba menos de las pedidas) +
  `uploadTnImages` + `reconcileTnImageOrder`.
- **Idempotencia**: busca por SKU (`tn.findProductBySku`, `GET /products?q=<sku>`, con `retries` por
  el lag del índice de TN) **antes** de crear —y **después** si `createProduct` tira— y adopta el
  producto existente; en el camino adoptado **igual completa las fotos que falten** (antes las
  salteaba todas). Si `q` no matchea el SKU en la tienda, `findProductBySku` devuelve `null` y el
  flujo cae al de antes (sin verificar contra la API real).
- **`fetchTn`**: ahora tiene `AbortSignal.timeout` (30s, 60s en `createProductImage`) y reintenta
  5xx transitorio, además de 429. `fetchWith429Retry` de ML también tiene timeout (`mlFetch`). Sin
  esto un request colgado dejaba a `processJob` esperando para siempre.

**El job que quedaba en `processing` para siempre.** Un request colgado (sin timeout, ver arriba) o
un `finishPublishJob` que fallaba en silencio dejaban el job abierto y el panel "Publicando…" con
spinner eterno. Tres piezas:
- **Timeouts de red** en ML y TN (arriba).
- **Techo al latido** (`publishWorker.processJob`): pasado `PUBLISH_JOB_MAX_RUNTIME_MS` (15 min) el
  latido deja de refrescar `locked_at`, así el job vuelve a ser reclamable por lock vencido.
- **`reconcileStalePublishJobs()`** (`db.js`, la corre el worker 1 vez/min): cierra jobs
  `pending`/`processing` con lock vencido cuyas unidades están **todas** en estado terminal
  (`done` si todas ok, si no `error`) y marca `error` los zombis (`processing` con `attempts >= 5`,
  que `claimNextPublishJob` ya no toma). `finishPublishJob` ahora devuelve `rowCount > 0` y loguea
  cuando no actualizó nada.
- **Front**: `getPublishJob` tiene `timeout(10s)` + reintentos; `pollJob` cuenta fallos consecutivos
  y tras 5 pasa a la fase nueva **`unknown`** ("No pudimos confirmar el estado" + botón
  **Actualizar** = `retryPoll()`), en vez de spinner infinito.

**Producto simple (sin variantes): el modo de mapeo no aplica.** Incidente 2026-09-27: un producto
de una sola cosa publicado con TN en "1 producto por variante" se creaba en TN **sin fotos**.
`buildTnProducts` ya armaba UN producto en cualquier modo cuando no hay variantes, pero
`planTnUnits` entraba igual a la rama `one_per_variant` y buscaba las fotos en `variants[0]` (que no
existe) → `uploadIds = []`. Ahora, sin variantes, sube la galería general del canal sin importar el
modo. De paso: la usuaria cambiaba a ese modo porque con el default le seguía apareciendo "Falta el
stock" ya cargado — no era por el modo, sino porque los `[(ngModel)]` sin `(ngModelChange)` no
renuevan la referencia de `draft()` y el `computed` `publishBlockers` quedaba viejo hasta que otra
acción llamaba a `touch()` (cambiar el modo lo hacía). El handler delegado de `input`/`change` de la
raíz de la página ahora llama a `store.touch()` (antes solo `scheduleAutosave()`), así cualquier
campo recalcula los bloqueadores al tipear.

**Medidas y características con unidad que ML descartaba en silencio.** Incidente 2026-09-27: las
publicaciones salían sin alto/ancho y sin algunas características opcionales, sin ningún error.
Dos causas:
- **`number_unit` sin unidad**: atributos como `WIDTH` ("Ancho") o `LENGTH` ("Largo") de cuadernos
  son `number_unit` (default `cm`). Con `"20"` pelado ML crea la publicación igual y **tira el
  atributo**. `mlAttrPayload` (store) y `withDefaultUnit` (`productPublish.js`, dentro de
  `sanitizeMlAttributeValues` — cubre borradores viejos y `POST /jobs/:id/retry`) le ponen la
  unidad por defecto de la categoría (`defaultUnit`, NO `allowedUnits[0]`: en algunas categorías
  la primera es `"` = pulgadas); coma decimal → punto; si ya trae unidad, se respeta. En la UI el
  campo muestra la unidad al lado.
- **Paquete todo-o-nada con mínimo inventado**: `packageAttributes` exigía dim ≥ 3 cm y peso ≥ 50 g
  (no sale de la API de ML) y si una medida no cumplía no mandaba NINGUNA `SELLER_PACKAGE_*` — un
  cuaderno de 2 cm de alto salía sin medidas. Ahora manda cada medida con dato, redondeando para
  ARRIBA (nunca declara un paquete más chico que el real). Sin verificar en vivo que ML acepte
  medidas < 3 cm: si las rechazara, el error ahora se ve en el panel de publicación en vez de
  perderse.

**Medidas del paquete (Largo × Ancho × Grosor).** Se cargan una vez como paquete, igual que ML:
Largo → `SELLER_PACKAGE_LENGTH`, Ancho → `_WIDTH`, Grosor → `_HEIGHT`. TN, en cambio, muestra el
producto PARADO, así que ahí va rotado (`tnDims` en `crear-producto.component.ts`): Largo → `height`
("Alto"), Ancho → `width`, Grosor → `depth` ("Profundidad"). Un cuaderno 20×15×1 se ve en TN como
Alto 20 · Ancho 15 · Profundidad 1. Hasta 2026-09-27 el Largo iba a `depth` y el grosor a `height`
(al revés de como lo lee la usuaria). Al costo de envío no le cambia nada (usa el volumen). Los 4
casilleros tienen etiqueta visible: con solo placeholder, al escribir el número se perdía cuál era cuál.

**Atributos que ML descarta en silencio + medidas heredadas.** ML puede crear el ítem OK y no
guardar un atributo (sin error). `publishMlUnit` compara lo mandado contra el ítem que devuelve
`POST /items` (`mlDroppedAttributes`) y suma al `detail` de la unidad "ML no guardó: X" + los
`warnings` de la respuesta — visible en la página Publicaciones y en los logs (`[Publish]`). En el
form, los atributos de medida que repiten Datos comunes (`ML_ATTR_FROM_COMMON`: `LENGTH`/
`PAPER_HEIGHT` ← Largo, `WIDTH`/`PAPER_WIDTH` ← Ancho, en cm) se mandan con ese valor si quedan
vacíos (se ve como placeholder); escribir uno propio lo pisa.

**"No aplica" en características de ML.** Sin él, ML cuenta la característica como incompleta. Se
manda como `{ id, value_id: "-1", value_name: null }` (si `value_name` no es null, ML lo ignora).
**ML no informa por atributo cuáles lo admiten** — verificado 2026-09-27: ni `GET
/categories/{id}/attributes` ni la ficha técnica (`/domains/{domain}/technical_specs/input`) traen
esa marca. La regla, genérica para cualquier categoría, sale de lo que rechaza `POST /items`
(probado con `POST /items/validate`): no en un `required` (*"X is a required attribute … and
cannot be not applicable"*), no en un `conditional_required` ya disparado (`UNITS_PER_PACK` con
`SALE_FORMAT` completo) y no en `allow_variations` (doc de ML). `store.canBeNotApplicable()` la
implementa (además de no ofrecerlo en heredados, `BRAND`). En la UI cada característica es un
bloque parejo (etiqueta + chip "No aplica" arriba, campo a todo el ancho abajo); marcado, el campo
se reemplaza por una caja punteada "No aplica a este producto" (mismo patrón de solo lectura que
"del común"). "No aplica" gana sobre la medida heredada de Datos comunes, un disparador en "No
aplica" no dispara su condicional (front `attrIsRequired` y back `withUnitsPerPack`), y si el
atributo pasa a obligatorio después, el N/A se ignora al armar el payload. Backend:
`sanitizeMlAttributeValues` deja pasar el `-1` normalizado (antes lo descartaba por no estar en
`values[]`) salvo en `allow_variations`, y `mlDroppedAttributes` no lo cuenta como descartado (ML
no devuelve los N/A sin `include_internal_attributes=true`).

**Default de tipo de publicación = "Clásica" (`gold_special`).** Antes era `gold_pro` ("Premium"),
que activa "cuotas sin interés" (las financia ML y el vendedor paga más comisión) — salía sin que
la usuaria lo pidiera. Se puede subir a Premium por producto en el form.

**`LOCAL_TEST_MODE=1`** (`backend/src/index.js`): para levantar el backend LOCAL contra el `.env` de
PROD y probar el flujo de publicación de punta a punta. Arranca **solo la API + el publish worker**;
NO el worker de `ml_pending_tasks` (haría cambios de stock reales), NI el auto-refresh del token de
ML (el refresh token es de un solo uso — si local lo rota, prod pierde la sesión), NI el barrido de
ventas ni el purgado de imágenes. Nunca ponerla en el deploy. Durante la prueba conviene pausar
Railway para que el job lo tome el worker local (`FOR UPDATE SKIP LOCKED` lo da a cualquiera de los dos).

**Alerta de stock al crear el producto.** Sección "Alerta de stock" (`components/stock-alert-section`,
`d.alert` en el borrador): checkbox, umbral y cómo se le compra al proveedor — suelto, pack
existente (`packId`) o pack nuevo (nombre, unidades, surtido/un modelo, SKU del pack). Es la misma
regla de Alertas → Reglas: una por SKU (con variantes, una por SKU de variante, mismo umbral). Viaja
en `payload.alert` del job y la aplica el publish worker (`applyPublishAlert`,
`backend/src/services/publishAlert.js`) **solo si quedó al menos una unidad `ok`** — sin nada
publicado el SKU no existe. Es idempotente para que reintentar no duplique: `upsertStockAlert`,
`setSkuPack` (upsert) y el pack nuevo se busca por nombre (sin mayúsculas) antes de crearlo. Va en
su propio `try` después de cerrar el job: un fallo acá nunca cambia el resultado de la publicación.
Con la alerta activada, `alertBlockers` (umbral, pack elegido, nombre/unidades del pack nuevo) se
suma a `publishBlockers`.

### Página "Publicaciones" (`/publicaciones`): productos del hub + historial

Diseño completo (incluye las fases siguientes: editor y aplicar cambios):
`docs/plans/2026-10-12-publicaciones-mapeo-edicion-design.md`. Prototipo:
`docs/prototype/publicaciones-mapeo.html`.

Dos pestañas (`publicaciones-page.component.ts`, `?tab=historial`):

**Productos** (`pages/publicaciones/productos/`, `GET /api/hub-products`, `routes/hubProducts.js`,
`services/hubProductsService.js`): cada producto del hub junta sus publicaciones de ML y de TN. Una
publi de ML con 4 colores puede ser 4 productos de TN, o 3 ítems de una ficha de ML ser 1 producto
de TN — no es 1:1.
- **El mapeo no se guarda: se calcula** en cada lectura desde la foto del catálogo
  (`getCatalogRows`, todas las filas crudas, también sin SKU o repetidas). Es un grafo:
  nodos = publicaciones (`ml:<itemId>`, `tn:<productId>`), aristas = SKU presente en las dos puntas
  + ítems de ML de la misma ficha de User Products (`family_name` + `domain_id`). Cada componente
  conexa es un producto. El id del grupo es el menor nodo (`ml:MLA…` gana), así no depende del orden
  de las filas y sirve de link (`?p=`).
- Estado por grupo: `orphan` (variante en un solo canal o sin SKU) · `duplicate` (SKU repetido en un
  canal) · `desync` (stock distinto) · `only_ml` · `only_tn` · `linked`. La lista ordena lo que
  necesita atención primero; los chips cuentan sobre la búsqueda, sin el filtro de estado.
- **Vincular** (`POST /api/hub-products/link`): a una variante sin par le busca otra sin par del otro
  canal (`/link-candidates`) y les pone el mismo SKU. Solo escribe el canal cuyo SKU cambia; 409 si
  el SKU ya lo usa otra variante. ML va por la cola (`sku_ml`, parchea la foto al terminar); TN se
  escribe directo y se parchea la foto (`patchTnSku`) en el momento.
- La foto del catálogo suma por fila de ML `format` (`legacy` = `variations[]`, `up` = User Products,
  `simple`), `soldQuantity`, `status` y, solo en `up`, `familyName`/`domainId`. Se guarda lo mínimo
  a propósito: el snapshot entero se lee de Postgres en cada consulta y cuenta para el egress (ver
  abajo). El permalink se arma desde el id. Un snapshot viejo sin `format` se lee como `legacy` si la
  fila tiene variación.
- Navegar no le pega a ML/TN; "Actualizar" (`?refresh=1`) fuerza el crawl completo, igual que
  Conflictos.

**Editar publicación** (`/publicaciones/:key/editar`, solo admin; Fase 2 del diseño). Es el mismo
`CrearProductoComponent` con `data.mode = 'edit'`: `ProductDraftStore.mode` decide adónde se
autoguarda y qué se muestra (sin "Mis borradores", sin Alerta de stock, sin Publicar; en su lugar
el panel `zc-edit-review` "Cambios a aplicar").
- **No se duplican publicaciones.** Al abrir, `publicationImport.js` lee EN VIVO los ítems de ML
  (`getItemOrStatus` + `getItemDescription` + nombre de la categoría) y los productos de TN
  (`getProduct`) del grupo, y los convierte en un `ProductDraft`: `mappingMode` por canal sale de la
  forma real (1 ítem con `variations[]` → `single_with_variants`; N ítems/productos →
  `one_per_variant`), los ejes de `attribute_combinations` (legacy), de los atributos que cambian
  entre ítems de una ficha (User Products) o de `attributes` de TN, y las variantes se unen por SKU.
  Si un canal no contesta (429/5xx), no se arma la edición (502): nunca se edita con datos a medias.
- **Lo que se guarda** es la edición a medio terminar (`publication_edits`: `draft_json`,
  `baseline_json` = cómo estaba al importarla, `refs_json` = ids externos + `last_updated`/`updated_at`
  + `locks` + `notes`). Una sola abierta por producto (índice único parcial; abrir de nuevo la
  retoma). `done`/`discarded` se purgan a los 30 días. La lista de Publicaciones marca "Edición sin
  guardar". Al retomar una, `remote-check` avisa si alguien cambió la publicación en ML/TN mientras.
- **Fotos ya publicadas**: `DraftImage.remote = { channel, id, url }`, id `ml-<picture_id>` /
  `tn-<image_id>`, preview = URL del canal. `persistable()` del store las guarda con `remote` (antes
  el autoguardado descartaba todo menos `{id,name}`). Las nuevas se suben como en Crear producto.
- **Qué cambió** (`publicationDiff.js`, `POST /:id/plan` con el borrador en pantalla, debounce de
  600 ms en el store): una operación por cosa a cambiar en una publicación concreta, con `key`
  estable (será el `unit_key` del job). Lo que no se tocó no genera nada, así guardar no pisa cambios
  hechos desde el panel de ML/TN en otros campos. Compara valores EFECTIVOS (mismas reglas que el
  front: `effective`, `variantTitle`). Un atributo que la categoría suma vacío al refrescarla, o un
  `value_id` que se cae, no cuenta como cambio (se compara el texto).
- **Bloqueos** (`locks`, candado en el form): cómo está armado cada canal (siempre — cambiarlo es
  volver a publicar), categoría (siempre), título y condición con ventas, y título en una ficha de
  User Products (lo arma ML). Agregar/quitar variantes sí se puede (la usuaria confirmó que ML lo
  permite); quitar una variación con ventas avisa en la operación.
- **Guardar** (`POST /:id/apply`, Fase 3): encola un job `kind: 'update'` en el publish worker
  (`publicationUpdate.js`), una unidad por operación (reintentar saltea las ok; un error no frena
  las demás). Stock/precio/SKU van por los caminos de siempre (Cola ML, `tnManualWrites.js`) para
  conservar el historial. Ítems legacy: todo PUT con `variations` lleva TODOS los ids
  (`mlVariationsBody`). Si la publicación cambió afuera, 409 `remote_changed` y la UI pide "Guardar
  igual". Al terminar sin errores la edición queda `done`; con errores sigue `saving` (Reintentar o
  `POST /:id/close`). **Sin probar todavía contra ML/TN reales**: solo con tests.

**Historial de publicación** (lo que era toda la página): `product_publish_jobs` +
`product_publish_units` (incl. `external_id` = id de ML/TN por unidad).
**Borrar un borrador ya no borra su historial.** Hasta 2026-10-12 `draft_id` era `ON DELETE CASCADE`
y la página quedó vacía al limpiar borradores. Ahora es `ON DELETE SET NULL` (migración
`2026-10-12_publish_jobs_keep_on_draft_delete`) y el job guarda `product_name`/`product_sku`
(copiados del borrador en `createPublishJob`; `listPublishJobs` usa `COALESCE`). Con un job
`pending`/`processing`, `DELETE /drafts/:id` responde 409: el job necesita las imágenes del borrador
para terminar. En `createPublishJob` el draftId va repetido como `$5` a propósito (mismo bug de
tipos que `finishPublishJob`; lo cubre `publishJobsRealDb.test.js`).

`db.listPublishJobs(limit, offset, {search, status, channel})` (molde de `getAuditLog`:
`where[]`/`params[]` + `COUNT(*)` + `{ rows, total }`) hace JOIN a `product_drafts` para nombre/SKU
y subqueries de conteo de unidades (sin `payload_json`); `channels` es CSV, se filtra con `LIKE`.
Ruta `GET /api/products/publish-jobs`. Front: `pages/publicaciones/publicaciones.component.*`
(standalone + `injectQuery`) reusa `zc-search-bar`/`zc-pagination`. Cada fila es un job; al
expandirla (`getPublishJob`) muestra las unidades con su id externo (link a ML; TN sin URL pública
deducible, solo el id) y `detail`. Reintentar/cancelar/borrar reusan `/jobs/:id/*`.

### Egress de Supabase: el polling de las colas era el piso de consumo

Incidente 2026-09-27: la organización de Supabase pasó el cupo de egress del plan Free (6,46 GB de
5 GB; grace period hasta 2026-10-23, después las requests pueden volver 402). El egress cuenta TODO
lo que sale de Supabase — base (pooler), Storage, API — no el espacio ocupado (ese es 1 GB aparte,
`STORAGE_LIMIT_BYTES`). El gráfico por día mostró un piso fijo de ~110 MB/día de "Shared Pooler"
todos los días, más picos de Storage solo en la semana de pruebas de publicación con fotos.

El piso eran los dos workers (`mlTaskQueue.js` y `publishWorker.js`) preguntando a la base cada
500 ms aunque no hubiera nada (~350k consultas/día por backend prendido). `lib/queuePolling.js`
mantiene el `setInterval` de 500 ms (así no cambia cuántas tareas corren en paralelo) pero con la
cola vacía saltea ticks: 1 s → 2 s → 4 s → tope `QUEUE_IDLE_MAX_MS` (5 s). `tick()` de cada worker
devuelve si encontró trabajo. Encolar o reintentar desde el mismo proceso (`enqueueMlTask`,
`retryMlTask`, `createPublishJob`, `retryPublishJob` en `db.js`) llama a `wakeQueue()` y vuelve al
ritmo rápido al instante — los webhooks los recibe el mismo backend, así que en la práctica la
demora de hasta 5 s solo aplica a reintentos programados (`next_run_at`) o a otro proceso. El
barrido de jobs trabados del publish worker va cada 20 ticks reales: 10 s con actividad, ~100 s
con la cola quieta.

Ojo al levantar backends locales contra la base de Supabase: cada uno suma su propio polling al
mismo cupo (es por organización, no por proyecto).

### Roles de usuario: `admin` y `lectura`

`app_users.role` (`'admin' | 'lectura'`). La migración agrega la columna con default `admin`, así
que los usuarios que ya existían quedaron admin; las altas nuevas desde el panel son `lectura` salvo
que se elija otra cosa.

- **La guarda vive en `requireAuth`** (`middleware/requireAuth.js`), no en cada router: un usuario
  de lectura no puede mandar nada que no sea `GET/HEAD/OPTIONS` (403 `code: 'read_only'`), salvo
  `READ_ONLY_ALLOWED_WRITES` — su propia sesión (logout, cambiar contraseña), los "Actualizar" que
  refrescan datos de ML/TN (`/sales/sync`, `/sync/returns/fetch`, `/products/publish-jobs/reconcile`)
  y los tildes de Para preparar (`prepared`, `cancel-seen`). Una ruta de escritura nueva queda
  bloqueada para lectura sin hacer nada; una nueva excepción hay que sumarla a esa lista.
- **`requireAdmin`** para lo que es solo admin aunque sea GET: `/api/users` entero y las URLs de
  OAuth de ML/TN (`/auth/*/url`).
- El rol se lee de la base con la misma caché de 60 s que `activo`/`token_version`, no del JWT:
  cambiar el rol aplica al toque (`invalidateAuthUserCache`), sin re-login.
- Panel de usuarios: nadie se cambia el rol a sí misma y nunca puede quedar el hub sin un **admin
  activo** (`countActiveAdmins`, reemplaza al viejo chequeo de "al menos un usuario activo").
- **Front:** `SessionService.isAdmin()/isReadOnly()`. La directiva `*zcCanWrite`
  (`shared/directives/can-write.directive.ts`) es el patrón para esconder botones de escritura;
  `adminGuard` saca a lectura de Crear producto, Actualizar precios y Usuarios (y el menú no las
  muestra). Inputs editables inline (precios en Productos, editor de pedidos) pasan a solo lectura.
  `SessionService` resuelve `HttpClient` de forma perezosa a propósito: la directiva lo inyecta en
  casi todas las pantallas y así sus specs no necesitan proveer `HttpClient`.

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
además en `backend/test/conflictsService.test.js` (diff + eco + 429/5xx que no tocan el snapshot),
y el fix de leer el valor previo ANTES de escribir (`readMlSnapshotRow`/`readTnSnapshotRow`, sin
esperar un crawl en curso). El caso puntual del incidente 2026-09-05 (la foto ya movida cuando se
arma el audit del cambio manual, y el eco anotado/olvidado alrededor del PUT) está cubierto en
`backend/test/mlTaskQueue.test.js` (stock y precio de ML), `backend/test/routesConflicts.test.js`
(stock de TN) y `backend/test/pricingService.test.js` (precio TN masivo); el frontend lo cubre
`product-history-dialog.component.spec.ts` ("sin cambio" en un evento manual de una sola cara y el
chip del header con el stock real por input). La sugerencia de "Para reponer" (por SKU sin pack,
por pack completo tomando el mayor faltante,
ajustes manuales por SKU/pack y su borrado, stock de Depósito Marañón por SKU, descartar una fila
y que vuelva sola tras un nuevo disparo, limpieza al cerrar el período) en
`backend/test/alertsService.test.js`. El dashboard de ventas por provincia está cubierto en
`backend/test/ordersService.test.js` (Pedidos: código/descr./precio por pack y suelto, sugerido,
último pedido / en camino, totales con descuentos encadenados, refresco de precios, duplicar todo /
faltantes, validación) y `backend/test/routesOrders.test.js` (ciclo borrador → pendiente → recibido
incompleto, 409 fuera de estado, repetir como pendiente, descuentos por defecto) + el SQL real en
`backend/test/publishJobsRealDb.test.js` (mismo archivo a propósito: dos archivos con `initDb()` en
paralelo chocan creando tablas); en el front
`orders.service.spec.ts`, `factory-sheet.spec.ts`, `pedido-editor.component.spec.ts` y
`pedidos-list.component.spec.ts`. Proveedor del pedido: `ordersService.test.js` (`codesForSupplier`,
`unitSuppliers`, catálogo filtrado con lo sin proveedor y el SKU propio del pack de otro vigente),
`routesOrders.test.js` (descuentos de la config default, 400 con proveedor inexistente, filtro de la
lista, duplicar conserva el proveedor, catálogo por proveedor con su código), el SQL real en
`publishJobsRealDb.test.js`; en el front el catálogo por proveedor, "Sin proveedor" y "precio de X"
en `pedido-editor.component.spec.ts` y el modal/filtro en `pedidos-list.component.spec.ts`.
`backend/test/salesService.test.js` (clasificación, armado de la fila, período anterior,
agregación por provincia con comparativa y excluidas, y que un pack de varios productos cuente
como 1 venta y no una por línea de orden), `backend/test/routesSales.test.js`
(validación de fechas, forma del CSV, que `POST /sync` no bloquee), y la extensión de
`getOrdersWindow` en `backend/test/mercadolibre.test.js` (paginación y split por más de 1000
órdenes); `backend/test/routesWebhooks.test.js` suma que la venta se registra y que un fallo ahí
no rompe el descuento de stock.

El modelo User Products de ML, la publicación en background y las fotos por Supabase están
cubiertos en `backend/test/productPublish.test.js` (family_name vs. title, misma familia en
`single_with_variants`, familia propia por variante en `one_per_variant`, `axisAttributes` con y
sin `mlAttributeId`, matcheo de `value_id` ignorando acentos/mayúsculas, `attributes`/`mpn`/
`age_group`/`gender` de TN, la descripción como objeto por idioma, y `withUnitsPerPack`:
`SALE_FORMAT` sin `UNITS_PER_PACK` → agrega `=1`, respeta un entero válido que ya vino, **normaliza**
uno inválido (vacío / `value_id` espurio) a `1`, no lo inventa sin `SALE_FORMAT`, aplica a cada ítem
de una familia `one_per_variant`), `backend/test/richText.test.js`
(texto plano → HTML, HTML existente intacto), `backend/test/mlUserProducts.test.js` (detección del
tag + caché), `backend/test/productPublishTnEmbed.test.js` (imágenes embebidas por URL, portada =
orden de la variante y no de la galería, ahora subidas de a una y NO embebidas en el POST),
`backend/test/publishTnUnit.test.js` (el POST de creación va sin `images`; idempotencia: adopta un
producto que ya existe por SKU y **le completa las fotos que falten** / 5xx-pero-creado lo adopta y
completa / 5xx real propaga / camino feliz sube las N),
`backend/test/tiendanube.test.js` (`fetchTn` aborta por timeout con `.timeout=true` / reintenta 5xx),
`backend/test/imageStore.test.js` +
`imageStoreSupabase.test.js` (backend de disco vs. Supabase, purgado respetando lo referenciado,
`getStorageUsage` sumando carpetas del bucket recursivamente, con paginación por `offset` y con
caché de 60 s),
`backend/test/publishWorker.test.js` (skip de unidades ya `ok` en un reintento, error parcial que
no frena el otro canal, latido sin dejar intervals colgados, que `seedPublishUnits` siembre TODAS
las unidades planificadas como `pending` antes de publicar / no siembre nada si falla el
planificado, y que un job `cancelled` corte el fan-out entre unidad y unidad / desde el arranque),
`backend/test/db.test.js` (lock vencido de `product_publish_jobs` con umbral propio,
`recomputeDraftStatus` con reintento de un solo canal, `cancelPublishJob` sobre
`pending`/`processing`/`error`, `finishPublishJob` que no revive un cancelado y que devuelve `false`
con `rowCount 0`, `isPublishJobCancelled`, `reconcileStalePublishJobs` cierra un job trabado con
unidades terminales y marca `error` los zombis, `listPublishJobs` pagina y filtra con `LIKE` de
canal / ignora status y canal inválidos) y `backend/test/routesProductsDrafts.test.js` (CRUD de
borradores + jobs por HTTP, `POST /jobs/:id/cancel` 200/409, `GET /publish-jobs` con paginación y
filtros, borrar un borrador limpia sus imágenes). El frontend lo cubre
`crear-producto.component.spec.ts` (borradores en el backend en vez de `localStorage`, migración
única, polling de `publish()` con progreso parcial, selector de eje, el panel persistente:
reabrir un borrador reconstruye un job terminado sin republicar / retoma el polling de uno en
curso / no muestra nada sin jobs previos, `publishErrorSummary`, `cancelPublish()` que corta el
polling y pasa a `cancelled`, el poll que tras N fallos pasa a fase `unknown` y `retryPoll()` que lo
recupera, `publishBlockers`/`canPublish` (borrador completo sin bloqueadores /
lista de faltantes / atributo obligatorio de ML / SKU+precio por variante / botón deshabilitado),
`UNITS_PER_PACK`
condicional: sube a obligatorios + se precarga en 1 cuando `SALE_FORMAT` tiene valor, sigue
opcional si no, y los atributos `allowVariations`: entran a `ml.attributes` + son candidatos a eje,
se ven como opcionales si NO son eje y se esconden si lo son, y `refreshMlVariationAttrs` mergea
atributos nuevos de la categoría sin pisar valores) y `catalog.service.spec.ts` (los endpoints
nuevos, incl. `listPublishJobs` con y sin filtros y `cancelPublishJob`). `product-draft.model.spec.ts`
fija el default `gold_special`. `publicaciones.component.spec.ts` cubre el historial (carga y
pinta el historial, expandir una fila trae el detalle con el id externo, `externalUrl` arma el link
de ML y no el de TN, reset de página al cambiar un filtro, Reintentar refetchea).
Productos del hub: `backend/test/hubProductsService.test.js` (1 ML → 4 TN, ficha UP → 1 TN, misma
`family_name` en otro dominio no se mezcla, cada estado, id estable, snapshot viejo sin `format`,
búsqueda sin acentos y conteos, candidatos a vincular), `backend/test/routesHubProducts.test.js`
(lista/detalle/404, `refresh=1`, vincular solo el canal que cambia, 409 por SKU usado, 502 si el
canal falla), los campos nuevos de la foto en `conflictsService.test.js`, el 409 al borrar un
borrador que se está publicando en `routesProductsDrafts.test.js` y el historial que sobrevive al
borrado contra Postgres real en `publishJobsRealDb.test.js`; en el front
`hub-products.component.spec.ts`, `link-variant-dialog.component.spec.ts` y
`hub-products.service.spec.ts`.
Editar publicación: `backend/test/publicationImport.test.js` (clásica con variaciones ↔ TN uno por
color, ficha de User Products ↔ TN con variantes, ítems sueltos de ML ↔ TN con variantes, producto
simple, avisos, 404/502 sin edición a medias, `checkRemoteChanges`), `publicationDiff.test.js` (sin
cambios → nada; descripción, stock/precio por variante, agregar/quitar variantes, fotos,
características, medidas, títulos por variante, producto simple, canal no publicado),
`routesPublicationEdits.test.js` (abrir/retomar, autoguardar, descartar, plan, remote-check) y
`publishJobsRealDb.test.js` (una sola edición abierta por producto contra Postgres real); en el front
`crear-producto.edit.spec.ts` (abre la edición de la ruta, candados, fotos remotas en el
autoguardado, panel de cambios, aviso al retomar, descartar, error de importación).
`backend/test/routesProducts.test.js` cubre que la ruta de atributos exponga `conditionalRequired`.
Actualizar precios con varias listas: `backend/test/pricingService.test.js` (índice vacío tras un
deploy que se puebla desde la foto en import/preview/aplicar, caché de 60 s de la foto, mapeo de
otra lista que no cuenta como de esta, resumen de `confirmImport`, mapear a mano toma el costo de la
lista más reciente / sin lista guarda sin tocar costos / pack respeta mapeos individuales, estado de
mapeo por producto, `buildSkuNames`, `buildSkuPrices`, pendiente/en cola en `getPreview`, invalidar la foto al aplicar) + `getLatestPriceListItems` contra Postgres real en
`publishJobsRealDb.test.js`; en el front `precios.component.spec.ts` (packs plegados, rango de
precios, selección por pack, resumen del import, Solo pendientes / en cola ML) y `mapeo-proveedor.component.spec.ts`.
Códigos con letras y mapeo automático: `supplierListParser.test.js` (las 3 listas de julio 2026 —
Be Positive 46 filas `BP…` sin heredar, Escolar con `V`/`R`/`LV` y encabezados pegados, Punto Cero
igual que antes—, fila con código no reconocido marcada), `skuMatcher.test.js` (`base`/`group`
automáticos, prefijos, dos packs con el mismo SKU), `pricingService.test.js` (`autoMapFromLists`:
pack `39000` → se mapea y pasa el costo a sus modelos, `CODIGO-variante` suelto, no pisa manual,
ignora códigos sin lista, modelos de un pack que no matcheó, lo sacado a mano no vuelve, throttle de
`getPreview`), `deletePriceList` + la marca de "sacado" en `publishJobsRealDb.test.js`; en el front
`mapeo-proveedor.component.spec.ts` (pack con sus modelos, código propio de un modelo, aviso del
mapeo automático) y `precios.component.spec.ts` (borrar una lista).
Proveedores y descuentos: `discountResolver.test.js` (SKU > pack > default, una fila sin config no
tapa la del pack, solo cuenta el proveedor vigente, a qué proveedores pertenece un SKU),
`pricingService.test.js` (descuento y precio del bulto en el preview, editar una config mueve el costo
y marca pendiente, asignar a un pack limpia sus modelos, el import aplica la config solo a lo sin config
propia, la lista de otro proveedor no pisa al vigente, cambiar el vigente toma su lista, ABM con 409) y
el SQL real en `publishJobsRealDb.test.js` (configs, `onlyIfMissing`, default que se desasigna, código por
proveedor, borrado en cascada); en el front `precios.component.spec.ts` (pestañas, columnas, asignación,
import con proveedor/config) y `mapeo-proveedor.component.spec.ts` ("Todos" de solo lectura).

"Para despachar" está cubierto en `backend/test/dispatchService.test.js` (pendiente vs. despachado y
Full, carrito = un paquete con un solo GET de envío, buckets atrasado/hoy/próximos con `now`
inyectado y hora argentina, `buffered` en su día, `stateLabel`, fotos por variación, cancelados
recientes sí / pago rechazado no / "Entendido" los oculta, un preparado no cambia de lugar, TN sin duplicar entre
filtros, un canal caído no tumba al otro, caché de 60 s y memo de envíos despachados),
`backend/test/routesDispatch.test.js`, `getShipmentSla` en `mercadolibre.test.js` y `listOrders` en
`tiendanube.test.js`; en el front `despachos.component.spec.ts` (secciones de Hoy / Próximos días,
filtro por canal, cancelados, tilde optimista, lightbox, aviso de canal caído).

Correr con `npm test` en `backend/` (necesita Node ≥ 24: con Node 20/22 el mockeo de módulos de `node:test` rompe los imports de `pg` y `node-fetch`).
