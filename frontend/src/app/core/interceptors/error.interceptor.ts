import { inject } from '@angular/core';
import { HttpRequest, HttpHandlerFn, HttpErrorResponse } from '@angular/common/http';
import { catchError, throwError } from 'rxjs';
import { GlobalErrorService } from '../services/global-error.service';

function getErrorMessage(err: HttpErrorResponse): string {
  if (typeof err?.error === 'string') return err.error;
  const body = err?.error;
  if (body && typeof body === 'object') {
    if (body.error && typeof body.error === 'string') return body.error;
    if (body.message && typeof body.message === 'string') return body.message;
  }
  if (err?.message) return err.message;
  if (err?.status === 0) return 'No se pudo conectar. ¿Está corriendo el backend?';
  if (err?.status) return `Error ${err.status}: ${err.statusText || 'Error en la solicitud'}`;
  return 'Error de conexión';
}

export function errorInterceptor(req: HttpRequest<unknown>, next: HttpHandlerFn) {
  const globalError = inject(GlobalErrorService);
  return next(req).pipe(
    catchError((err: HttpErrorResponse) => {
      globalError.show(getErrorMessage(err));
      return throwError(() => err);
    })
  );
}
