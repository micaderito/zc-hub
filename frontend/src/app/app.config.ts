import { APP_INITIALIZER, ApplicationConfig, LOCALE_ID, provideZoneChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideTanStackQuery, QueryClient } from '@tanstack/angular-query-experimental';

import { routes } from './app.routes';
import { errorInterceptor } from './core/interceptors/error.interceptor';
import { authInterceptor } from './core/interceptors/auth.interceptor';
import { SessionService } from './core/services/session.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    // authInterceptor va primero: pone el header Authorization antes de que errorInterceptor
    // (o cualquier otro) mire la respuesta.
    provideHttpClient(withInterceptors([authInterceptor, errorInterceptor])),
    provideTanStackQuery(new QueryClient()),
    { provide: LOCALE_ID, useValue: 'es-AR' },
    // Restaura la sesión (valida el token guardado contra el backend) ANTES de que el router
    // resuelva la primera ruta — sin esto, un F5 rebota a /login aunque el token sea válido.
    {
      provide: APP_INITIALIZER,
      useFactory: (session: SessionService) => () => session.restore(),
      deps: [SessionService],
      multi: true
    }
  ]
};
