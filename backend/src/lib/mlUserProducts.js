/**
 * Detección del modelo de publicación de la cuenta ML: User Products (PxV) vs Legacy.
 *
 * Desde que ML activó el tag `user_product_seller`, `POST /items` YA NO acepta el array
 * `variations[]` (400: "The field variations is invalid with family name") ni que el vendedor
 * mande `title` — hay que mandar `family_name` y crear un ítem POR VARIACIÓN; ML los agrupa en una
 * familia por family_name + domain_id + condition + atributos PARENT_PK. Ver CLAUDE.md (sección de
 * precio por variación) y https://developers.mercadolibre.com.ar/en_us/price-per-variation.
 *
 * No se hardcodea: se consulta `GET /users/me` (ya usado para otras cosas, `getMe`) y se cachea en
 * memoria un rato corto, porque no cambia de un request a otro y consultarlo en cada publicación
 * sería un round-trip extra sin necesidad.
 */
import { getMe } from './mercadolibre.js';

const CACHE_MS = 60 * 60 * 1000; // 1 h: alcanza para no repetir el request en la misma sesión de uso.
let cached = null; // { value: boolean, at: number }

/** true si la cuenta ya está en el modelo User Products (tag `user_product_seller`). */
export async function isUserProductSeller(accessToken) {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const me = await getMe(accessToken);
  const value = Array.isArray(me?.tags) && me.tags.includes('user_product_seller');
  cached = { value, at: Date.now() };
  return value;
}

/** Solo para tests: fuerza el valor cacheado o lo limpia (pasando null). */
export function __setCacheForTests(value) {
  cached = value == null ? null : { value, at: Date.now() };
}
