/** Helpers puros que comparten las pestañas de Historial y cola. */

/** Mensaje de un error de HttpClient: el `{ error }` del backend, si no el de la request, si no `fallback`. */
export function errorMessage(e: unknown, fallback: string): string {
  const err = e as { error?: { error?: string }; message?: string } | null | undefined;
  return err?.error?.error || err?.message || fallback;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
}

export function channelLabel(ch: string): string {
  return ch === 'mercadolibre' ? 'Mercado Libre' : 'Tienda Nube';
}
