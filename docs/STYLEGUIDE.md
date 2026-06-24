# Zona Cuaderno Hub — Guía de estilos

Definiciones de diseño del rediseño. Es la **fuente de verdad** del look & feel.
La implementación viva de los tokens está en [`frontend/src/styles.scss`](../frontend/src/styles.scss);
el prototipo navegable de referencia está en [`docs/prototype/zona-cuaderno-hub.html`](./prototype/zona-cuaderno-hub.html)
(abrilo en el navegador y usá el botón de modo claro/oscuro).

---

## 1. Principios

- **Plano y limpio.** Superficies sólidas, bordes finos (0.5px), sin gradientes, sombras decorativas ni glow.
- **Dos canales, una interfaz.** Mercado Libre = amarillo, Tienda Nube = azul. Esos colores solo identifican canal, nunca se usan como acento general de la UI.
- **Claro y oscuro de primera.** Todo color sale de un token; nada se hardcodea. Si funciona en claro tiene que funcionar en oscuro.
- **El SKU es la unidad.** En la UI, el dato que une ambas plataformas siempre es el SKU.

---

## 2. Tokens de color

Se definen como CSS custom properties en `:root[data-theme='light']` y `:root[data-theme='dark']`.
Usar **siempre** la variable, nunca el hex.

### Neutros / superficie

| Token | Claro | Oscuro | Uso |
|---|---|---|---|
| `--bg` | `#f5f6f8` | `#0e1017` | Fondo de página |
| `--surface` | `#ffffff` | `#171a22` | Tarjetas, sidebar |
| `--surface-2` | `#eef0f3` | `#1f232d` | Relleno sutil, filas, chips |
| `--border` | `rgba(20,22,40,.12)` | `rgba(255,255,255,.11)` | Bordes por defecto (0.5px) |
| `--border-strong` | `rgba(20,22,40,.22)` | `rgba(255,255,255,.2)` | Borde en hover/énfasis |
| `--text` | `#1a1c2e` | `#e8eaf0` | Texto principal |
| `--text-2` | `#5d6373` | `#a2a8b5` | Texto secundario, labels |
| `--text-3` | `#9aa0ad` | `#6a7180` | Hints, placeholders |

### Marca y canales

| Token | Claro | Oscuro | Uso |
|---|---|---|---|
| `--brand` | `#5b54e6` | `#8b85ff` | Acento de la app (links activos, botón primario, "propio") |
| `--brand-bg` | `#ecebfd` | `#26233f` | Fondo del acento (nav activo, tag "propio") |
| `--ml` | `#ffe600` | `#ffe600` | Mercado Libre (punto/borde) |
| `--ml-bg` / `--ml-text` | `#fff7bf` / `#5c5400` | `#3a3600` / `#ffe600` | Badge ML |
| `--tn` | `#2b8aef` | `#67abf5` | Tienda Nube |
| `--tn-bg` / `--tn-text` | `#e3eefc` / `#114e8e` | `#13314f` / `#9cc7f7` | Badge TN |

### Semánticos (estado)

| Token | Claro | Oscuro | Uso |
|---|---|---|---|
| `--ok` / `--ok-bg` | `#1d9e75` / `#e1f5ee` | `#5dcaa5` / `#0f3a30` | Sincronizado, publicado |
| `--warn` / `--warn-bg` | `#ba7517` / `#faeeda` | `#efa83a` / `#3a2a0e` | A revisar, stock distinto |
| `--err` / `--err-bg` | `#d04444` / `#fcebeb` | `#e07a7a` / `#3a1414` | Error, obligatorio, eliminar |

> Regla de texto sobre color: el texto sobre un fondo de canal/estado usa el token `*-text`
> (o el color fuerte de la familia), nunca negro plano ni gris genérico.

---

## 3. Tipografía

- **Fuente:** `Inter` (Google Fonts), fallback system-ui.
- **Idioma:** la app está en español (es-AR).
- **Pesos:** 400 (regular), 500 (medio), 600 (títulos). No usar 700.
- **Sentence case** siempre. Nunca Title Case ni MAYÚSCULAS (salvo encabezados de tabla, que van en `uppercase` + `letter-spacing: .03em` a 10–11px).

| Rol | Tamaño | Peso |
|---|---|---|
| h1 (título de página) | 1.4rem (~22px) | 600 |
| h2 (título de sección) | 18px | 500–600 |
| Título de bloque/tarjeta | 0.88rem (~14px) | 600 |
| Texto base | 0.8rem (~13px) | 400 |
| Label de campo | 0.7rem (~11px) | 500, color `--text-2` |
| Hint | 0.64rem (~10px) | 400, color `--text-3` |

---

## 4. Layout, radios y espaciado

- **Radios:** `--radius-sm` 8px (inputs), `--radius-md` 10px (botones, nav), `--radius-lg` 12px (tarjetas).
- **Bordes:** `0.5px solid var(--border)`. Sin esquinas redondeadas en bordes de un solo lado (ej. `border-top` de acento de canal → resto sin radius).
- **Acento de canal:** las tarjetas de ML/TN llevan `border-top: 3px solid var(--ml | --tn)`.
- **Espaciado vertical:** rem (0.8rem, 1rem, 1.5rem). Gaps internos en px (8–12px).
- **Sidebar:** 220px fija, `position: sticky`. Colapsa a fila en ≤760px.
- **Ancho de contenido:** máx ~1180px; formularios máx ~880px.

---

## 5. Componentes (primitivas reutilizables)

Definidas en `styles.scss`, válidas en claro/oscuro:

- **`.zc-card`** — superficie blanca, borde 0.5px, radius-lg.
- **`.zc-btn`** — botón base (borde + hover `--surface-2`, active `scale(.98)`).
  - `.zc-btn.primary` — fondo `--brand`, texto blanco.
  - `.zc-btn.small` — versión compacta.
- **`.zc-input` / `.zc-select` / `.zc-textarea`** — 0.5px borde, fondo `--bg`, focus ring `--brand`.
  - `.is-own` — borde `--brand` (campo override editado).
- **`.zc-badge`** — pill 0.66rem con variantes `.ml`, `.tn`, `.ok`, `.warn`, `.err`.

### Iconografía

- **Tabler Icons** (webfont), solo variante **outline** (`<i class="ti ti-…">`). Nunca `-filled`.
- Tamaño 16–20px inline, 24px máx decorativo. Iconos decorativos `aria-hidden`; botones solo-icono con `aria-label`.

---

## 6. Patrones propios del dominio

### Identidad de canal
- **Mercado Libre:** cuadradito amarillo (`.dot` con `--ml`) + texto "ML". Nunca solo color amarillo de texto (ilegible).
- **Tienda Nube:** ícono `ti-shopping-bag` o rombo `◆` en azul + texto "TN".

### Override-on-demand (crear producto)
Cada campo de un canal **hereda del dato común** o es **propio**:
- `del común` → chip gris (`.tag-com`, `ti-link`), campo mostrado como caja punteada de solo lectura con lápiz para editar.
- `propio` → chip violeta (`.tag-own`, `ti-pencil`), input con borde `--brand` y opción "volver a heredar" (`ti-rotate`).

### Mapeo de variantes (Opción B)
Cada canal define un **modo** (`single_with_variants` / `one_per_variant`) con un toggle, y un badge muestra la proyección en vivo (ej. "1 publicación con variantes"). El SKU sigue uniendo ML ↔ TN por variante.

### Estados de stock (vista Productos / Sync)
- `sync` → badge `.ok` (mismo stock en ambos).
- `≠` → badge `.warn` (stock distinto).
- `solo TN` / `solo ML` → badge de canal (existe en un solo lado).

---

## 7. Modo claro / oscuro

- El tema se aplica con `data-theme="light|dark"` en `<html>`.
- Un script inline en [`index.html`](../frontend/src/index.html) lo setea **antes** de cargar Angular (evita parpadeo), leyendo `localStorage['zc-theme']` o la preferencia del sistema.
- [`ThemeService`](../frontend/src/app/core/services/theme.service.ts) lo togglea y persiste.
- **Test mental:** si el fondo fuera casi negro, ¿se lee todo el texto? Si no, falta usar un token.

---

## 8. Accesibilidad

- Contraste suficiente en ambos modos (texto sobre color usa el token `*-text`).
- `aria-label` en botones de solo ícono; `aria-hidden` en íconos decorativos.
- Foco visible: ring de `--brand` en inputs.
