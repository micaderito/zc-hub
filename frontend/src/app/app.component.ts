import { Component, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { injectQuery } from '@tanstack/angular-query-experimental';
import { GlobalErrorService } from './core/services/global-error.service';
import { ThemeService } from './core/services/theme.service';
import { AlertsService, ALERTS_NOTIFICATIONS_QUERY_KEY, StockNotification } from './core/services/alerts.service';

interface NavItem {
  path: string;
  label: string;
  icon: string;
  exact?: boolean;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent {
  title = 'Zona Cuaderno Hub';
  readonly globalError = inject(GlobalErrorService);
  readonly theme = inject(ThemeService);
  readonly collapsed = signal(false);
  private readonly alerts = inject(AlertsService);

  toggleSidebar() {
    this.collapsed.update(v => !v);
  }

  readonly nav: NavItem[] = [
    { path: '/', label: 'Inicio', icon: 'ti-layout-dashboard', exact: true },
    { path: '/precio-stock', label: 'Productos', icon: 'ti-box' },
    { path: '/precios', label: 'Precios', icon: 'ti-tag' },
    { path: '/crear', label: 'Crear producto', icon: 'ti-plus' },
    { path: '/alertas', label: 'Alertas', icon: 'ti-bell' },
    { path: '/conflictos', label: 'Conflictos', icon: 'ti-alert-triangle' },
    { path: '/sincronizacion', label: 'Sincronización', icon: 'ti-refresh' }
  ];

  /* ── Cajón de notificaciones ─────────────────────────────────────────────
     Vive en el shell (no en la página de Alertas) porque se abre desde
     cualquier pantalla, con un botón en el pie del sidebar. */
  readonly drawerOpen = signal(false);

  readonly notificationsQuery = injectQuery(() => ({
    queryKey: [...ALERTS_NOTIFICATIONS_QUERY_KEY, false],
    queryFn: () => this.alerts.getNotificationsPromise({ limit: 15 }),
    refetchOnWindowFocus: true,
    staleTime: 30 * 1000,
    // Sondeo liviano para que la campanita se actualice sola con ventas nuevas.
    refetchInterval: 60 * 1000,
  }));

  readonly unreadCount = computed(() => this.notificationsQuery.data()?.unreadCount ?? 0);
  readonly drawerNotifications = computed<StockNotification[]>(() => this.notificationsQuery.data()?.notifications ?? []);

  toggleDrawer(): void {
    this.drawerOpen.update(v => !v);
  }

  closeDrawer(): void {
    this.drawerOpen.set(false);
  }

  async markNotificationRead(id: number): Promise<void> {
    await this.alerts.markNotificationsRead({ ids: [id] });
  }

  async markAllNotificationsRead(): Promise<void> {
    await this.alerts.markNotificationsRead({ all: true });
  }
}
