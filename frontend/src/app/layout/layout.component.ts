import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs/operators';
import { injectQuery } from '@tanstack/angular-query-experimental';
import { SessionService } from '../core/services/session.service';
import { ThemeService } from '../core/services/theme.service';
import { AlertsService, ALERTS_NOTIFICATIONS_QUERY_KEY, StockNotification } from '../core/services/alerts.service';

interface NavItem {
  path: string;
  label: string;
  icon: string;
  /** Para accesos directos a una pestaña (ej. Devoluciones = /sincronizacion?tab=devoluciones). */
  queryParams?: Record<string, string>;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

const CONFIG_OPEN_KEY = 'zc-sidebar-config-open';

/**
 * Shell de la app (sidebar + contenido), separado de AppComponent para que /login pueda existir
 * como una ruta sin sidebar detrás. Antes de este cambio el sidebar vivía directo en AppComponent.
 */
@Component({
  selector: 'app-layout',
  standalone: true,
  imports: [CommonModule, RouterOutlet, RouterLink, FormsModule],
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

  /** Menú agrupado por tarea: arriba lo del día a día, abajo (plegado) lo técnico. */
  readonly sections: NavSection[] = [
    {
      title: 'Día a día',
      items: [
        { path: '/despachos', label: 'Para preparar', icon: 'ti-package' },
        { path: '/sincronizacion', label: 'Devoluciones', icon: 'ti-arrow-back-up', queryParams: { tab: 'devoluciones' } },
        { path: '/alertas', label: 'Alertas de stock', icon: 'ti-bell' }
      ]
    },
    {
      title: 'Catálogo',
      items: [
        { path: '/precio-stock', label: 'Productos', icon: 'ti-box' },
        { path: '/precios', label: 'Actualizar precios', icon: 'ti-tag' },
        { path: '/crear', label: 'Crear producto', icon: 'ti-plus' },
        { path: '/publicaciones', label: 'Publicaciones', icon: 'ti-rocket' }
      ]
    },
    {
      title: 'Compras',
      items: [
        { path: '/pedidos', label: 'Pedidos al proveedor', icon: 'ti-clipboard-list' },
        { path: '/deposito', label: 'Depósito', icon: 'ti-building-warehouse' }
      ]
    },
    {
      title: 'Informes',
      items: [{ path: '/ventas', label: 'Ventas por provincia', icon: 'ti-chart-bar' }]
    }
  ];

  readonly configSection: NavSection = {
    title: 'Configuración',
    items: [
      { path: '/conexiones', label: 'Conexiones', icon: 'ti-plug' },
      { path: '/conflictos', label: 'Vincular SKUs', icon: 'ti-arrows-exchange-2' },
      { path: '/sincronizacion', label: 'Historial y cola', icon: 'ti-history' },
      { path: '/usuarios', label: 'Usuarios', icon: 'ti-users' }
    ]
  };

  /** Todos los ítems, en orden de aparición. */
  readonly nav: NavItem[] = [...this.sections, this.configSection].flatMap(s => s.items);

  private readonly currentUrl = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map(e => e.urlAfterRedirects)
    ),
    { initialValue: this.router.url }
  );

  /**
   * El ítem activo. No alcanza con routerLinkActive: "Devoluciones" e "Historial y cola" comparten
   * ruta y se distinguen por `?tab=`, así que gana el ítem con query params que coincidan y, si
   * ninguno coincide, el que no tiene. `paths: 'subset'` para que /pedidos/12 marque Pedidos.
   */
  readonly activeItem = computed<NavItem | null>(() => {
    this.currentUrl();
    const matches = (item: NavItem) =>
      this.router.isActive(this.router.createUrlTree([item.path], { queryParams: item.queryParams }), {
        paths: 'subset',
        queryParams: item.queryParams ? 'subset' : 'ignored',
        fragment: 'ignored',
        matrixParams: 'ignored'
      });
    const hits = this.nav.filter(matches);
    return hits.find(i => i.queryParams) ?? hits[0] ?? null;
  });

  // Configuración arranca plegada; se recuerda si la usuaria la dejó abierta.
  private readonly configOpenPref = signal(this.readConfigOpen());
  readonly configOpen = computed(
    () => this.configOpenPref() || this.configSection.items.includes(this.activeItem() as NavItem)
  );

  toggleConfig(): void {
    const next = !this.configOpen();
    this.configOpenPref.set(next);
    try {
      localStorage.setItem(CONFIG_OPEN_KEY, next ? '1' : '0');
    } catch {
      /* sin storage: queda solo en memoria */
    }
  }

  private readConfigOpen(): boolean {
    try {
      return localStorage.getItem(CONFIG_OPEN_KEY) === '1';
    } catch {
      return false;
    }
  }

  /* ── Cajón de notificaciones ─────────────────────────────────────────────
     Vive en el shell (no en la página de Alertas) porque se abre desde
     cualquier pantalla, con un botón en el pie del sidebar. */
  readonly drawerOpen = signal(false);

  readonly notificationsQuery = injectQuery(() => ({
    queryKey: [...ALERTS_NOTIFICATIONS_QUERY_KEY, false],
    queryFn: () => this.alerts.getNotificationsPromise({ limit: 15 }),
    // Sin refetch al volver a la pestaña: el sondeo de abajo ya mantiene la campanita fresca, y
    // como el layout está montado en todas las páginas, este refetch disparaba un ciclo de
    // detección de cambios de toda la app cada vez que se volvía al navegador — carísimo en
    // páginas pesadas como crear-producto.
    refetchOnWindowFocus: false,
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
