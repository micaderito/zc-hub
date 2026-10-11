import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { SessionService } from '../services/session.service';

/** Páginas que solo sirven para escribir (crear producto, importar precios, usuarios): lectura vuelve al inicio. */
export const adminGuard: CanActivateFn = () => {
  const session = inject(SessionService);
  if (session.isAdmin()) return true;
  return inject(Router).createUrlTree(['/']);
};
