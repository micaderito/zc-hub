# Plan — sección de Precios

Automatizar el cambio de precios: del costo del proveedor al precio publicado en Mercado Libre
y Tienda Nube, sin tocar producto por producto.

Estado: **propuesta, decisiones cerradas**. Prototipo: [`prototype/precios-prototipo.html`](prototype/precios-prototipo.html).

Fuentes analizadas: `Febrero 2026.xlsx` (con fórmulas) + `MI PUNTO CERO LISTA NOVIEMBRE 2025.pdf`.

---

## 1. Decisiones tomadas

| Tema | Decisión |
|---|---|
| **Despeje del envío** | Se implementa **el correcto**, no el del Excel. Lo que manda es netear la ganancia pedida. |
| **Comisión ML** | 15% por default. Editable. |
| **Redondeo** | **Hacia arriba al múltiplo de $50.** Editable (5/10/50/100). |
| **Descuentos** | **Se eligen al momento de actualizar precios**, no son fijos del proveedor. Se puede decir "sin descuento". |
| **Ganancia** | Configurable. Default 100%. Editable por lista y por producto. |
| **Valores fijos** (impuestos, comisión, tramos, envío, umbral) | Vienen **precargados con los valores del Excel** y se editan desde Ajustes. Nunca se piden al actualizar. |
| **PDF** | **Solo Punto Cero.** El resto se carga a mano (bulto o unidad) y usa los mismos cálculos. |
| **Mapeo** | Se adivina lo que se puede, el resto a mano. Se guarda en la base **una sola vez**. |
| **Tienda Nube** | Se publica **un solo precio**: el de lista. La tienda aplica sola el descuento por transferencia. Sin precio promocional. |
| **Diseño de UI** | **Opción A (Planilla viva).** La B se descarta como pantalla, pero su paso de confirmación de mapeo se conserva (§7). |
| **Aplicación masiva** | Por la **cola durable que ya existe** (`ml_pending_tasks`), no de una. Sobrevive 429 y reinicios (§9). |
| **Historial de precios** | En el **mismo modal** que el historial de stock que acabás de hacer, como una sección más (§10). |
| **Mayorista** | **Fuera de alcance** — otra sesión. |

---

## 2. La fórmula

Leí las fórmulas reales del `.xlsx`. **Reimplementé la fórmula del Excel y reproduce las 131
filas de las 9 pestañas al peso exacto.** Sobre esa base verificada aplico las correcciones que
decidiste.

```
─── costo ────────────────────────────────────────────────────────────
costo_bulto_neto = precio_bulto × (1 − desc1) × (1 − desc2)   descuentos de ESTA compra (§4)
costo_unitario   = costo_bulto_neto ÷ cant_x_bulto            ó costo unitario cargado directo
valor_final      = ROUND(costo_unitario × (1 + ganancia), 0)  ← lo que querés netear

─── Tienda Nube ──────────────────────────────────────────────────────
precio_transferencia = ceil50(valor_final)                    referencia
precio_lista         = ceil50(precio_transferencia × 1,3)     ← ESTE es el que se publica

─── Mercado Libre (global: igual para todos los proveedores) ─────────
fija = 1115  si el precio resultante ≤ 15.000
       2300  si ≤ 25.000
       2810  si ≤ 33.000
          0  si  > 33.000

precio_ML = ceil50( (valor_final + fija + 300 + envio) ÷ (1 − 0,15) )
            envio = 6.500 solo si el precio supera los 33.000, si no 0
```

### La corrección del envío (tu pregunta 1)

Tu Excel hacía `(VF + 300)/0,85 + 6.500` — sumaba el envío **después** de dividir. Pero ML cobra
el 15% sobre el precio final, y ese precio incluye los $6.500, así que ese 15% lo terminabas
pagando vos: **$1.147 por venta**. Ya se disparaba en 8 filas (Agendas, Chino, Pagoda ×2,
Mochilas ×4), donde neteabas ~$975 menos de lo pedido.

Ahora el envío entra **antes** de dividir: `(VF + fija + 300 + 6.500)/0,85`. Verificado: **las 49
filas de Punto Cero netean ≥ el valor final pedido.**

### El redondeo a 50 es seguro (no reintroduce circularidad)

El tramo depende del precio y el precio depende del tramo — es circular. Tu Excel lo resolvía
invirtiendo el límite (`VF ≤ Max − Max×0,15 − fija − 300`), que es el despeje correcto y **se
mantiene tal cual**.

El redondeo podría romperlo empujando un precio al tramo de arriba. **No pasa:** los límites
(15.000 / 25.000 / 33.000) son todos múltiplos de 50, así que si `base ≤ 15.000` entonces
`ceil50(base) ≤ 15.000`. Nunca cruza. Si algún día se cambia el paso de redondeo a uno que no
divida a los límites, esto hay que revisarlo — queda como test.

### Impacto en Punto Cero

Los precios suben entre **$1 y $46** respecto de tu Excel. El salto viene del redondeo a 50, no
del despeje: ninguna fila de Punto Cero llega hoy a los $33.000. Ejemplos:

| Código | Valor final | Excel | Nuevo | Neteás |
|---|---|---|---|---|
| BP700V | 6.840 | 9.712 | 9.750 | 6.872 ✓ |
| 30700 | 12.540 | 17.812 | 17.850 | 12.572 ✓ |
| FULL 39000 | 27.645 | 32.877 | 32.900 | 27.665 ✓ |
| 30750 | 1.425 | 3.342 | 3.350 | 1.432 ✓ |

### Dos detalles que si los "prolijamos" rompen los números

1. **`precio_lista` se calcula sobre la transferencia ya redondeada**, no sobre el valor final.
2. **`precio_ML` se calcula sobre el valor final**, ignorando la transferencia. El redondeo de TN
   no contamina la rama de ML.

---

## 3. La zona muerta arriba de $33.000

Cuando el precio pasa los $33.000 tenés que ofrecer envío gratis, y el precio salta de golpe
~$7.650. Eso deja un hueco: **ningún producto puede quedar entre $33.000 y ~$40.650**.

Lo interesante es que justo pasado el umbral **te conviene quedarte en $33.000**:

| Valor final | Saltar a | Neteás | Quedarte en | Neteás | Resignás | El comprador ahorra |
|---|---|---|---|---|---|---|
| 27.751 | 40.650 | 27.752 | 33.000 | 27.750 | **$1** | $7.650 |
| 28.000 | 40.950 | 28.008 | 33.000 | 27.750 | $250 | $7.950 |
| 28.500 | 41.550 | 28.518 | 33.000 | 27.750 | $750 | $8.550 |
| 29.000 | 42.150 | 29.028 | 33.000 | 27.750 | $1.250 | $9.150 |

En $33.000 el máximo que podés netear es **$27.750**. Arriba de eso, o saltás o resignás margen.

**Esto no lo decide el código.** La app calcula el salto (que es lo correcto según tu regla:
netear lo pedido) y **avisa** cuando estás en la zona donde quedarte en $33.000 cuesta poco.
Vos decidís por producto.

Importa ahora: a `FULL 39000` le faltan **$105** de valor final para entrar en esta zona. Con el
próximo aumento de Punto Cero, entra.

---

## 4. Los descuentos van en la actualización, no en el proveedor

> «a veces obtengo más o menos descuentos según cuándo compre»

Los descuentos son de **la compra**, no del proveedor. Entonces:

- Se piden **al importar la lista / al actualizar precios**, con los últimos usados precargados.
- Se puede poner **uno solo, los dos, o ninguno** (checkbox "sin descuentos").
- Quedan guardados **en la lista importada**, para que sepas con qué descuento calculaste cada vez.
- Para proveedores sin lista, el descuento es parte de la carga manual del costo (y normalmente
  va en cero: cargás el costo ya neto).

Los defaults de Punto Cero son 25% + 5%, pero es solo el valor precargado — se pisa en cada compra.

---

## 5. Qué se automatiza y qué no

| | Punto Cero | Los demás proveedores |
|---|---|---|
| Origen del costo | **PDF importado** | **A mano** (bulto o unidad) |
| Descuentos | se eligen al importar | se eligen al cargar (normalmente 0) |
| Mapeo por código | sí, con la escalera de §7 | no aplica — el SKU es el producto |
| Cálculo TN y ML | **igual** | **igual** |
| Aplicar masivo | **igual** | **igual** |

El motor de cálculo es **uno solo**. Lo único que cambia es de dónde sale el costo. Eso importa
para el orden de las fases: **la carga manual llega antes que el PDF** (§11), porque no depende
del parseo y ya te saca las cuentas de encima.

---

## 6. Modelo de datos

Postgres. `initDb()` en [`backend/src/db.js`](../backend/src/db.js) ya crea todo con
`CREATE TABLE IF NOT EXISTS`; seguimos ese patrón.

```
pricing_settings          UNA fila. Los valores fijos, precargados del Excel, editables en Ajustes.
  id, ml_commission_pct (15), ml_taxes (300),
  ml_shipping_cost (6500), ml_free_shipping_threshold (33000),
  card_multiplier (1.3), rounding_step (50), rounding_mode ('up'),
  default_profit_margin (100), default_discount_1 (25), default_discount_2 (5),
  updated_at

ml_fee_tiers              Los tramos de comisión fija. Precargados, editables.
  id, min_price, max_price, fixed_fee
  -- (0,15000]=1115  (15000,25000]=2300  (25000,33000]=2810  (33000,∞)=0

supplier_codes            TODOS los códigos del PDF. Catálogo estable, sobrevive a cada import.
  code PK, description, first_seen_at, last_seen_at, active
  -- un código puede no tener SKU: producto de PC que no vendés

price_lists               Una importación del PDF de Punto Cero.
  id, label ('Marzo 2026'), source_filename, imported_at,
  discount_1, discount_2          ← los descuentos DE ESA COMPRA
  
price_list_items          Los precios de esa lista, por código.
  id, list_id → price_lists, code → supplier_codes,
  unit_price, bulk_price, bulk_qty

sku_code_map              El puente SKU ↔ código. Se llena UNA vez.
  sku PK, code → supplier_codes,
  match_source ('exact'|'base'|'group'|'manual'), confirmed_at
  -- un SKU puede no tener código: producto de otra marca

product_costs             El costo vigente de CADA producto del hub.
  sku PK,
  source ('list'|'manual'),
  manual_bulk_price, manual_bulk_qty, manual_unit_cost,   ← proveedores sin PDF
  manual_discount_1, manual_discount_2,
  profit_margin_override,                                 ← ganancia propia de este producto
  updated_at

price_overrides           Tus ajustes a mano. NO se pisan al recalcular.
  sku, channel ('tn_list'|'ml'), value, updated_at

price_apply_audit         Qué se aplicó, cuándo y cómo salió.
  id, sku, channel, price_before, price_after, applied_at, status, error
```

Tres decisiones de modelado que importan:

1. **`sku_code_map` apunta al `code`, no al `price_list_item`.** Por eso el mapeo se hace **una
   sola vez**: cuando entra la lista de Marzo, los códigos ya están mapeados y solo cambian los
   precios. Es exactamente lo que pediste.
2. **`supplier_codes` guarda todos los códigos del PDF**, tengas o no el producto. Y `product_costs`
   existe para todo SKU del hub, tenga o no código. Los dos huérfanos que mencionaste están
   contemplados por construcción:
   - código sin SKU → *"Punto Cero lo vende, vos no"* → la UI ofrece crear el producto.
   - SKU sin código → *"es de otra marca"* → costo manual, mismo cálculo.
3. **`price_overrides` es lo que salva tu trabajo manual.** Hoy `Precio Transferencia` y
   `ML Ajustado` **son** ajustes a mano. Si el recálculo los pisara, perderías criterio acumulado.

---

## 7. El mapeo (una sola vez)

**Escalera de coincidencia. Lo que se confirma, se guarda y no se vuelve a preguntar.**

1. **Código exacto** — `30700` = `30700`. Se aplica solo.
2. **Mapeo ya guardado** — se aplica solo.
3. **Código base** — tu `30700-ROSA` contra `30700`. **Propone, no aplica.**
4. **Código dentro de un grupo** — tu `39033` contra la fila `39021/22/33/34/38/…`. **Propone.**
5. **Similitud de descripción** — último recurso. **Propone.**

Del 3 en adelante nunca se aplica solo: se propone con un score y espera confirmación. El costo
de equivocarse es publicar un precio mal en ML, así que el default es preguntar.

Con la lista de Noviembre cargada y los mapeos confirmados, importar Marzo debería resolver
sola la enorme mayoría — solo pregunta por códigos nuevos.

---

## 8. Parseo del PDF (solo Punto Cero)

El PDF es texto (no escaneado): `pypdf` lo extrae limpio, ya lo probé. Sale **sin separadores**:

```
30700A5  T/Dx80hjs.Removible c/elástico. Pack x8 unid. surt.$ 8.800,008 $ 70.400,00*
```

Ahí hay: código `30700`, descripción, precio unitario `$8.800,00`, bulto `8`, precio por bulto
`$70.400,00`, y `*` = "no se fracciona". Una regex lo resuelve porque el formato de moneda es
rígido, y **el parseo se valida solo**: si `precio_unitario × bulto ≠ precio_bulto`, la fila se
marca y no se usa. Falla ruidosamente en vez de en silencio.

Casos ya vistos en el PDF:
- **Códigos múltiples**: `39021/22/33/34/38/134/135/136/137/138`, `39024-39025`.
- **Prefijo `FULL`**: `FULL 30700` ≠ `30700`.
- **Filas sin código**: los colores de biblioratos heredan el código de arriba (`39650`/`30650`).
- **"A COTIZAR"**: `30001 EXHIBIDOR MOSTRADOR` → se ignora.
- **Encabezados de sección**: `CUADERNO A5`, `REPUESTOS A5` no son productos.
- **IVA**: el PDF dice *"LOS PRECIOS NO INCLUYEN IVA"*. Tu cadena ya trabaja sin IVA; se aclara en la UI.

**Importar CSV/Excel además del PDF** sale casi gratis y te cubre si Punto Cero cambia el formato.
Va desde el día uno.

---

## 9. Backend

| Archivo | Qué hace |
|---|---|
| `lib/pricing.js` | **la fórmula pura** — sin I/O, sin red, testeable sola |
| `lib/pdfParser.js` | PDF/CSV → filas, con la validación de §8 |
| `lib/mlFees.js` | comisión/tramos/envío desde la API (fase 4) |
| `services/pricingService.js` | costo + reglas + overrides → precios |
| `services/priceApplyService.js` | aplica a ML y TN con `mlLimiter`/`tnLimiter` |
| `routes/pricing.js` | `/api/pricing/*` |

**`lib/pricing.js` es el corazón y queda puro**: entran costo + reglas, sale precio. Se testea
contra **las 131 filas de las 9 pestañas** como fixture. Ya verifiqué que la fórmula del Excel
las reproduce exacto, así que el test está escrito antes que el código. Los tests del despeje
corregido van aparte, con el criterio *"neteo ≥ valor final"* sobre las mismas 131 filas.

```
GET/PUT /api/pricing/settings          valores fijos (Ajustes)
GET/PUT /api/pricing/tiers             tramos de comisión fija
POST    /api/pricing/lists/import      subir PDF + descuentos → preview (NO guarda)
POST    /api/pricing/lists             confirmar y guardar
GET     /api/pricing/codes             catálogo de códigos + estado de mapeo
PUT     /api/pricing/mapping/:sku      confirmar/corregir mapeo
PUT     /api/pricing/cost/:sku         costo manual (otros proveedores)
PUT     /api/pricing/override/:sku     pisar un precio a mano
GET     /api/pricing/preview           todo calculado, con deltas
POST    /api/pricing/apply             aplicar masivo (lista explícita de SKUs)
GET     /api/pricing/audit             historial
```

`GET /preview` no escribe nada. La UI muestra todo antes de tocar un precio real.

### La aplicación masiva — casi toda la infra ya existe

Miré cómo quedó `develop` después de tu trabajo de historial, y **la parte más difícil ya está
construida**. No hay que inventar la cola ni el manejo de 429: hay que usarlos.

**Ya existe, se reusa tal cual:**

- **La cola durable `ml_pending_tasks`** (en `db.js`). Es exactamente lo que pediste: "que
  queden en una cola si no se puede de una". Cada tarea persiste en Postgres con `status`,
  `attempts`, `next_run_at`, `idempotency_key UNIQUE` y `locked_at`. Sobrevive reinicios del
  backend: si el proceso se cae con 30 precios pendientes, al volver los sigue procesando.
- **El worker `mlTaskQueue.js`** ya define el tipo de tarea **`price_ml`** — literalmente
  "actualiza el precio (target_price) de un ítem/variación en ML". Aplica con
  `updateItemOrVariationPrice`, parchea el snapshot con `patchMlPrice`, y respeta lo de
  `CLAUDE.md` (en ítems legacy el precio va a **todas** las variaciones). **Ese pedazo ya está
  hecho y probado.**
- **El backoff ante fallo** ya está: `updateMlTaskStatus` reintenta con backoff cuadrático
  (10s → 40s → 90s → 160s → 250s, hasta 5 intentos). Un `price_ml` que rebota con 429 se
  reprograma solo.
- **El circuit breaker de 429** (`mlLimiter.js`) frena **todo** el caño cuando ML bloquea:
  cuenta 429 consecutivos y pausa con cooldown que escala 30s → 5m. Un 429 no rompe la tanda,
  la desacelera. `claimNextMlTask` usa `FOR UPDATE SKIP LOCKED`, así que es seguro con réplicas.

**Lo que falta construir (poco):**

1. **`price_ml` no escribe historial.** Es el hueco. El worker aplica el precio pero, a
   diferencia de `stock_ml_set`, no llama a `insertAuditLog`. Hay que agregar esa escritura
   (§10). Es la razón por la que tu cambio de precios hoy no quedaría registrado.
2. **Encolar en masa.** `POST /api/pricing/apply` no aplica de una: **encola un `price_ml` por
   SKU** (con `enqueueMlTask`, que ya existe) y devuelve al toque. La UI muestra el progreso
   leyendo `getPendingMlTasks` (que ya existe y ya cuenta activos/fallidos) — igual que la
   pantalla de sincronización ya muestra la cola de stock.
3. **TN en bulk.** ML va de a uno por la cola; TN va por el bulk `PATCH /products/stock-price`
   de la rama `claude/affectionate-austin-b4e559`, con `tnLimiter`. Un solo precio (el de lista).

**Reglas que se mantienen:**

- **Nunca aplica sin preview confirmado.** "Aplicar" manda una lista explícita de SKUs.
- **La idempotencia la da la cola**: `idempotency_key` evita que un doble click encole el mismo
  precio dos veces.
- **Fallo parcial no es fallo total**: cada SKU es su propia tarea. Si 3 de 44 fallan, esos 3
  quedan en `failed` (reintentables) y los 41 se aplican. No hay rollback global.

---

## 10. Qué puede traer la API de ML (fase 4)

**Tu modelo del Excel es estructuralmente idéntico al de ML.** La API devuelve:

```
sale_fee_amount = price × (percentage_fee/100) + fixed_fee
                          └─ tu 15% ─┘          └─ tus tramos ─┘
```

| Dato | De dónde | Endpoint |
|---|---|---|
| Comisión 15% | `sale_fee_details.meli_percentage_fee` | `GET /sites/MLA/listing_prices` |
| Tramos de fija | `sale_fee_details.fixed_fee` | idem |
| Umbral 33.000 | tag `mandatory_free_shipping` | `GET /items/{id}` |
| Envío 6.500 | `coverage.all_country.list_cost` | `GET /users/{id}/shipping_options/free` |
| **Impuestos 300** | **no existe en la API** | queda a mano, siempre |

Advertencias honestas:

- **El agente no pudo traer JSON en vivo**: su entorno recibe 403 del WAF de ML. Los ejemplos
  son de la documentación, no de tu cuenta. **Primer paso de la fase 4: validar con tu token
  desde el backend.**
- **En Argentina el `fixed_fee` ahora depende del peso del paquete** (obligatorio desde 12/03).
  Tus tramos por precio podrían estar desactualizados.
- **El inverso no existe** — confirmado. No hace falta: la fórmula es lineal y ya la invertimos.
- **No cachear por precio**: se cachea `percentage_fee` + `fixed_fee` por
  `(category_id, listing_type_id, tramo)` con TTL 24 h y el monto se calcula local.
- **La verdad de campo es `order_items[].sale_fee`**: la comisión que ML realmente cobró.
  Guardarla al sincronizar la orden y compararla contra el estimado te avisa si el modelo se
  desfasó. Fase 5.

Todo esto es **una mejora sobre algo que ya anda con valores a mano**. Los valores quedan
editables igual (*override-on-demand*, como el resto del hub).

---

## 10-bis. El historial de precios va en tu modal, no en uno nuevo

Miré el `stock-history-dialog` que hiciste. Es exactamente el lugar correcto: se abre por SKU,
trae los cambios de ML y TN juntos, ordenados, y responde *"¿qué le pasó a este producto?"*.
El precio es otra cosa que le pasa al producto, así que va ahí adentro como una sección más.

**El problema de meterlo en la misma tabla:** `sync_audit` tiene `stock_before` y `stock_after`
como `INTEGER NOT NULL`. Los precios son `NUMERIC` y son por canal (el de ML no es el de TN).
Forzarlos en esa tabla implica hacer nullable dos columnas que hoy son obligatorias y meter un
discriminador stock/precio en una tabla cuyo nombre y cuyos seis consumidores asumen "stock".
Es ensuciar algo que **acabás de terminar y que anda**.

**Implementado** (fase 3): tabla `price_audit`, gemela de `sync_audit` pero con semántica de precio.

```
price_audit
  id, sku, channel ('mercadolibre'|'tiendanube'),
  price_before NUMERIC(15,2), price_after NUMERIC(15,2),
  source ('bulk'|'manual'),        -- 'bulk' = aplicación masiva, 'manual' = ajuste puntual
  list_id → price_lists,           -- con qué lista se calculó (null si manual)
  created_at
  índice (sku, created_at DESC)    -- igual que idx_sync_audit_sku_created
```

Y el modal pasa de *"Historial de stock"* a **"Historial del producto"** con dos secciones (o
una línea de tiempo unificada, ordenada por fecha, con un ícono distinto para stock y para
precio). El componente ya está armado para esto: hace un `injectQuery` por SKU; se le agrega un
segundo query a `price_audit` y se fusionan. La UX no cambia, solo se enriquece.

El que escribe `price_audit` es el worker de la cola: cuando un `price_ml` termina OK, además de
parchear el snapshot, inserta la fila con el precio anterior (que `patchMlPrice` ya devuelve, tal
como `patchMlStock` devuelve el stock anterior para el historial de stock). Mismo patrón, misma
mano. Para TN, lo escribe el que aplica el bulk.

**Por qué separado y no extender `sync_audit`:** son dos cosas con forma distinta (entero vs.
decimal, un canal vs. dos, con orden/pack vs. sin), y separarlas deja tu tabla de stock intacta
—cero riesgo de regresión sobre lo que recién subiste— mientras reusa el modal, que es lo que
te importaba. Si preferís una sola tabla, se puede, pero te lo desaconsejo por eso.

---

## 11. Frontend

Ruta `/precios` en [`app.routes.ts`](../frontend/src/app/app.routes.ts), standalone con signals
y TanStack Query en `pages/precios/`. Servicio `core/services/pricing.service.ts`.

Componentes: `lista-importer` (con los descuentos de la compra), `costo-manual-form`,
`precio-tabla`, `mapeo-confirm`, `aplicar-dialog` (reusando `confirm-dialog`).
Los valores fijos viven en **Ajustes**, no en la pantalla de precios.
El historial reusa el `stock-history-dialog` existente, ampliado (§10-bis).

Todo con los tokens de `styles.scss`. Nada hardcodeado.

---

## 12. El diseño: Opción A (Planilla viva)

Elegida. Abrí [`prototype/precios-prototipo.html`](prototype/precios-prototipo.html) — es la
tabla densa tipo tu Excel: todo a la vista, edición inline, desglose al expandir. Es el modelo
mental que ya tenés y se parece a lo que usás.

La Opción B (asistente por pasos) se descarta **como pantalla**, pero su mejor idea se conserva:
**no dejar aplicar un precio con un mapeo adivinado.** Eso se resuelve dentro de la Planilla —
cuando entra un código nuevo sin confirmar, la fila queda marcada y no entra en la selección de
"Aplicar" hasta que la confirmás (§7). Es el paso de confirmación de B, sin la pantalla de B.
Como el mapeo se guarda, esto pasa una sola vez por código nuevo.

El prototipo todavía tiene el switch A/B para que compares; en la implementación real queda solo A.

---

## 13. Fases

| Fase | Qué incluye | Por qué acá |
|---|---|---|
| ~~**1. El motor**~~ ✅ | `lib/pricing.js` + tests contra las 131 filas + despeje corregido | Hecho (commit 5606905). |
| ~~**2. Ajustes + costo manual + aplicar**~~ ✅ | `pricing_settings`, `ml_fee_tiers`, `product_costs`, pantalla de Ajustes, carga manual, preview, encolar `price_ml` en masa + bulk TN | Hecho (commits 2fec0db backend, e510172 frontend). |
| ~~**3. Historial de precios**~~ ✅ | tabla `price_audit`, escritura desde el worker y desde el bulk de TN, `product-history-dialog` con stock y precio fusionados | Hecho. `patchMlPrice`/`patchTnPrice` ahora devuelven el precio previo, igual que `patchMlStock`. |
| **4. PDF + mapeo** | `pdfParser`, `supplier_codes`, `price_lists`, `sku_code_map`, confirmación de mapeo | El grueso del ahorro. Solo Punto Cero. **Siguiente.** |
| **5. API de ML** | validar endpoints con tu token → `lib/mlFees.js` | Mejora sobre algo que ya anda. Es lo único que depende de terceros. |
| **6. Refinamiento** | revertir, aviso de zona muerta, contraste contra `sale_fee` real | Cuando el resto esté rodado. |

Fuera de alcance: **precio mayorista** (otra sesión).

---

## 14. Puntos abiertos

Todo lo importante quedó cerrado. Quedan dos cosas chicas, ninguna bloquea:

1. **El descuento por transferencia de la tienda.** Publicamos el precio de lista y TN aplica su
   propio descuento. Para que el que transfiere pague la `precio_transferencia` que calculamos,
   ese descuento tiene que ser **23,08%** (`1 − 1/1,3`). Si en la tienda está en 20% o 25%, los
   números no van a cerrar con la planilla. **Vale la pena que lo mires una vez.**
2. **El redondeo del precio de lista.** `lista = ceil50(transferencia × 1,3)`, así los dos quedan
   en múltiplos de 50. Eso hace que el descuento de la tienda dé la transferencia ±$50. Si
   preferís que la transferencia caiga exacta, hay que no redondear la lista.
