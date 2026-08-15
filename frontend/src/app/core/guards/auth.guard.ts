import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { SessionService } from '../services/session.service';

/**
 * Bloquea las rutas del shell si no hay sesión. La restauración de la sesión (SessionService.restore)
 * ya corrió como APP_INITIALIZER antes de que el router resuelva la primera ruta, así que acá
 * alcanza con mirar el signal.
 */
export const authGuard: CanActivateFn = () => {
  const session = inject(SessionService);
  const router = inject(Router);
  if (session.isAuthenticated()) return true;
  return router.createUrlTree(['/login']);
};
