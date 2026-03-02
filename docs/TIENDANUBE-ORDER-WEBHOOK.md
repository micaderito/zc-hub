# Tienda Nube: webhook de orden y campos que usamos

Documentación oficial: [Order](https://tiendanube.github.io/api-documentation/resources/order), [Webhook](https://tiendanube.github.io/api-documentation/resources/webhook).

---

## 1. Qué envía el webhook (POST a nuestra URL)

Para eventos `order/paid` y `order/cancelled`, TN envía un JSON con:

| Campo     | Descripción |
|----------|-------------|
| `event`  | Ej: `"order/paid"` o `"order/cancelled"` |
| `store_id` | ID de la tienda |
| `id`     | **ID de la orden** (numérico, ej: `871254203`) |

Solo viene el **id de la orden**; no vienen los ítems. Por eso hacemos después `GET /orders/{id}` para obtener la orden completa.

---

## 2. Qué devuelve GET /orders/{id}

### Orden (nivel raíz)

| Propiedad | Descripción |
|-----------|-------------|
| **id** | Identificador único numérico de la orden (ej: `871254203`). **No es el “número” que ve el dueño de la tienda.** |
| **number** | Número de orden que ve el dueño y el cliente: secuencial, arranca en 100 (ej: `306`). Es el “Nº de venta” en TN. |
| **products** | Lista de productos/variantes comprados (ver abajo). |

### Cada ítem en `order.products[]`

| Propiedad   | Descripción |
|------------|-------------|
| **id** | ID del **line item** (identifica esta línea dentro de la orden). No es el product_id ni el variant_id. |
| **product_id** | ID del producto. |
| **variant_id** | ID de la variante comprada (puede venir como string, ej: `"426215948"`). |
| **name** | Nombre del producto al momento de la compra. |
| **quantity** | Cantidad. |
| **sku** | SKU (si existe). |

Ejemplo de un ítem en la respuesta:

```json
{
  "id": 1069053829,
  "product_id": 111334785,
  "variant_id": "426215948",
  "name": "Mesa de Roble",
  "quantity": "1",
  "sku": "12389012348124801234890"
}
```

---

## Diferencia: product_id, variant_id, SKU y sale_item_id

| En TN / nuestro sistema | Qué es |
|-------------------------|--------|
| **product_id** | ID del **producto** en TN (ej. 111334785). Un producto puede tener varias variantes (talle M, L, color rojo, etc.). |
| **variant_id** | ID de la **variante** en TN (ej. 426215948). Una variante = una combinación concreta (ej. “Mesa de Roble – Color Negro”). Es lo que se compró en esa línea. |
| **sku** (columna en nuestra tabla) | Código que **vos** usás para stock (ej. `MESA-ROBLE-NEGRO`). Lo definís en Conflictos y lo usamos para descontar en ML/TN. Viene en `order.products[].sku` pero nosotros ya lo resolvemos por variante. |
| **sale_item_id** (columna en nuestra tabla) | Identificador del **ítem en esa venta** para poder buscarlo y reconocer la línea. Para TN usamos `product_id:variant_id` (ej. `"111334785:426215948"`). Así identificamos exactamente qué variante se vendió; solo product_id no alcanza si el producto tiene varias variantes. |

El **SKU no es** product_id ni variant_id: el SKU es vuestro código de stock; product_id y variant_id son IDs internos de TN. Por eso **sale_item_id** = `product_id:variant_id` está bien: es el “id del ítem” de la venta (producto + variante), no el SKU.

---

## 3. Cómo lo mapeamos nosotros

| Nuestro campo   | Origen en TN | ¿OK? |
|-----------------|--------------|------|
| **order_id** (Nº venta) | `order.number` (ej: `306`) — número secuencial que ve el dueño y el cliente | ✅ Guardamos este valor para que coincida con el “Nº de venta” que se ve en TN. |
| **sale_item_id** (Id. ítem) | `product_id:variant_id` del ítem, o solo `variant_id` si no hay `product_id` (ej: `"111334785:426215948"`) | ✅ Coincide con la doc: usamos `product_id` y `variant_id` de cada elemento de `order.products[]`. |

En el código usamos:

- **order_id**: después de `GET /orders/{id}`, usamos `order.number` (número secuencial tipo 306). Si no viene, fallback a `order.id` o al `id` del webhook.
- `variantId = item.variant_id ?? item.id` → priorizamos `variant_id`; si no viene, usamos el `id` del line item.
- `saleItemId = productId != null ? \`${productId}:${variantId}\` : String(variantId)` → `product_id:variant_id` o solo `variant_id`.

La idempotencia (evitar procesar dos veces la misma orden) sigue usando el `id` interno de la orden en `tryClaimOrderProcessing`.
