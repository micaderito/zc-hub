import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, NavigationEnd } from '@angular/router';
import { filter } from 'rxjs/operators';
import { AuthService, AuthStatus } from '../../core/services/auth.service';
import { SyncService } from '../../core/services/sync.service';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss'
})
export class DashboardComponent implements OnInit, OnDestroy {
  status: AuthStatus | null = null;
  loading = true;
  syncing = false;
  syncResult: Record<string, { ml: boolean; tn: boolean }> | null = null;
  error: string | null = null;
  disconnectingML = false;
  disconnectingTN = false;
  private navSub: unknown;

  constructor(
    private auth: AuthService,
    private sync: SyncService,
    private router: Router
  ) {}

  ngOnInit() {
    this.checkQueryParams();
    this.loadStatus();
    this.navSub = this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd)
    ).subscribe(() => {
      if (this.router.url === '/' || this.router.url.startsWith('/?')) {
        this.loadStatus();
      }
    });
  }

  ngOnDestroy() {
    if (this.navSub && typeof (this.navSub as { unsubscribe: () => void }).unsubscribe === 'function') {
      (this.navSub as { unsubscribe: () => void }).unsubscribe();
    }
  }

  private checkQueryParams() {
    this.router.events.subscribe(() => {
      const params = this.router.parseUrl(this.router.url).queryParams;
      if (params['ml_error']) this.error = 'ML: ' + params['ml_error'];
      if (params['tn_error']) this.error = 'TN: ' + params['tn_error'];
    });
    const tree = this.router.parseUrl(this.router.url);
    if (tree.queryParams['ml_connected'] || tree.queryParams['tn_connected']) {
      this.router.navigate([], { queryParams: {}, replaceUrl: true });
      this.loadStatus();
    }
    if (tree.queryParams['ml_error']) this.error = 'Mercado Libre: ' + tree.queryParams['ml_error'];
    if (tree.queryParams['tn_error']) this.error = 'Tienda Nube: ' + tree.queryParams['tn_error'];
  }

  loadStatus() {
    this.loading = true;
    this.auth.getStatus().subscribe({
      next: s => {
        this.status = s;
        this.loading = false;
      },
      error: () => {
        this.loading = false;
        this.error = 'No se pudo conectar con el backend. ¿Está corriendo en el puerto 4000?';
      }
    });
  }

  connectML() {
    this.auth.getMercadoLibreAuthUrl().subscribe({
      next: r => window.location.href = r.url,
      error: e => this.error = e.error?.error || e.message
    });
  }

  reconnectML() {
    this.connectML();
  }

  connectTN() {
    this.auth.getTiendaNubeAuthUrl().subscribe({
      next: r => window.location.href = r.url,
      error: e => this.error = e.error?.error || e.message
    });
  }

  reconnectTN() {
    this.connectTN();
  }

  disconnectML() {
    this.disconnectingML = true;
    this.error = null;
    this.auth.disconnectMercadoLibre().subscribe({
      next: () => {
        this.disconnectingML = false;
        this.loadStatus();
      },
      error: e => {
        this.error = e.error?.error || e.message || 'Error al desconectar';
        this.disconnectingML = false;
      }
    });
  }

  disconnectTN() {
    this.disconnectingTN = true;
    this.error = null;
    this.auth.disconnectTiendaNube().subscribe({
      next: () => {
        this.disconnectingTN = false;
        this.loadStatus();
      },
      error: e => {
        this.error = e.error?.error || e.message || 'Error al desconectar';
        this.disconnectingTN = false;
      }
    });
  }

  syncAllPrices() {
    if (!this.status?.mercadolibre || !this.status?.tiendanube) {
      this.error = 'Conecta ambos canales antes de sincronizar precios.';
      return;
    }
    this.syncing = true;
    this.syncResult = null;
    this.sync.syncAllPrices().subscribe({
      next: (r: Record<string, { ml?: boolean; tn?: boolean }>) => {
        this.syncResult = r as Record<string, { ml: boolean; tn: boolean }>;
        this.syncing = false;
      },
      error: (e: { error?: { error?: string }; message?: string }) => {
        this.error = e.error?.error || e.message || 'Error al sincronizar';
        this.syncing = false;
      }
    });
  }
}
