import { DestroyRef, Signal, inject, signal } from '@angular/core';

/** Corte del celular: el mismo que `m.phone` en `styles/_mobile.scss` (barra de pestañas abajo). */
export const PHONE_QUERY = '(max-width: 760px)';

/**
 * `matchMedia` como señal (false si el entorno no lo tiene). Llamar en un contexto de inyección
 * (inicializador de campo o constructor): deja de escuchar cuando se destruye el componente.
 */
export function mediaSignal(query: string): Signal<boolean> {
  const mql = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query) : null;
  const s = signal(mql?.matches ?? false);
  if (mql) {
    const onChange = (e: MediaQueryListEvent) => s.set(e.matches);
    mql.addEventListener('change', onChange);
    inject(DestroyRef).onDestroy(() => mql.removeEventListener('change', onChange));
  }
  return s.asReadonly();
}
