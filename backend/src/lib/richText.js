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
