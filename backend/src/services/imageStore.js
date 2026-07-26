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
/** TTL de limpieza de imágenes no publicadas (24 h). */
const TTL_MS = 24 * 60 * 60 * 1000;

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
 * Guarda una imagen. `data` es base64 (con o sin prefijo data:). Devuelve { id, name, mime, size }.
 * Lanza Error con .statusCode 400 si el mime no está permitido o excede el tamaño.
 */
export function saveImage({ filename, mime, data }) {
  const type = String(mime || '').toLowerCase();
  if (!ALLOWED_MIME.has(type)) {
    throw Object.assign(new Error(`Formato no permitido: ${mime}. Usá JPG, PNG, WEBP o GIF.`), { statusCode: 400 });
  }
  const buffer = Buffer.from(stripDataUrl(data), 'base64');
  if (!buffer.length) throw Object.assign(new Error('Imagen vacía'), { statusCode: 400 });
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

/** Borra una imagen (binario + metadata). No falla si no existe. */
export function removeImage(id) {
  const safe = String(id || '').replace(/[^a-f0-9]/gi, '');
  if (!safe) return;
  for (const f of [path.join(DIR, safe), path.join(DIR, `${safe}.json`)]) {
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
