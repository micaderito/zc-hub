# Prototipos de referencia

Prototipos **estáticos y no funcionales**: sirven como guía visual del producto y de la UX.

| Archivo | Qué es |
|---|---|
| `zona-cuaderno-hub.html` | El rediseño del hub (stock de Mercado Libre + Tienda Nube). |
| `precios-prototipo.html` | La sección de **Precios** — dos opciones de UI para el mismo motor de cálculo. |

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

## Relacionado

- Plan de la sección de precios: [`../PLAN-PRECIOS.md`](../PLAN-PRECIOS.md)
- Definiciones de estilo: [`../STYLEGUIDE.md`](../STYLEGUIDE.md)
- Implementación de tokens: [`../../frontend/src/styles.scss`](../../frontend/src/styles.scss)
- Página real de crear producto: `frontend/src/app/pages/crear-producto/`
