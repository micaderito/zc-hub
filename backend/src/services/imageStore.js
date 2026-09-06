/**
 * Almacenamiento TEMPORAL de imágenes subidas desde el front antes de publicar.
 *
 * El front sube cada archivo (base64) a POST /api/products/images y recibe un `id`. Ese id viaja
 * en el draft (por canal y por variante) y, al publicar, el backend lee el archivo de acá y lo
 * sube a ML (multipart) y/o TN (base64). Así no dependemos de URLs públicas ni quedan imágenes
 * huérfanas en los canales.
 *
 * Guardado en disco bajo data/tmp-images/ (sobrevive al node --watch del dev). Cada imagen son
 * dos archivos: `<id>` (binario) y `<id>.json` (metadata: mime, filename, createdAt). Se limpian
 * al publicar (removeImage) o por TTL (purgeOld).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const DIR = path.join(process.cwd(), 'data', 'tmp-images');

/** Formatos aceptados (intersección razonable ML∩TN; ML no acepta webp, lo avisamos aparte). */
export const ALLOWED_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']);
/** Tope por archivo (ML y TN: 10 MB). */
export const MAX_BYTES = 10 * 1024 * 1024;
/**
 * TTL de limpieza de imágenes no publicadas (72 h). Hasta ahora `purgeOld()` no se llamaba desde
 * ningún lado, así que un borrador de 2 días todavía tenía sus fotos; activar la purga con el TTL
 * de 24 h le habría roto borradores que hoy funcionan.
 */
const TTL_MS = 72 * 60 * 60 * 1000;
/** Tope de la miniatura: la genera el cliente (~40 KB a 320 px); 512 KB frena cualquier abuso. */
export const MAX_THUMB_BYTES = 512 * 1024;

function ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
}

/** Quita el prefijo data:*;base64, si viene de un FileReader del browser. */
function stripDataUrl(b64) {
  const s = String(b64 || '');
  const comma = s.indexOf(',');
  return s.startsWith('data:') && comma !== -1 ? s.slice(comma + 1) : s;
}

/**
 * Guarda una imagen ya decodificada a `Buffer`. Es el paso común de `saveImage` (base64) y de la
 * subida binaria cruda (`express.raw`, ver routes/products.js) — esta última evita el costo de
 * codificar/decodificar base64 (~33% más grande) y el `JSON.stringify` de todo ese texto en el
 * cliente, que es lo que trababa la página al cargar varias fotos de una.
 * Devuelve { id, name, mime, size }. Lanza Error con .statusCode 400 si el mime no está permitido
 * o excede el tamaño.
 */
export function saveImageBuffer({ filename, mime, buffer }) {
  const type = String(mime || '').toLowerCase();
  if (!ALLOWED_MIME.has(type)) {
    throw Object.assign(new Error(`Formato no permitido: ${mime}. Usá JPG, PNG, WEBP o GIF.`), { statusCode: 400 });
  }
  if (!buffer || !buffer.length) throw Object.assign(new Error('Imagen vacía'), { statusCode: 400 });
  if (buffer.length > MAX_BYTES) {
    throw Object.assign(new Error('La imagen supera los 10 MB'), { statusCode: 400 });
  }
  ensureDir();
  const id = crypto.randomBytes(16).toString('hex');
  const name = String(filename || 'imagen').replace(/[^\w.\-]+/g, '_').slice(0, 120) || 'imagen';
  fs.writeFileSync(path.join(DIR, id), buffer);
  fs.writeFileSync(path.join(DIR, `${id}.json`), JSON.stringify({ mime: type, filename: name, createdAt: Date.now() }));
  return { id, name, mime: type, size: buffer.length };
}

/**
 * Guarda una imagen. `data` es base64 (con o sin prefijo data:). Devuelve { id, name, mime, size }.
 * Lanza Error con .statusCode 400 si el mime no está permitido o excede el tamaño.
 */
export function saveImage({ filename, mime, data }) {
  return saveImageBuffer({ filename, mime, buffer: Buffer.from(stripDataUrl(data), 'base64') });
}

/** Lee una imagen guardada. Devuelve { buffer, mime, filename } o null si no existe. */
export function getImage(id) {
  const safe = String(id || '').replace(/[^a-f0-9]/gi, '');
  if (!safe) return null;
  const bin = path.join(DIR, safe);
  const meta = path.join(DIR, `${safe}.json`);
  if (!fs.existsSync(bin) || !fs.existsSync(meta)) return null;
  try {
    const { mime, filename } = JSON.parse(fs.readFileSync(meta, 'utf8'));
    return { buffer: fs.readFileSync(bin), mime, filename };
  } catch {
    return null;
  }
}

/**
 * Guarda la MINIATURA de una imagen ya subida (la genera el cliente en un Web Worker). Se guarda
 * como un tercer archivo `<id>.thumb`, siempre JPEG.
 *
 * Existe para que restaurar un borrador no tenga que servir los originales: con 45 fotos eran
 * ~225 MB de descarga para pintarlas en cajas de 40-84 px, y eso hacía que el navegador
 * descartara la pestaña. La miniatura NUNCA se publica en ML ni en TN: `productPublish.js` usa
 * `getImage()` (el original). Solo se le sirve de vuelta a la misma usuaria como preview.
 */
export function saveThumbBuffer(id, buffer) {
  const safe = String(id || '').replace(/[^a-f0-9]/gi, '');
  const meta = safe && path.join(DIR, `${safe}.json`);
  if (!safe || !fs.existsSync(meta)) {
    throw Object.assign(new Error('La imagen no existe'), { statusCode: 404 });
  }
  if (!buffer || !buffer.length) throw Object.assign(new Error('Miniatura vacía'), { statusCode: 400 });
  if (buffer.length > MAX_THUMB_BYTES) {
    throw Object.assign(new Error('La miniatura es demasiado grande'), { statusCode: 400 });
  }
  fs.writeFileSync(path.join(DIR, `${safe}.thumb`), buffer);
  try {
    fs.writeFileSync(meta, JSON.stringify({ ...JSON.parse(fs.readFileSync(meta, 'utf8')), hasThumb: true }));
  } catch { /* el .thumb ya está en disco; el flag del meta es informativo */ }
  return { ok: true, size: buffer.length };
}

/** Lee la miniatura. Devuelve { buffer, mime } o null si esa imagen todavía no tiene una. */
export function getThumb(id) {
  const safe = String(id || '').replace(/[^a-f0-9]/gi, '');
  if (!safe) return null;
  const thumb = path.join(DIR, `${safe}.thumb`);
  if (!fs.existsSync(thumb)) return null;
  try {
    return { buffer: fs.readFileSync(thumb), mime: 'image/jpeg' };
  } catch {
    return null;
  }
}

/** Borra una imagen (binario + metadata + miniatura). No falla si no existe. */
export function removeImage(id) {
  const safe = String(id || '').replace(/[^a-f0-9]/gi, '');
  if (!safe) return;
  for (const f of [path.join(DIR, safe), path.join(DIR, `${safe}.json`), path.join(DIR, `${safe}.thumb`)]) {
    try { fs.rmSync(f, { force: true }); } catch { /* noop */ }
  }
}

/** Limpia imágenes más viejas que el TTL (llamar ocasionalmente; barato). */
export function purgeOld(now = Date.now()) {
  if (!fs.existsSync(DIR)) return 0;
  let removed = 0;
  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const { createdAt } = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      if (now - (createdAt || 0) > TTL_MS) {
        removeImage(f.replace(/\.json$/, ''));
        removed++;
      }
    } catch { /* noop */ }
  }
  return removed;
}
