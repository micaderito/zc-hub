# Precios: proveedores, configuraciones de descuento y precio por bulto

Fecha: 2026-10-15 · Rama: `claude/pricing-provider-config-9d037e`

## Pedido de la usuaria

1. En la planilla se veía cantidad por bulto, costo unitario y los precios de ML/TN, pero **no el
   precio del bulto**.
2. El descuento se cargaba al importar, pero en Ajustes había uno solo y **no se veía qué
   descuento llevaba cada producto**. Quiere **varias configuraciones** (las agendas llevan más
   descuento que el resto; los bolígrafos de otro proveedor no llevan), asignables a packs/productos,
   **también de forma masiva** (las agendas no tienen lista en PDF: se cargan los bultos a mano).
3. Varios proveedores con **ABM**, poder **filtrar** Precios por proveedor, y productos que se compran
   a **más de un proveedor** (Filgo: dos distribuidores).

## Decisiones (confirmadas con la usuaria)

| Tema | Decisión |
|---|---|
| Diseño | Una **pestaña por proveedor** (Todos · Punto Cero · Filgo · … · + Proveedor) |
| Configs de descuento | **De cada proveedor**, con una default |
| Import | El modal precarga la default del proveedor; se puede cambiar; va **solo a lo que no tiene config propia** |
| Dos proveedores | **Cada uno tiene su código** para el producto; el **vigente se elige a mano** |

## Modelo

- `suppliers (key, name)` — `key` slug inmutable (`punto_cero`).
- `discount_profiles (id, supplier_key, name, discount_1, discount_2, is_default)`.
- `product_suppliers (target_type 'sku'|'pack', target_id, supplier_key, discount_profile_id|NULL)`.
- `product_costs.supplier_key` = proveedor vigente.
- `sku_code_map`, `pack_code_map`, `supplier_codes`: PK compuesta con el proveedor.

Descuento de un SKU = config del SKU (para su vigente) → la del pack → la default del proveedor →
sin proveedor, 0. Se resuelve al calcular (`lib/discountResolver.js`), no se guarda en el costo.

## Pantalla

- Pestañas por proveedor arriba; adentro, tarjetas con sus configs (nombre, %, productos que la
  usan, editar / hacer default / borrar) y "Nueva configuración". Debajo, `Planilla | Mapeo`.
- Tabla, sin sumar ancho: **Bulto** = precio del bulto + "12 u. · $X c/u"; **Descuento** = chip con
  la config + "−25% −5%" (tooltip con la cadena lista → descuentos → ÷ unidades); **Costo u.** = en
  cuánto queda; el valor final pasa a línea secundaria de "Te queda". En "Todos" el renglón del
  producto dice el proveedor vigente (y "+1" si hay otro).
- Barra de acción: **Asignar descuento…** (un pack entero va como pack) y **Proveedor vigente…**.
- Importar: proveedor + config en vez de los dos % sueltos; el resumen dice qué config tomó cada cosa.
- Agregar/editar costo: proveedor + config en vez de los % sueltos.
- Mapeo: por proveedor; en "Todos" solo lectura con el código de cada proveedor.

## Fuera de alcance (follow-up)

- Proveedor en los **Pedidos** (`supplier_orders`): hoy la fábrica recibe el código del proveedor
  vigente, pero el pedido no sabe a quién se le hizo. Sus descuentos por pedido (25 + 5 por default)
  siguen aparte.
