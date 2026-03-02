import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./pages/dashboard/dashboard.component').then(m => m.DashboardComponent) },
  { path: 'conflictos', loadComponent: () => import('./pages/conflicts/conflicts.component').then(m => m.ConflictsComponent) },
  { path: 'precio-stock', loadComponent: () => import('./pages/precio-stock/precio-stock.component').then(m => m.PrecioStockComponent) },
  { path: 'sincronizacion', loadComponent: () => import('./pages/sync/sync.component').then(m => m.SyncComponent) }
];
