import { inject } from '@angular/core';
import { HttpRequest, HttpHandlerFn, HttpErrorResponse } from '@angular/common/http';
import { catchError, retry, throwError, timer } from 'rxjs';
import { GlobalErrorService } from '../services/global-error.service';

/**
 * Espera antes de cada reintento ante una falla de red (status 0). Un status 0 casi nunca es el
 * backend caído: es Chrome cortando el request porque cambió la red (`ERR_NETWORK_CHANGED`), la
 * pestaña volvió de estar congelada (`ERR_NETWORK_IO_SUSPENDED`) o el DNS todavía no respondía.
 * Se arregla solo en un par de segundos, así que el cartel recién aparece si fallan todos.
 */
export const NETWORK_RETRY_DELAYS_MS = [1000, 2000, 4000];

/** Solo se reintentan lecturas: un POST/PUT cortado pudo haber llegado al server igual. */
const RETRYABLE_METHODS = new Set(['GET', 'HEAD']);

function getErrorMessage(err: HttpErrorResponse): string {
  if (typeof err?.error === 'string') return err.error;
  const body = err?.error;
  if (body && typeof body === 'object') {
    if (body.error && typeof body.error === 'string') return body.error;
    if (body.message && typeof body.message === 'string') return body.message;
  }
  // HttpErrorResponse siempre trae un .message autogenerado (texto técnico en inglés), así que
  // se prioriza un mensaje sintetizado a partir del status antes de caer en él.
  if (err?.status === 0) return 'No se pudo conectar con el servidor. Revisá tu conexión a internet.';
  if (err?.status) return `Error ${err.status}: ${err.statusText || 'Error en la solicitud'}`;
  if (err?.message) return err.message;
  return 'Error de conexión';
}

export function errorInterceptor(req: HttpRequest<unknown>, next: HttpHandlerFn) {
  const globalError = inject(GlobalErrorService);
  const canRetry = RETRYABLE_METHODS.has(req.method);
  return next(req).pipe(
    retry({
      count: canRetry ? NETWORK_RETRY_DELAYS_MS.length : 0,
      delay: (err: HttpErrorResponse, attempt: number) =>
        err.status === 0 ? timer(NETWORK_RETRY_DELAYS_MS[attempt - 1]) : throwError(() => err)
    }),
    catchError((err: HttpErrorResponse) => {
      // El 401 ya lo maneja authInterceptor (limpia la sesión y manda a /login) — mostrar acá
      // además un banner "Error 401" quedaría colgado encima de la pantalla de login.
      if (err.status !== 401) globalError.show(getErrorMessage(err));
      return throwError(() => err);
    })
  );
}
