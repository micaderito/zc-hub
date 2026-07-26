/**
 * Cliente mínimo de LLM para generar textos de SEO (Google Gemini / AI Studio).
 *
 * TN no expone ninguna API para las sugerencias de SEO que muestra su panel (son internas), así
 * que las generamos nosotros. Se configura por env:
 *   LLM_API_KEY  → key de Google AI Studio (aistudio.google.com). Tiene tier gratuito.
 *   LLM_MODEL    → id del modelo (ej. gemini-3.1-flash-lite).
 *
 * Autentica con `?key=` (query param). El header Authorization: Bearer NO sirve para estas keys.
 */

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** Límites que acepta Tienda Nube para los campos SEO. */
export const SEO_TITLE_MAX = 70;
export const SEO_DESCRIPTION_MAX = 320;
/** Cantidad de tags (etiquetas de búsqueda de TN) que pedimos generar. */
export const SEO_TAGS_MAX = 8;

export function isLlmConfigured() {
  return !!process.env.LLM_API_KEY;
}

/** Recorta un texto al máximo sin cortar una palabra por la mitad. */
function truncate(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

/** Extrae el JSON de la respuesta del modelo (puede venir envuelto en ```json … ```). */
function parseJsonFromText(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Genera { seoTitle, seoDescription } para un producto. Devuelve los textos ya recortados a los
 * límites de TN. Lanza Error con .statusCode si no está configurado o si la API falla.
 */
export async function generateSeo({ name, description, brand, category }) {
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL || 'gemini-3.1-flash-lite';
  if (!apiKey) {
    throw Object.assign(new Error('Falta LLM_API_KEY en el backend para generar SEO'), { statusCode: 503 });
  }
  if (!String(name || '').trim()) {
    throw Object.assign(new Error('Hace falta el nombre del producto para generar el SEO'), { statusCode: 400 });
  }

  const ficha = [
    `Nombre: ${name}`,
    brand ? `Marca: ${brand}` : null,
    category ? `Categoría: ${category}` : null,
    description ? `Descripción: ${description}` : null
  ]
    .filter(Boolean)
    .join('\n');

  const prompt =
    'Sos experto en SEO para e-commerce en Argentina (español rioplatense, sin voseo forzado).\n' +
    'Generá el título, la meta descripción y las etiquetas de búsqueda para este producto de una librería/papelería.\n\n' +
    `${ficha}\n\n` +
    'Reglas:\n' +
    `- seo_title: máximo ${SEO_TITLE_MAX} caracteres, incluí el producto y la marca si ayuda.\n` +
    `- seo_description: máximo ${SEO_DESCRIPTION_MAX} caracteres, atractiva y concreta, sin inventar datos técnicos que no estén en la ficha.\n` +
    `- tags: array de hasta ${SEO_TAGS_MAX} términos de búsqueda en minúscula (1 a 3 palabras cada uno), ` +
    'como los buscaría un comprador. Sin numeral, sin repetir, sin la marca sola.\n' +
    '- No uses comillas dobles dentro de los textos.\n' +
    'Respondé SOLO con JSON válido: {"seo_title":"...","seo_description":"...","tags":["...","..."]}';

  const res = await fetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, responseMimeType: 'application/json' }
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('[LLM] generateSeo → HTTP %s: %s', res.status, errText?.slice(0, 300));
    throw Object.assign(new Error(`El generador de SEO falló (HTTP ${res.status})`), { statusCode: 502 });
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const parsed = parseJsonFromText(text);
  if (!parsed) {
    throw Object.assign(new Error('El generador de SEO devolvió una respuesta inesperada'), { statusCode: 502 });
  }
  // TN guarda las tags como string separado por comas.
  const tags = Array.isArray(parsed.tags)
    ? [...new Set(parsed.tags.map((t) => String(t || '').trim().toLowerCase()).filter(Boolean))].slice(0, SEO_TAGS_MAX)
    : [];
  return {
    seoTitle: truncate(parsed.seo_title, SEO_TITLE_MAX),
    seoDescription: truncate(parsed.seo_description, SEO_DESCRIPTION_MAX),
    tags: tags.join(', ')
  };
}
