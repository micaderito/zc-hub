/**
 * Descripción de Tienda Nube: TN renderiza `description` como HTML en la vitrina. El textarea del
 * front ("admite HTML") deja escribir texto plano O HTML a mano; si se manda texto plano tal cual,
 * los saltos de línea y párrafos se pierden (queda todo corrido en un solo bloque).
 *
 * `plainTextToHtml` detecta si el texto YA trae marcado y, si no, lo convierte: doble salto de
 * línea = nuevo párrafo, salto simple = <br>. Nunca toca un texto que ya viene con tags (lo que
 * escribió alguien a mano se respeta tal cual, sin doble-escapar).
 */

/** true si el texto ya contiene una etiqueta HTML reconocible (no queremos volver a envolverlo). */
function looksLikeHtml(text) {
  return /<\s*(p|br|div|ul|ol|li|strong|em|b|i|span|h[1-6]|a)\b/i.test(text);
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Convierte texto plano a HTML con párrafos y saltos de línea; deja pasar el HTML existente. */
export function plainTextToHtml(text) {
  const raw = String(text || '');
  if (!raw.trim()) return '';
  if (looksLikeHtml(raw)) return raw;
  return raw
    .split(/\n{2,}/) // doble salto = párrafo nuevo
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`) // salto simple = <br>
    .join('');
}

/**
 * Descripción de Mercado Libre: solo texto plano, y ML rechaza la que trae emojis o HTML (su propio
 * editor lo avisa: "no podés usar HTML ni emojis"). Un símbolo pegado sin querer (✔, ♥, 📒) o un
 * carácter invisible alcanza para que el ítem quede SIN descripción. Esto limpia lo que ML no acepta
 * y deja todo lo demás igual.
 *
 * - Emojis/pictogramas (`Extended_Pictographic`), salvo © ® ™, que son texto común en productos.
 * - Selectores de variante, unión de emojis y caracteres de ancho cero.
 * - Etiquetas HTML: <br> y cierres de bloque pasan a salto de línea, el resto se quita; entidades
 *   básicas se decodifican. Un "<" suelto ("< 21 cm") no es una etiqueta y se deja.
 */
const ML_KEEP_SYMBOLS = new Set(['©', '®', '™']);
const ML_INVISIBLES = /[︀-️​-‏⁠﻿⃣]/g;

export function toMlPlainText(text) {
  let out = String(text || '').replace(/\r\n?/g, '\n');
  if (/<\/?[a-z][^>]*>/i.test(out)) {
    out = out
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
      .replace(/<\/?[a-z][^>]*>/gi, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  }
  out = out
    .replace(/\p{Extended_Pictographic}/gu, (c) => (ML_KEEP_SYMBOLS.has(c) ? c : ''))
    .replace(ML_INVISIBLES, '')
    .replace(/ /g, ' ');
  return out
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
