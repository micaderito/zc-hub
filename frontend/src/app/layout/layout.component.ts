import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { injectQuery } from '@tanstack/angular-query-experimental';
import { SessionService } from '../core/services/session.service';
import { ThemeService } from '../core/services/theme.service';
import { AlertsService, ALERTS_NOTIFICATIONS_QUERY_KEY, StockNotification } from '../core/services/alerts.service';

interface NavItem {
  path: string;
  label: string;
  icon: string;
  exact?: boolean;
}

/**
 * Shell de la app (sidebar + contenido), separado de AppComponent para que /login pueda existir
 * como una ruta sin sidebar detrás. Antes de este cambio el sidebar vivía directo en AppComponent.
 */
@Component({
  selector: 'app-layout',
  standalone: true,
  imports: [CommonModule, RouterOutlet, RouterLink, RouterLinkActive, FormsModule],
  templateUrl: './layout.component.html',
  styleUrl: './layout.component.scss'
})
export class LayoutComponent {
  private readonly router = inject(Router);
  readonly session = inject(SessionService);
  readonly theme = inject(ThemeService);
  private readonly alerts = inject(AlertsService);
  readonly collapsed = signal(false);

  toggleSidebar() {
    this.collapsed.update(v => !v);
  }

  logout() {
    this.session.logout();
    this.router.navigate(['/login']);
  }

  // ── Cambiar mi contraseña (modal disparado desde el chip de usuario) ──
  readonly showPasswordModal = signal(false);
  readonly currentPassword = signal('');
  readonly newPassword = signal('');
  readonly newPasswordRepeat = signal('');
  readonly passwordSaving = signal(false);
  readonly passwordError = signal<string | null>(null);

  openPasswordModal(): void {
    this.currentPassword.set('');
    this.newPassword.set('');
    this.newPasswordRepeat.set('');
    this.passwordError.set(null);
    this.showPasswordModal.set(true);
  }

  async savePassword(): Promise<void> {
    if (this.newPassword().length < 8) {
      this.passwordError.set('La contraseña nueva debe tener al menos 8 caracteres');
      return;
    }
    if (this.newPassword() !== this.newPasswordRepeat()) {
      this.passwordError.set('Las contraseñas no coinciden');
      return;
    }
    this.passwordSaving.set(true);
    this.passwordError.set(null);
    try {
      await this.session.changePassword(this.currentPassword(), this.newPassword());
      this.showPasswordModal.set(false);
    } catch (e) {
      this.passwordError.set((e as { error?: { error?: string } })?.error?.error ?? 'No se pudo cambiar la contraseña');
    } finally {
      this.passwordSaving.set(false);
    }
  }

  readonly userInitials = computed(() => {
    const name = this.session.user()?.displayName || this.session.user()?.username || '';
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  });

  readonly nav: NavItem[] = [
    { path: '/', label: 'Inicio', icon: 'ti-layout-dashboard', exact: true },
    { path: '/precio-stock', label: 'Productos', icon: 'ti-box' },
    { path: '/precios', label: 'Precios', icon: 'ti-tag' },
    { path: '/deposito', label: 'Depósito Marañón', icon: 'ti-building-warehouse' },
    { path: '/crear', label: 'Crear producto', icon: 'ti-plus' },
    { path: '/alertas', label: 'Alertas', icon: 'ti-bell' },
    { path: '/ventas', label: 'Ventas', icon: 'ti-map-pin' },
    { path: '/conflictos', label: 'Conflictos', icon: 'ti-alert-triangle' },
    { path: '/sincronizacion', label: 'Sincronización', icon: 'ti-refresh' },
    { path: '/usuarios', label: 'Usuarios', icon: 'ti-users' }
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
