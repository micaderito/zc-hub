/**
 * Almacenamiento de imágenes subidas desde el front antes de publicar.
 *
 * El front sube cada archivo a POST /api/products/images y recibe un `id`. Ese id viaja en el
 * draft (por canal y por variante) y, al publicar, el backend lee el archivo de acá para subirlo
 * a ML/TN — o, si hay URL pública (Supabase), se la pasa directo a la API del canal (`pictures:
 * [{source:url}]` en ML, `images:[{src,position}]` en TN) y listo, sin subir el binario de nuevo.
 *
 * Dos backends con la MISMA interfaz, elegidos automáticamente:
 *   - Supabase Storage (si están SUPABASE_URL + SUPABASE_SERVICE_KEY): sobrevive a un deploy —
 *     Railway (Hobby) tiene disco efímero, así que un deploy con imágenes en disco local borraba
 *     los borradores no publicados. Bucket público (`SUPABASE_BUCKET`, default `product-images`).
 *   - Disco local (`data/tmp-images/`): fallback para desarrollo sin credenciales de Supabase.
 *
 * Se limpia al publicar (removeImage) o por TTL (purgeOld, ver backend/src/index.js).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import fetch from 'node-fetch';

const DIR = path.join(process.cwd(), 'data', 'tmp-images');

/** Formatos aceptados (intersección razonable ML∩TN; ML no acepta webp, lo avisamos aparte). */
export const ALLOWED_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']);
/** Tope por archivo (ML y TN: 10 MB). */
export const MAX_BYTES = 10 * 1024 * 1024;
/** TTL de limpieza de imágenes no publicadas (72 h). Ver purgeOld(). */
const TTL_MS = 72 * 60 * 60 * 1000;
/** Tope de la miniatura: la genera el cliente (~40 KB a 320 px); 512 KB frena cualquier abuso. */
export const MAX_THUMB_BYTES = 512 * 1024;

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'product-images';
/** Si hay credenciales, todo el módulo opera contra Supabase Storage en vez del disco. */
const useSupabase = !!(SUPABASE_URL && SUPABASE_KEY);

function ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
}

/** Quita el prefijo data:*;base64, si viene de un FileReader del browser. */
function stripDataUrl(b64) {
  const s = String(b64 || '');
  const comma = s.indexOf(',');
  return s.startsWith('data:') && comma !== -1 ? s.slice(comma + 1) : s;
}

function extFromMime(mime) {
  const map = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
  return map[mime] || 'bin';
}

/* ============================ Backend Supabase Storage ============================ */

async function supabaseUpload(objectPath, buffer, mime) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${objectPath}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_KEY}`,
      apikey: SUPABASE_KEY,
      'Content-Type': mime || 'application/octet-stream',
      'x-upsert': 'true'
    },
    body: buffer
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase Storage upload falló: ${res.status} ${text}`);
  }
}

async function supabaseDownload(objectPath) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${objectPath}`);
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

async function supabaseRemove(objectPaths) {
  if (!objectPaths.length) return;
  try {
    await fetch(`${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${SUPABASE_KEY}`,
        apikey: SUPABASE_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prefixes: objectPaths })
    });
  } catch (e) {
    console.warn('[imageStore] no se pudo borrar de Supabase Storage:', e.message);
  }
}

function supabasePublicUrl(objectPath) {
  return `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${objectPath}`;
}

/* ============================ API pública (ambos backends) ============================ */

/**
 * Guarda una imagen ya decodificada a `Buffer`. Devuelve { id, name, mime, size }. Lanza Error
 * con .statusCode 400 si el mime no está permitido o excede el tamaño.
 */
export async function saveImageBuffer({ filename, mime, buffer }) {
  const type = String(mime || '').toLowerCase();
  if (!ALLOWED_MIME.has(type)) {
    throw Object.assign(new Error(`Formato no permitido: ${mime}. Usá JPG, PNG, WEBP o GIF.`), { statusCode: 400 });
  }
  if (!buffer || !buffer.length) throw Object.assign(new Error('Imagen vacía'), { statusCode: 400 });
  if (buffer.length > MAX_BYTES) {
    throw Object.assign(new Error('La imagen supera los 10 MB'), { statusCode: 400 });
  }
  const id = crypto.randomBytes(16).toString('hex');
  const name = String(filename || 'imagen').replace(/[^\w.\-]+/g, '_').slice(0, 120) || 'imagen';
  if (useSupabase) {
    await supabaseUpload(`${id}/original.${extFromMime(type)}`, buffer, type);
    await supabaseUpload(`${id}/meta.json`, Buffer.from(JSON.stringify({ mime: type, filename: name, createdAt: Date.now() })), 'application/json');
  } else {
    ensureDir();
    fs.writeFileSync(path.join(DIR, id), buffer);
    fs.writeFileSync(path.join(DIR, `${id}.json`), JSON.stringify({ mime: type, filename: name, createdAt: Date.now() }));
  }
  return { id, name, mime: type, size: buffer.length };
}

/** Guarda una imagen desde base64 (con o sin prefijo data:). Misma forma de retorno que saveImageBuffer. */
export async function saveImage({ filename, mime, data }) {
  return saveImageBuffer({ filename, mime, buffer: Buffer.from(stripDataUrl(data), 'base64') });
}

function safeId(id) {
  return String(id || '').replace(/[^a-f0-9]/gi, '');
}

/** Metadata cruda ({mime, filename, createdAt}) o null si no existe. Uso interno. */
async function readMeta(safe) {
  if (useSupabase) {
    const buf = await supabaseDownload(`${safe}/meta.json`);
    if (!buf) return null;
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch {
      return null;
    }
  }
  const meta = path.join(DIR, `${safe}.json`);
  if (!fs.existsSync(meta)) return null;
  try {
    return JSON.parse(fs.readFileSync(meta, 'utf8'));
  } catch {
    return null;
  }
}

/** Lee una imagen guardada. Devuelve { buffer, mime, filename } o null si no existe. */
export async function getImage(id) {
  const safe = safeId(id);
  if (!safe) return null;
  const meta = await readMeta(safe);
  if (!meta) return null;
  if (useSupabase) {
    const buffer = await supabaseDownload(`${safe}/original.${extFromMime(meta.mime)}`);
    if (!buffer) return null;
    return { buffer, mime: meta.mime, filename: meta.filename };
  }
  const bin = path.join(DIR, safe);
  if (!fs.existsSync(bin)) return null;
  return { buffer: fs.readFileSync(bin), mime: meta.mime, filename: meta.filename };
}

/**
 * URL pública de la imagen original, o null si el backend actual no puede darla (disco local sin
 * servir HTTP público). Se usa para pasarle la foto por URL a ML (`pictures:[{source}]`) y a TN
 * (`images:[{src}]`) en vez de subir el binario — con Supabase configurado, esto reemplaza
 * cientos de requests secuenciales por una sola URL por foto. Es async porque hace falta el mime
 * (leído del meta) para resolver la extensión real del archivo guardado.
 */
export async function getImageUrl(id) {
  if (!useSupabase) return null;
  const safe = safeId(id);
  if (!safe) return null;
  const meta = await readMeta(safe);
  if (!meta) return null;
  return supabasePublicUrl(`${safe}/original.${extFromMime(meta.mime)}`);
}

/**
 * Guarda la MINIATURA de una imagen ya subida (la genera el cliente en un Web Worker). Existe
 * para que restaurar un borrador no tenga que servir los originales (con 45 fotos eran ~225 MB de
 * descarga solo para pintar cajas de 40-84 px). La miniatura NUNCA se publica en ML ni en TN.
 */
export async function saveThumbBuffer(id, buffer) {
  const safe = safeId(id);
  const meta = safe && (await readMeta(safe));
  if (!safe || !meta) {
    throw Object.assign(new Error('La imagen no existe'), { statusCode: 404 });
  }
  if (!buffer || !buffer.length) throw Object.assign(new Error('Miniatura vacía'), { statusCode: 400 });
  if (buffer.length > MAX_THUMB_BYTES) {
    throw Object.assign(new Error('La miniatura es demasiado grande'), { statusCode: 400 });
  }
  if (useSupabase) {
    await supabaseUpload(`${safe}/thumb.jpg`, buffer, 'image/jpeg');
  } else {
    fs.writeFileSync(path.join(DIR, `${safe}.thumb`), buffer);
  }
  return { ok: true, size: buffer.length };
}

/** Lee la miniatura. Devuelve { buffer, mime } o null si esa imagen todavía no tiene una. */
export async function getThumb(id) {
  const safe = safeId(id);
  if (!safe) return null;
  if (useSupabase) {
    const buffer = await supabaseDownload(`${safe}/thumb.jpg`);
    return buffer ? { buffer, mime: 'image/jpeg' } : null;
  }
  const thumb = path.join(DIR, `${safe}.thumb`);
  if (!fs.existsSync(thumb)) return null;
  try {
    return { buffer: fs.readFileSync(thumb), mime: 'image/jpeg' };
  } catch {
    return null;
  }
}

/** Borra una imagen (original + metadata + miniatura). No falla si no existe. */
export async function removeImage(id) {
  const safe = safeId(id);
  if (!safe) return;
  if (useSupabase) {
    await supabaseRemove([`${safe}/original.jpg`, `${safe}/original.jpeg`, `${safe}/original.png`, `${safe}/original.webp`, `${safe}/original.gif`, `${safe}/original.bin`, `${safe}/meta.json`, `${safe}/thumb.jpg`]);
    return;
  }
  for (const f of [path.join(DIR, safe), path.join(DIR, `${safe}.json`), path.join(DIR, `${safe}.thumb`)]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* noop */
    }
  }
}

/**
 * Limpia imágenes viejas (más que el TTL) que además no estén referenciadas por ningún borrador
 * ni job de publicación vivo (`isReferenced(id)`, inyectado por el caller — ver backend/src/index.js
 * y backend/src/db.js). Sin esa condición, el TTL de 72 h borraría fotos de un borrador que la
 * usuaria dejó guardado varios días.
 */
export async function purgeOld(isReferenced, now = Date.now()) {
  if (useSupabase) return 0; // el bucket se limpia por referencia (borrado en cascada del borrador), no por TTL de disco.
  if (!fs.existsSync(DIR)) return 0;
  let removed = 0;
  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith('.json')) continue;
    const id = f.replace(/\.json$/, '');
    try {
      const { createdAt } = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      if (now - (createdAt || 0) > TTL_MS && !(await isReferenced?.(id))) {
        await removeImage(id);
        removed++;
      }
    } catch {
      /* noop */
    }
  }
  return removed;
}

/** Solo para tests: indica si el módulo está usando Supabase Storage o el disco local. */
export function __usingSupabaseForTests() {
  return useSupabase;
}
