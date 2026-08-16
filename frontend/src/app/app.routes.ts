import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./pages/dashboard/dashboard.component').then(m => m.DashboardComponent) },
  { path: 'conflictos', loadComponent: () => import('./pages/conflicts/conflicts.component').then(m => m.ConflictsComponent) },
  { path: 'precio-stock', loadComponent: () => import('./pages/precio-stock/precio-stock.component').then(m => m.PrecioStockComponent) },
  { path: 'precios', loadComponent: () => import('./pages/precios/precios.component').then(m => m.PreciosComponent) },
  { path: 'deposito', loadComponent: () => import('./pages/deposito/deposito.component').then(m => m.DepositoComponent) },
  { path: 'crear', loadComponent: () => import('./pages/crear-producto/crear-producto.component').then(m => m.CrearProductoComponent) },
  { path: 'alertas', loadComponent: () => import('./pages/alertas/alertas.component').then(m => m.AlertasComponent) },
  { path: 'sincronizacion', loadComponent: () => import('./pages/sync/sync.component').then(m => m.SyncComponent) }
];
