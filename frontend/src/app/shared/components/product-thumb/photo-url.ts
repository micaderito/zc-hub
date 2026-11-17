/**
 * Versión grande de una foto para el zoom. Las de ML vienen como `secure_thumbnail` (`…-I.jpg`,
 * chica): el sufijo `-O` es la original (inverso de `mlThumbFromUrl` en dispatchService). Solo toca
 * URLs de `mlstatic.com`; las de TN y Supabase ya son la foto entera.
 */
export function largePhotoUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (!/mlstatic\.com\//i.test(url)) return url;
  return url.replace(/-[A-Z]\.(jpg|jpeg|png|webp)$/i, '-O.$1');
}
