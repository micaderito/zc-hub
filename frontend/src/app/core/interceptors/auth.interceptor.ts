import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { HttpRequest, HttpHandlerFn, HttpErrorResponse } from '@angular/common/http';
import { catchError, throwError } from 'rxjs';
import { SessionService } from '../services/session.service';

/**
 * Agrega `Authorization: Bearer <token>` a cada request y, ante un 401 (sesión inválida/vencida o
 * usuario desactivado), limpia la sesión local y manda a /login. Va PRIMERO en la cadena de
 * interceptores (antes de errorInterceptor) para que el token esté puesto antes de que cualquier
 * otro interceptor mire la respuesta.
 */
export function authInterceptor(req: HttpRequest<unknown>, next: HttpHandlerFn) {
  const session = inject(SessionService);
  const router = inject(Router);

  const token = session.token();
  const authReq = token ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req;

  return next(authReq).pipe(
    catchError((err: HttpErrorResponse) => {
      if (err.status === 401) {
        session.clear();
        router.navigate(['/login']);
      }
      return throwError(() => err);
    })
  );
}
