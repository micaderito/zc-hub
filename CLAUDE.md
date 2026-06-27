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

### Cuenta PxV (Price per Variation / User Products)

La cuenta del vendedor tiene el tag `user_product_seller` (verificable vía `GET /users/me`).
En este modelo cada variación tiene su propio `user_product_id` (ej. `MLAU2908014071`), que
funciona como un ítem independiente en la API.

**Actualizar precio de una variación:** usar `PUT /items/{user_product_id}` con `{ price }`.
NO usar `PUT /items/{itemId}/variations/{varId}` con `{ price }` — ML reconcilia el precio a
nivel ítem, detecta divergencia entre variaciones y rechaza con:
> "Found different prices in variations; Item price was dropped by the highest-price variation"

La función `updateItemOrVariationPrice` en `backend/src/lib/mercadolibre.js` ya maneja esto:
obtiene el `user_product_id` de la variación vía `getItem` y hace el PUT sobre él. Si la cuenta
no tuviera `user_product_id` (legacy), aplica el mismo precio a todas las variaciones.

**Actualizar stock de una variación:** se hace vía `PUT /items/{itemId}` con el array completo
de `variations` (el modelo de stock no cambió con PxV). Ver `updateItemOrVariationStock`.

### Modelos de cuenta (para referencia)
| Modelo | Identificación | Precio por variación |
|---|---|---|
| Legacy | Sin `user_product_seller` en tags | Todas las variaciones al mismo precio |
| PxV / User Products | `user_product_seller` en tags | Cada variación tiene `user_product_id` propio |
