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
 *
 * La miniatura se pinta en cajas de 40 px (grilla por variante) y 84 px (galería), así que 320 px
 * ya cubre pantallas HiDPI de sobra. Antes eran 400 px: cada `<img>` sostenía ~625 KB de bitmap
 * decodificado y, repetido por variante, era lo que llenaba la memoria y hacía que el navegador
 * descartara y volviera a decodificar las imágenes al scrollear.
 */
const MAX_SIDE = 320;
const JPEG_QUALITY = 0.8;

addEventListener('message', async (ev: MessageEvent<{ id: number; file: File }>) => {
  const { id, file } = ev.data;
  try {
    // resizeWidth decodifica DIRECTO al tamaño destino en vez de rasterizar la foto entera y
    // después escalarla, que es donde está el pico de memoria del worker. Si el navegador no lo
    // soporta, el bitmap sale a tamaño completo y el escalado de abajo lo resuelve igual.
    const bitmap = await createImageBitmap(file, { resizeWidth: MAX_SIDE, resizeQuality: 'medium' }).catch(
      () => createImageBitmap(file)
    );
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
