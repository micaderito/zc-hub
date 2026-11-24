import { inject } from '@angular/core';
import { HttpHandlerFn, HttpRequest } from '@angular/common/http';
import { ApiService } from '../services/api.service';

/**
 * Los pedidos a la API no pasan por el service worker de la PWA (`ngsw-bypass`).
 *
 * El SW no cachea la API (`ngsw-config.json` no tiene `dataGroups`), así que no aporta nada, y
 * cuando un `fetch` se corta (se cayó la red, iOS pasó la app a segundo plano, un error del backend
 * sin CORS) el SW lo cambia por una respuesta falsa `504 Gateway Timeout` que tapa el error real.
 * Sin el SW en el medio, la consola y el `errorInterceptor` ven lo que pasó de verdad.
 */
export function ngswBypassInterceptor(req: HttpRequest<unknown>, next: HttpHandlerFn) {
  const base = inject(ApiService).baseUrl;
  if (!base || !req.url.startsWith(base)) return next(req);
  return next(req.clone({ setHeaders: { 'ngsw-bypass': 'true' } }));
}
