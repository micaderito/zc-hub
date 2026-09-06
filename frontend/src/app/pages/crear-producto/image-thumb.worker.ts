/// <reference lib="webworker" />

/**
 * Genera una miniatura liviana de una foto SIN tocar el hilo principal.
 *
 * El original se sube tal cual al canal (ver `catalog.service.ts#uploadImageFile`); esta
 * miniatura es SOLO para el `<img src>` de la galería y de la grilla "fotos por variante"
 * (crear-producto.component.html). Antes se usaba el data URL completo como preview: con fotos de
 * varios MB, el navegador decodificaba y rasterizaba la imagen a resolución completa para
 * mostrarla en una caja de 40-84px, muchas veces (una por variante) — eso era gran parte del
 * scroll/tipeo trabado al cargar varias fotos.
 *
 * `createImageBitmap` decodifica y reescala en un paso (más barato que <img> + canvas), y todo
 * esto corre en un worker: nunca bloquea el hilo principal. Si el navegador no soporta
 * OffscreenCanvas/Worker módulos, el componente cae a un fallback sin worker (ver
 * `crear-producto.component.ts#makeThumb`).
 */
const MAX_SIDE = 400;
const JPEG_QUALITY = 0.8;

addEventListener('message', async (ev: MessageEvent<{ id: string; file: File }>) => {
  const { id, file } = ev.data;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Sin contexto 2D');
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    postMessage({ id, blob });
  } catch (e) {
    postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
});
