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

**Idempotencia de la creación en TN.** TN a veces devuelve 5xx habiendo creado el producto igual;
el job se marcaba error y el reintento re-encolado volvía a llamar `createProduct` → "me creó 3
veces la misma variante". `publishTnUnit` ahora busca por SKU (`tn.findProductBySku`, `GET
/products?q=<sku>`) **antes** de crear —y **después** si `createProduct` tira— y adopta el producto
existente en vez de duplicar (sin re-subir imágenes). Si `q` no matchea el SKU en la tienda,
`findProductBySku` devuelve `null` y el flujo cae al de antes (sin verificar contra la API real).

**Default de tipo de publicación = "Clásica" (`gold_special`).** Antes era `gold_pro` ("Premium"),
que activa "cuotas sin interés" (las financia ML y el vendedor paga más comisión) — salía sin que
la usuaria lo pidiera. Se puede subir a Premium por producto en el form.

**`LOCAL_TEST_MODE=1`** (`backend/src/index.js`): para levantar el backend LOCAL contra el `.env` de
PROD y probar el flujo de publicación de punta a punta. Arranca **solo la API + el publish worker**;
NO el worker de `ml_pending_tasks` (haría cambios de stock reales), NI el auto-refresh del token de
ML (el refresh token es de un solo uso — si local lo rota, prod pierde la sesión), NI el barrido de
ventas ni el purgado de imágenes. Nunca ponerla en el deploy. Durante la prueba conviene pausar
Railway para que el job lo tome el worker local (`FOR UPDATE SKIP LOCKED` lo da a cualquiera de los dos).

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
orden de la variante y no de la galería), `backend/test/publishTnUnit.test.js` (idempotencia:
adopta un producto que ya existe por SKU / 5xx-pero-creado lo adopta / 5xx real propaga / camino
feliz), `backend/test/imageStore.test.js` +
`imageStoreSupabase.test.js` (backend de disco vs. Supabase, purgado respetando lo referenciado),
`backend/test/publishWorker.test.js` (skip de unidades ya `ok` en un reintento, error parcial que
no frena el otro canal, latido sin dejar intervals colgados, que `seedPublishUnits` siembre TODAS
las unidades planificadas como `pending` antes de publicar / no siembre nada si falla el
planificado, y que un job `cancelled` corte el fan-out entre unidad y unidad / desde el arranque),
`backend/test/db.test.js` (lock vencido de `product_publish_jobs` con umbral propio,
`recomputeDraftStatus` con reintento de un solo canal, `cancelPublishJob` sobre
`pending`/`processing`/`error`, `finishPublishJob` que no revive un cancelado, `isPublishJobCancelled`)
y `backend/test/routesProductsDrafts.test.js` (CRUD de borradores + jobs por HTTP, `POST
/jobs/:id/cancel` 200/409, borrar un borrador limpia sus imágenes). El frontend lo cubre
`crear-producto.component.spec.ts` (borradores en el backend en vez de `localStorage`, migración
única, polling de `publish()` con progreso parcial, selector de eje, el panel persistente:
reabrir un borrador reconstruye un job terminado sin republicar / retoma el polling de uno en
curso / no muestra nada sin jobs previos, `publishErrorSummary`, `cancelPublish()` que corta el
polling y pasa a `cancelled`, `publishBlockers`/`canPublish` (borrador completo sin bloqueadores /
lista de faltantes / atributo obligatorio de ML / SKU+precio por variante / botón deshabilitado),
`UNITS_PER_PACK`
condicional: sube a obligatorios + se precarga en 1 cuando `SALE_FORMAT` tiene valor, sigue
opcional si no, y los atributos `allowVariations`: entran a `ml.attributes` + son candidatos a eje,
se ven como opcionales si NO son eje y se esconden si lo son, y `refreshMlVariationAttrs` mergea
atributos nuevos de la categoría sin pisar valores) y `catalog.service.spec.ts` (los endpoints
nuevos). `product-draft.model.spec.ts` fija el default `gold_special`.
`backend/test/routesProducts.test.js` cubre que la ruta de atributos exponga `conditionalRequired`.

Correr con `npm test` en `backend/` (necesita Node ≥ 24: con Node 20/22 el mockeo de módulos de `node:test` rompe los imports de `pg` y `node-fetch`).
