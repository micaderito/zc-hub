# Publicaciones: mapeo ML ↔ TN y edición completa desde el hub

Prototipo: [`docs/prototype/publicaciones-mapeo.html`](../prototype/publicaciones-mapeo.html)
(publicado en https://claude.ai/artifact/DZvs7h8rb4ZeHibqdrZ2h9).

## Por qué

- `/publicaciones` quedó vacía: lista `product_publish_jobs`, que se borra en cascada con el
  borrador (`draft_id … ON DELETE CASCADE`, `db.js`). Además nunca mostró lo que ya estaba
  publicado en ML/TN antes del hub.
- La usuaria quiere ver cada producto con sus publicaciones de los dos canales (que no son 1:1:
  1 publi de ML con 4 colores ↔ 4 productos de TN, o 3 ítems de ML de una ficha ↔ 1 producto TN)
  y **editar todo** desde ahí — fotos, variantes, descripción, características, precio, stock —
  con el mismo formulario que Crear producto.
- Pidió explícitamente poder **dejar una edición a medio terminar** y retomarla.

## Decisiones

1. **No se duplican publicaciones.** La lista sale de la foto del catálogo que ya existe
   (`getAnalysis()` / snapshot de `conflictsService.js`, actualizada por webhooks `items` /
   `product/*`, reconcile cada 6 h y botón Actualizar). El editor lee **en vivo** de ML/TN al
   abrirse.
2. **El mapeo no se guarda: se calcula.** Grafo `ítem ML ↔ producto TN` con una arista por SKU
   compartido + aristas entre ítems ML de la misma familia (User Products). Cada componente
   conexa es un "producto del hub". Vincular = igualar SKU en las plataformas (ya existe:
   `POST /api/mapping` → `persistSkuToChannels`). Sin tabla de mapeo.
3. **La edición en curso sí se guarda** (`publication_edits`): el borrador de la edición +
   la foto de cómo estaba cada publicación al abrirla (*baseline*). Se borra al terminar de
   guardar o al descartar.
4. **Se manda solo lo que cambió.** El backend compara borrador vs. baseline y arma una lista de
   operaciones por publicación; esa misma lista es la que ve la usuaria en "Cambios a aplicar" y
   la que ejecuta el worker. Un campo que no tocó nunca se manda (así no pisa cambios hechos
   desde el panel de ML/TN en otros campos).
5. **Reusar el formulario de Crear producto** (`ProductDraftStore` + `crear-producto.component`)
   en modo `edit`. El modelo `ProductDraft` ya tiene lo necesario: `mappingMode` por canal,
   `OverrideField` para título/descripción, imágenes por canal, `titles` por variante.
6. **Aplicar en background** con la infraestructura de jobs de publicación
   (`product_publish_jobs`/`_units`, `publishWorker.js`): mismo progreso "X de Y", cancelar,
   reintentar sin duplicar.

## Qué permite la API (doc oficial de ML, revisada 2026-10-12)

Fuentes: "Sincroniza y modifica" (24/03/2026), "Variaciones", "User Products", "Precio por
variación" (13/08/2026), "Tipos de publicación", "Cuotas", "Imágenes", "Descripción",
"Atributos" — todas en `developers.mercadolibre.com.ar/es_ar/…`.

| Campo | Ítem legacy (`variations[]`) | User Products (1 ítem por variante) | Bloqueo |
|---|---|---|---|
| Título | `PUT /items/{id}` `{title}` | **no editable** (lo arma ML); se cambia `family_name` vía `PUT /user-products-families/{family_id}` | con ventas, no (legacy); `family_name` solo sin ventas |
| Descripción | `PUT /items/{id}/description?api_version=2` `{plain_text}` (ya existe `setItemDescription`) | ídem por ítem | nunca |
| Fotos | `PUT /items/{id}` `{pictures:[{id}|{source}]}` (el orden = orden de muestra); por variación además `picture_ids` | `PUT /items/{id}` (ML sincroniza entre ítems del mismo UP) | nunca |
| Atributos | `PUT /items/{id}` mandando **todos** | ídem; BRAND/MODEL (PARENT_PK) van por la familia | `read_only` / `inferred`; atributos de variación con ventas solo se pueden sumar |
| Agregar variante | `POST /items/{id}/variations` | `POST /items` con el mismo `family_name` (ya lo hace `buildMlItems`) o `POST /user-products-families/{family_id}/user-products` | — |
| Quitar variante | `DELETE /items/{id}/variations/{var_id}` | `PUT /items/{id}` `{status:'closed'}` | con ventas: **no documentado** → probar |
| Tipo de publicación | `POST /items/{id}/listing_type` `{id}`; `available_upgrades/downgrades` | por ítem | gold_special ↔ gold_pro cuando se quiera, sin cargo |
| Cuotas | `PUT /items/{id}` `{tags:[…existentes, '3x_campaign']}` | por ítem | 1 campaña por ítem |
| Envío gratis | `PUT /items/{id}` `{shipping:{free_shipping}}` (body inferido) | ídem | obligatorio con tag `mandatory_free_shipping` |
| Categoría | `category_id` modificable según doc 2023 | `domain_id` vía familia | con ventas: **no documentado** → mostrar bloqueado |
| Condición | — | PARENT_PK vía familia | con ventas, no |

**Reglas que hay que respetar sí o sí:**

- **Legacy: todo `PUT /items/{id}` con `variations` tiene que llevar el `id` de TODAS las
  variaciones que se quedan.** Una variación sin `id` se borra y se recrea, y pierde el
  historial de ventas. `updateItemOrVariationStock` ya lo hace bien; cualquier función nueva
  tiene que pasar por un helper único (`mlVariationsBody(item, overrides)`) con test.
- **Precio:** desde 18/03/2026 un `PUT /items` con **solo** `price` da 400 en ítems con
  automatización de precios. Verificar `updateItemPrice` (manda `{price}` solo en ítems sin
  variaciones) antes de reusarlo.
- **Concurrencia:** ML no tiene ETag para `/items`. Se guarda `last_updated` (ML) /
  `updated_at` (TN) en el baseline y se relee justo antes de escribir cada publicación.
- **Familias UP:** `GET /items/{id}` trae `user_product_id` y `family_name`, no `family_id`.
  `family_id` sale de `GET /user-products/{up_id}`. Para agrupar en la lista alcanza
  `family_name` + `domain_id` + `seller` (gratis, ya viene en el ítem); el `family_id` se pide
  recién en el editor, que lo necesita para escribir.

TN no tiene restricciones relevantes: `PUT /products/{id}`, `POST/PUT/DELETE
/products/{id}/variants[/{vid}]`, `POST/PUT/DELETE /products/{id}/images[/{iid}]`.

## Fases

Cada fase se puede mergear y usar por separado.

### Fase 1 — Lista de productos del hub (solo lectura + vincular)

**Backend**
- Migración: `product_publish_jobs.draft_id` pasa a nullable con `ON DELETE SET NULL`
  (`ALTER TABLE … DROP CONSTRAINT product_publish_jobs_draft_id_fkey, ADD … ON DELETE SET
  NULL`, con `runOnce` como las otras migraciones de `initDb`). Borrar un borrador ya no borra
  el historial; `routes/products.js` deja de borrar imágenes referenciadas por jobs vivos.
  `listPublishJobs` ya hace `LEFT JOIN`: mostrar "borrador eliminado".
- Snapshot: `flattenMlItems` suma a cada fila `format` (`legacy` si el ítem tiene
  `variations[]`, `up` si tiene `user_product_id` sin variaciones), `familyName`, `soldQuantity`,
  `permalink`, `status`. `flattenTnVariants` suma `handle`/URL. Verificar que el crawl
  (`getItem` con `include_attributes=all`) ya los trae — no deberían sumar requests.
- `services/hubProductsService.js`:
  - `buildHubProducts(analysis)` — union-find sobre nodos `ml:<itemId>` / `tn:<productId>`;
    aristas por SKU presente en los dos canales y por familia UP (`familyName` + dominio).
    Id estable del grupo = menor id de nodo ordenado (ej. `ml:MLA123…`), así sirve de URL.
  - Estado por grupo: `linked` · `desync` (stock distinto) · `orphan` (variante con SKU en un
    solo canal o sin SKU) · `only_ml` · `only_tn`. Totales de stock por canal.
  - Puro (sin I/O) → fácil de testear.
- `routes/hubProducts.js`: `GET /api/hub-products?search&status&page` y
  `GET /api/hub-products/:key` (publicaciones + filas por SKU, todo desde el snapshot).

**Frontend**
- `pages/publicaciones/`: pestañas **Productos** | **Historial de publicación** (el componente
  actual pasa a ser la pestaña de historial, sin cambios).
- Lista (búsqueda + chips de estado, `zc-search-bar`, `zc-pagination`) y detalle: tarjetas de
  publicaciones por canal + tabla de variantes por SKU (como el prototipo).
- **Vincular**: picker con las variantes sin par del otro canal (reusa
  `GET /api/mapping/sources/*` filtrando por `analysis.onlyML/onlyTN`) → `POST /api/mapping`.
- Botón **Editar publicación** (solo admin, `*zcCanWrite`) — en esta fase lleva al editor de la
  Fase 2 o queda oculto hasta entonces.

### Fase 2 — Editor: lectura en vivo + edición guardada

**Tabla nueva** (`initDb`):
```sql
CREATE TABLE IF NOT EXISTS publication_edits (
  id VARCHAR(64) PRIMARY KEY,
  group_key VARCHAR(128) NOT NULL,       -- id del producto del hub
  draft_json TEXT NOT NULL,              -- ProductDraft que se está editando
  baseline_json TEXT NOT NULL,           -- cómo estaba cada publicación al abrir (normalizado)
  refs_json TEXT NOT NULL,               -- ids externos: ítems/variaciones ML, productos/variantes TN, fotos
  status VARCHAR(16) NOT NULL DEFAULT 'editing',  -- editing | saving | done | discarded
  job_id VARCHAR(64),                    -- job que la está aplicando
  created_by VARCHAR(128), created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_publication_edits_active
  ON publication_edits (group_key) WHERE status IN ('editing','saving');
```
Una sola edición abierta por producto. `done`/`discarded` se purgan a los 30 días (mismo lugar
que `dispatch_marks`).

**Backend**
- `services/publicationImport.js` — `importHubProduct(groupKey)`:
  - ML: `GET /items/{id}?include_attributes=all` por ítem del grupo + `getItemDescription`;
    para UP, `GET /user-products/{up_id}` → `family_id`.
  - TN: `tn.getProduct` por producto (trae variantes, imágenes, categorías, descripción).
  - Arma el `ProductDraft`: `common` (nombre = TN o título ML, marca = atributo `BRAND`,
    medidas desde `SELLER_PACKAGE_*` / dimensiones TN deshaciendo la rotación de `tnDims`),
    `axes` desde `attribute_combinations` (ML) / `attributes` (TN), variantes unidas por SKU,
    `ml.mappingMode` / `tn.mappingMode` deducidos (1 ítem con variaciones → `single_with_variants`;
    N ítems/productos → `one_per_variant`), descripción con override si difiere entre canales,
    `ml.images` / `tn.images` como `DraftImage` con `remote` (ver abajo).
  - Devuelve `{ draft, baseline, refs, locks }`. `locks` = campos bloqueados con motivo
    (título/`family_name` con ventas, categoría con ventas, condición, atributos `read_only`).
- `DraftImage.remote?: { ml?: { pictureId }, tn?: { imageId } }` + `previewUrl` = URL remota. Las
  fotos que ya están en el canal se referencian por id (no se re-suben); las nuevas siguen el
  camino de siempre (Supabase → `{source}` en ML, `createProductImage` en TN).
- Rutas `routes/publicationEdits.js`:
  - `POST /api/publication-edits` `{ groupKey }` → si hay una abierta la devuelve; si no,
    importa y crea.
  - `GET /:id`, `PUT /:id` (autoguardado del borrador), `DELETE /:id` (descartar).
  - `POST /:id/plan` → lista de operaciones (para el panel "Cambios a aplicar").
  - `GET /:id/remote-check` → compara `last_updated`/`updated_at` actuales contra el baseline
    (al reabrir una edición vieja: "cambió en ML desde que empezaste a editar").
- `services/publicationDiff.js` — `planPublicationUpdate(baseline, draft, refs)` → `[{ key,
  channel, target, kind, label, warn, payload }]`. `key` estable (ej. `ml:MLA1:description`,
  `tn:218843003:delete`) = `unit_key` del job. Puro, con tests por cada kind:
  `ml.title`, `ml.description`, `ml.pictures`, `ml.attributes`, `ml.listing_type`,
  `ml.add_variation`, `ml.delete_variation`, `ml.close_item`, `ml.create_item` (UP),
  `ml.family_name`, `tn.product` (nombre/descr./categorías/marca/medidas), `tn.images`,
  `tn.add_variant`, `tn.delete_variant`, `tn.create_product`, `tn.delete_product`,
  `stock`, `price_ml`, `price_tn`, `sku`.

**Frontend**
- Ruta `/publicaciones/:key/editar` (`adminGuard`) que monta `CrearProductoComponent` con
  `mode: 'edit'` (route data). `ProductDraftStore`:
  - `mode` signal; en `edit`, `saveDraft()` pega a `PUT /publication-edits/:id` (mismo
    autoguardado que hoy) y `publish()` se reemplaza por `applyEdit()`.
  - `locks` → los campos bloqueados se muestran con candado y motivo (patrón "caja punteada" de
    "No aplica").
  - Secciones que no aplican en edición: Costo/ganancia queda; Alerta de stock se oculta.
- Panel lateral **Cambios a aplicar** (`POST /plan` con debounce de 500 ms tras cada cambio).
- En la lista de Fase 1: chip **Edición sin guardar** en el producto + "Seguir editando" /
  "Descartar".

### Fase 3 — Aplicar cambios

- `product_publish_jobs`: columnas `kind` (`create` | `update`, default `create`) y `edit_id`
  (nullable, `draft_id` ya es nullable desde Fase 1). `payload_json` = la lista de operaciones.
- `publishWorker.processJob` bifurca por `kind`; `update` → `runEditJob`: siembra una unidad por
  operación (`seedPublishUnits`), las ejecuta en orden por publicación y saltea las `ok`
  (idempotencia del reintento, igual que hoy).
  - Antes de la primera operación sobre cada publicación: releer y comparar con el baseline. Si
    cambió **un campo que vamos a escribir**, esa unidad falla con "Cambió en ML desde que lo
    abriste: revisalo" (no se pisa). Si cambió otro campo, se sigue.
  - Las operaciones son valores absolutos (título, descripción, fotos, stock final) → reintentar
    da lo mismo. Las creaciones (`add_variation`, `create_product`, `create_item`) buscan por SKU
    antes de crear, como `publishTnUnit`.
- **Stock y precio pasan por los caminos que ya existen**, no por PUT directos: `enqueueMlTask`
  `stock_ml_set` / `price_ml`, stock TN de `routes/conflicts.js`, precio TN de
  `pricingService`. Así se conserva el historial de los dos canales, el eco
  (`rememberStockWrite`) y la lectura del valor previo antes de escribir.
- Clientes nuevos:
  - `lib/mercadolibre.js`: `updateItem(token, id, body)`, `mlVariationsBody(item, overrides)`
    (siempre con todos los ids), `addItemVariation`, `deleteItemVariation`, `setItemListingType`,
    `closeItem`, `updateFamily(familyId, body)`, `getUserProduct(upId)`.
  - `lib/tiendanube.js`: `updateProduct`, `createVariant`, `deleteVariant`, `deleteProduct`,
    `deleteProductImage` (crear/ordenar fotos ya existe: `syncTnProductImages`).
- Al terminar: `refreshMlItemInSnapshot` / `refreshTnProductInSnapshot` de cada publicación
  tocada (la lista se ve actualizada sin esperar el webhook) y la edición pasa a `done`.
- Front: mismo panel de progreso de Crear producto (`publishProgress`, `publishPhase`,
  cancelar, reintentar, fase `unknown`).

### Fase 4 — Pendientes y pulido

- Probar en la cuenta real (con `POST /items/validate` o un ítem de prueba) lo que la doc no
  dice: eliminar una variación legacy con ventas, cambiar categoría con ventas, atributos
  bloqueados con ventas, body exacto de `free_shipping`, restricción de ventas en
  `PUT /user-products-families`. Hasta confirmarlo, la UI ofrece la opción conservadora
  (variación con ventas → "dejar sin stock"; categoría con ventas → bloqueada).
- Cuotas y envío gratis en la sección de ML del editor.
- Agrupar a mano dos publicaciones sin SKU en común (tabla `hub_product_links`) — solo si
  aparece el caso.

## Tests

Backend (`npm test`, Node ≥ 24):
- `hubProductsService.test.js`: 1:1, 1 ML → N TN, N ML (familia) → 1 TN, variante sin SKU,
  solo ML / solo TN, estado `desync`, id de grupo estable.
- `publicationImport.test.js`: legacy con variaciones, familia UP, producto TN por variante,
  descripciones distintas → override, medidas rotadas, fotos remotas, `locks` con/sin ventas.
- `publicationDiff.test.js`: un caso por `kind`; campo sin tocar no genera operación; precio en
  legacy avisa "todas las variaciones".
- `mercadolibre.test.js`: `mlVariationsBody` nunca omite un id; `deleteItemVariation`,
  `setItemListingType`, `closeItem`.
- `publishWorker.test.js`: job `update` saltea unidades `ok`, frena si la publicación cambió en
  el campo a escribir, sigue si cambió otro; stock/precio encolan por la cola de ML.
- `db.test.js` / `publishJobsRealDb.test.js`: borrar borrador conserva el job; una sola edición
  abierta por grupo.
- `routesPublicationEdits.test.js`: crear/retomar/autoguardar/descartar, `plan`,
  `remote-check`, 403 para lectura.

Frontend: spec de la página (lista, filtros, detalle, vincular), del store en modo `edit`
(autoguardado a la ruta nueva, `locks`, panel de cambios) y `catalog.service.spec.ts` para los
endpoints nuevos.

## Verificación manual

Con `LOCAL_TEST_MODE=1` contra la cuenta real, sobre un producto de prueba: abrir el editor,
cambiar descripción + agregar una foto + agregar una variante + quitar otra, cerrar a la mitad,
volver ("Seguir editando"), guardar, y comprobar en el panel de ML y de TN que solo cambió eso y
que el historial de ventas de las variaciones existentes sigue intacto.
