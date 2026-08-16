# Prototipos de referencia

Prototipos **estáticos y no funcionales**: sirven como guía visual del producto y de la UX.

| Archivo | Qué es |
|---|---|
| `zona-cuaderno-hub.html` | El rediseño del hub (stock de Mercado Libre + Tienda Nube). |
| `precios-prototipo.html` | La sección de **Precios** — dos opciones de UI para el mismo motor de cálculo. |
| `alertas-prototipo.html` | Las **Alertas de stock** — dos opciones de UI para configurar avisos y armar el pedido. |

## Cómo verlos

Abrilos en cualquier navegador (doble clic o `open <archivo>.html`).
No requieren build ni servidor. Los dos tienen **modo claro / oscuro** con el botón
abajo a la izquierda.

## `zona-cuaderno-hub.html`

Navegá entre secciones con el menú lateral: **Inicio, Productos, Crear producto, Conflictos, Sincronización**.

- **Inicio** — estado de conexión de ambos canales + métricas + actividad.
- **Productos** — stock y precio de ML y TN combinados por SKU.
- **Crear producto** — datos comunes una vez + paneles por canal con todos los
  campos que pide cada API, mapeo de variantes (Opción B) y override-on-demand.
- **Conflictos** — lo que el matcheo por SKU no resolvió.
- **Sincronización** — webhooks que ajustaron stock.

## `precios-prototipo.html`

Usá el switch de arriba para alternar entre las dos opciones. Datos reales
(lista Punto Cero nov-2025 + planilla feb-2026).

- **Opción A — Planilla viva** — una tabla densa tipo Excel: del bulto al precio de ML,
  reglas en chips arriba, celdas editables inline, desglose del cálculo al expandir una fila.
- **Opción B — Asistente por pasos** — flujo de 4 pasos (importar → mapear → revisar → aplicar),
  panel de reglas en vivo y una tarjeta por producto con el antes → después por canal.

Las dos usan el mismo motor de cálculo; cambia solo la piel.
El plan y la comparación están en [`../PLAN-PRECIOS.md`](../PLAN-PRECIOS.md).

## `alertas-prototipo.html`

Abre en el **diseño elegido**. Es navegable de verdad: el **menú lateral** cambia entre Alertas y
Productos, las **pestañas** cambian de vista, los **buscadores** filtran, el botón **✎** de Reglas
edita en la misma fila y la **campanita** abre el cajón.

### El diseño elegido

Ítem **Alertas** en el menú con burbuja de no leídas y tres pestañas; los avisos se leen en un
**cajón lateral** que entra desde la derecha, sin salir de la pantalla en la que estás.

- **Para reponer** — la vista del pedido mensual al proveedor. Una **lista** (no tarjetas) con una
  fila por producto: stock de hoy en ML y TN, umbral, cuántas veces avisó, estado (`Sigue bajo`,
  `Sin stock`, `Ya repuesto`) y la cantidad a pedir. Tiene buscador y se puede ver **agrupada por
  pack** o como **lista plana** ordenada por urgencia. Cierra con *Marcar pedido como hecho*.
- **Notificaciones** — el historial cronológico, con el pack de cada producto.
- **Reglas** — qué se vigila y con qué umbral. Buscador + edición **en la misma fila** (✎): si la
  búsqueda deja una sola coincidencia, esa fila se abre para editar sola.

### Packs

El **pack** es la unidad con la que se le compra al proveedor: viene de X unidades (configurable,
casi siempre 8) y puede ser **surtido** (la mezcla la arma el proveedor, ej. *Cuadernos
inteligentes*) o **de un modelo por pack** (ej. los repuestos, 8 iguales). No todos los productos
tienen pack; esos se piden por unidad suelta.

Se arman y editan en **Productos → pestaña Packs** (el pack es una propiedad del catálogo, no de
las alertas): nombre, unidades por pack, tipo, y los modelos que lo componen con su stock y su
alerta. En Alertas el pack solo se muestra y se usa para agrupar y sumar.

### Opción A — descartada

Queda en el switch como referencia: el umbral se ponía desde la fila de Productos y los avisos
vivían en una barra superior nueva. **No** tiene packs, ni buscador, ni edición en la fila.

## Relacionado

- Plan de la sección de precios: [`../PLAN-PRECIOS.md`](../PLAN-PRECIOS.md)
- Definiciones de estilo: [`../STYLEGUIDE.md`](../STYLEGUIDE.md)
- Implementación de tokens: [`../../frontend/src/styles.scss`](../../frontend/src/styles.scss)
- Página real de crear producto: `frontend/src/app/pages/crear-producto/`
