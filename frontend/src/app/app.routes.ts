import { inject } from '@angular/core';
import { RedirectFunction, Router, Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';

/**
 * La raíz abre "Para preparar" (lo que se hace en el día). La vuelta del OAuth de ML/TN sigue
 * llegando a `/?ml_connected=1` (lo arma el backend), así que esos query params van a Conexiones.
 */
export const homeRedirect: RedirectFunction = ({ queryParams }) => {
  const fromOAuth = ['ml_connected', 'tn_connected', 'ml_error', 'tn_error'].some(k => k in queryParams);
  // UrlTree explícito: un redirect por string no conserva los query params de la URL original.
  return fromOAuth ? inject(Router).createUrlTree(['/conexiones'], { queryParams }) : '/despachos';
};

export const routes: Routes = [
  { path: 'login', loadComponent: () => import('./pages/login/login.component').then(m => m.LoginComponent) },
  {
    path: '',
    loadComponent: () => import('./layout/layout.component').then(m => m.LayoutComponent),
    canActivate: [authGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: homeRedirect },
      { path: 'conexiones', loadComponent: () => import('./pages/dashboard/dashboard.component').then(m => m.DashboardComponent) },
      { path: 'conflictos', loadComponent: () => import('./pages/conflicts/conflicts.component').then(m => m.ConflictsComponent) },
      { path: 'precio-stock', loadComponent: () => import('./pages/precio-stock/precio-stock.component').then(m => m.PrecioStockComponent) },
      { path: 'precios', loadComponent: () => import('./pages/precios/precios.component').then(m => m.PreciosComponent) },
      { path: 'deposito', loadComponent: () => import('./pages/deposito/deposito.component').then(m => m.DepositoComponent) },
      { path: 'crear', loadComponent: () => import('./pages/crear-producto/crear-producto.component').then(m => m.CrearProductoComponent) },
      { path: 'publicaciones', loadComponent: () => import('./pages/publicaciones/publicaciones.component').then(m => m.PublicacionesComponent) },
      { path: 'alertas', loadComponent: () => import('./pages/alertas/alertas.component').then(m => m.AlertasComponent) },
      { path: 'pedidos', loadComponent: () => import('./pages/pedidos/pedidos-list.component').then(m => m.PedidosListComponent) },
      { path: 'pedidos/:id', loadComponent: () => import('./pages/pedidos/pedido-editor.component').then(m => m.PedidoEditorComponent) },
      { path: 'despachos', loadComponent: () => import('./pages/despachos/despachos.component').then(m => m.DespachosComponent) },
      { path: 'ventas', loadComponent: () => import('./pages/ventas/ventas.component').then(m => m.VentasComponent) },
      { path: 'sincronizacion', loadComponent: () => import('./pages/sync/sync.component').then(m => m.SyncComponent) },
      { path: 'usuarios', loadComponent: () => import('./pages/usuarios/usuarios.component').then(m => m.UsuariosComponent) }
    ]
  }
];
