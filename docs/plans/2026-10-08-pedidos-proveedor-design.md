# Pedidos al proveedor — diseño

## Problema

"Para reponer" (Alertas) mezclaba dos cosas: avisar que algo se está quedando sin stock y armar el
pedido al proveedor. No siempre que avisa se pide (hay en el depósito, o en un pack surtido de 8
modelos se agotó uno solo), y a veces se pide algo que no avisó (compra para tener). Además el
pedido no quedaba guardado: no había historial, ni forma de repetirlo, ni de registrar qué llegó.

## Decisiones (confirmadas con la usuaria)

- **Página propia `/pedidos`** (ítem de menú). La pestaña "Para reponer" de Alertas se reemplaza por
  un aviso con link a Pedidos.
- **Las alertas sugieren, la usuaria decide**: nada entra solo al pedido. El catálogo para agregar
  tiene filtro *Con alerta / Todos*, y muestra stock ML/TN, depósito, estado de la alerta, último
  pedido y si ya está "en camino" en un pedido pendiente.
- **Siempre se pide por pack**: la unidad de compra es el pack del hub (`product_packs`); un SKU sin
  pack se pide por el bulto que tenga cargado en Precios (`product_costs.bulk_qty`, 1 si no hay).
- **Varios borradores a la vez** (ej. agendas con otro descuento).
- **Estados**: `borrador` → `pendiente` (marcado como pedido) → `recibido` (con `partial` si no llegó
  todo). Recepción por línea (cuántos packs llegaron), y "pasar lo que faltó a un borrador nuevo".
  **Recibir NO toca stock** (ni ML/TN ni depósito): solo registra.
- **Líneas**: código, descripción, detalle (texto libre: diseños/colores), cantidad en packs, precio
  de lista por pack. Ítems libres para productos que el hub no tiene.
- **Precio**: precio de lista del bulto en Precios (`product_costs.bulk_price / bulk_qty × unidades
  del pack`), **editable por línea, solo para ese pedido** (nunca escribe en Precios). Las líneas
  "de Precios" de un borrador se refrescan al abrirlo; las editadas no.
- **Código**: el del proveedor — pack: `pack_code_map.code` → `product_packs.sku` → (pack de un solo
  modelo) `sku_code_map` del modelo; SKU suelto: `sku_code_map.code`. **Descripción**:
  `supplier_codes.description` de ese código, si no el nombre del pack/producto. Ambos editables.
- **Descuentos**: por pedido, `discount_1` sobre el subtotal y `discount_2` sobre el total resultante.
  Default 25% + 5%, configurable (`sync_settings`, clave `supplier_order_defaults`).
- **Vista para la fábrica**: hoja limpia (siempre fondo blanco) con código · descripción · cantidad ·
  detalle, para captura. Botones "Descargar imagen" (PNG dibujado en canvas, sin dependencias) y
  "Copiar como tabla" (HTML + TSV en el portapapeles).
- **Repetir** (copia idéntica: como borrador, o directo como pendiente) y **Duplicar** (borrador).
- Marcar como pedido corre el corte de alertas (`setRestockCutoff`), igual que el viejo "Marcar
  pedido como hecho".

## Datos

```
supplier_orders(id, name, status, partial, discount_1, discount_2, note, based_on_id,
                created_at, updated_at, ordered_at, received_at)
supplier_order_lines(id, order_id → CASCADE, position, kind 'pack'|'sku'|'free', pack_id, sku,
                     code, description, detail, qty, unit_price, price_source 'precios'|'manual',
                     units_per_pack, origin 'alerta'|'manual'|'copia'|'libre', received_qty)
```

El contenido de un borrador se guarda entero (`PUT /orders/:id` reemplaza las líneas en una
transacción); el front autoguarda con debounce. Solo un `borrador` se edita; la recepción tiene su
propio endpoint.

## API (`/api/orders`)

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/` `?status=` | Lista con totales (líneas, packs, total estimado) |
| GET | `/catalog` | Unidades de compra (packs + SKUs sueltos) con stock, depósito, alerta, sugerido, precio, código, último pedido, pendiente |
| GET/PUT | `/settings` | Descuentos por defecto |
| POST | `/` | Crea borrador vacío (descuentos por defecto) |
| GET | `/:id` | Pedido + líneas (refresca precios "de Precios" si es borrador) |
| PUT | `/:id` | Guarda borrador (nombre, nota, descuentos, líneas). 409 si no es borrador |
| POST | `/:id/place` | Borrador → pendiente; corre el corte de alertas |
| PUT | `/:id/receive` | Guarda `received_qty` por línea; con `close: true` → recibido (+ `partial`) |
| POST | `/:id/duplicate` | `{ mode: 'all'|'missing', status?: 'borrador'|'pendiente' }` → pedido nuevo |
| DELETE | `/:id` | Borra un borrador |

## Código

- Backend: `db.js` (tablas + CRUD), `services/ordersService.js` (catálogo — reusa
  `getRestockList`, `buildStockBySku`, `listPacks`, mapeos de Precios —; totales y duplicado, con
  helpers puros testeables), `routes/orders.js`.
- Frontend: `core/services/orders.service.ts`, `pages/pedidos/` (lista + editor + hoja de fábrica),
  ruta `/pedidos` y `/pedidos/:id`, ítem de menú. Alertas: se saca la pestaña "Para reponer".

## Tests

`backend/test/ordersService.test.js` (código/descr./precio por pack y suelto, sugerido en packs,
totales con descuentos encadenados, faltantes al duplicar), `backend/test/routesOrders.test.js`
(validaciones, transiciones de estado, 409s). Front: `orders.service.spec.ts` + spec del editor
(totales, precio editado/revertir, armado de la hoja).
