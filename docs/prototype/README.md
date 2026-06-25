# Prototipo de referencia

`zona-cuaderno-hub.html` es el prototipo navegable del rediseño del hub
(combina stock de Mercado Libre + Tienda Nube). Es **estático y no funcional**:
sirve como guía visual del producto y de la UX.

## Cómo verlo

Abrí el archivo en cualquier navegador (doble clic o `open zona-cuaderno-hub.html`).
No requiere build ni servidor.

- Navegá entre secciones con el menú lateral: **Inicio, Productos, Crear producto, Conflictos, Sincronización**.
- Probá **modo claro / oscuro** con el botón abajo a la izquierda.

## Qué muestra

- **Inicio** — estado de conexión de ambos canales + métricas + actividad.
- **Productos** — stock y precio de ML y TN combinados por SKU.
- **Crear producto** — datos comunes una vez + paneles por canal con todos los
  campos que pide cada API, mapeo de variantes (Opción B) y override-on-demand.
- **Conflictos** — lo que el matcheo por SKU no resolvió.
- **Sincronización** — webhooks que ajustaron stock.

## Relacionado

- Definiciones de estilo: [`../STYLEGUIDE.md`](../STYLEGUIDE.md)
- Implementación de tokens: [`../../frontend/src/styles.scss`](../../frontend/src/styles.scss)
- Página real de crear producto: `frontend/src/app/pages/crear-producto/`
