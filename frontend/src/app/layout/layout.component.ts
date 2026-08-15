import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { SessionService } from '../core/services/session.service';
import { ThemeService } from '../core/services/theme.service';

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
  imports: [RouterOutlet, RouterLink, RouterLinkActive, FormsModule],
  templateUrl: './layout.component.html',
  styleUrl: './layout.component.scss'
})
export class LayoutComponent {
  private readonly router = inject(Router);
  readonly session = inject(SessionService);
  readonly theme = inject(ThemeService);
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
    { path: '/conflictos', label: 'Conflictos', icon: 'ti-alert-triangle' },
    { path: '/sincronizacion', label: 'Sincronización', icon: 'ti-refresh' },
    { path: '/usuarios', label: 'Usuarios', icon: 'ti-users' }
  ];
}
