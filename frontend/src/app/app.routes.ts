import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';

export const routes: Routes = [
  { path: 'login', loadComponent: () => import('./pages/login/login.component').then(m => m.LoginComponent) },
  {
    path: '',
    loadComponent: () => import('./layout/layout.component').then(m => m.LayoutComponent),
    canActivate: [authGuard],
    children: [
      { path: '', loadComponent: () => import('./pages/dashboard/dashboard.component').then(m => m.DashboardComponent) },
      { path: 'conflictos', loadComponent: () => import('./pages/conflicts/conflicts.component').then(m => m.ConflictsComponent) },
      { path: 'precio-stock', loadComponent: () => import('./pages/precio-stock/precio-stock.component').then(m => m.PrecioStockComponent) },
      { path: 'precios', loadComponent: () => import('./pages/precios/precios.component').then(m => m.PreciosComponent) },
      { path: 'deposito', loadComponent: () => import('./pages/deposito/deposito.component').then(m => m.DepositoComponent) },
      { path: 'crear', loadComponent: () => import('./pages/crear-producto/crear-producto.component').then(m => m.CrearProductoComponent) },
      { path: 'alertas', loadComponent: () => import('./pages/alertas/alertas.component').then(m => m.AlertasComponent) },
      { path: 'ventas', loadComponent: () => import('./pages/ventas/ventas.component').then(m => m.VentasComponent) },
      { path: 'sincronizacion', loadComponent: () => import('./pages/sync/sync.component').then(m => m.SyncComponent) },
      { path: 'usuarios', loadComponent: () => import('./pages/usuarios/usuarios.component').then(m => m.UsuariosComponent) }
    ]
  }
];
