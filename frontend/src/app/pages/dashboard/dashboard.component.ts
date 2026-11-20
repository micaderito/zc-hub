import { Component, HostListener, inject, OnInit, OnDestroy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, NavigationEnd } from '@angular/router';
import { filter } from 'rxjs/operators';
import { AuthService, AuthStatus } from '../../core/services/auth.service';
import { SyncService } from '../../core/services/sync.service';
import { SessionService } from '../../core/services/session.service';
import { CanWriteDirective } from '../../shared/directives/can-write.directive';
import { BottomSheetComponent } from '../../shared/components/bottom-sheet/bottom-sheet.component';
import { mediaSignal, PHONE_QUERY } from '../../shared/utils/media-signal';

export type ChannelKey = 'ml' | 'tn';
export type ChannelState = 'ok' | 'expired' | 'off';

/** Un canal tal como lo muestra la lista del celular. */
export interface ChannelView {
  key: ChannelKey;
  name: string;
  state: ChannelState;
}

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CanWriteDirective, CommonModule, BottomSheetComponent],
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss', './dashboard-phone.scss']
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
  readonly session = inject(SessionService);

  /** En el celular: lista tipo Ajustes (un canal por fila) y hojas; el escritorio no cambia. */
  readonly phone = mediaSignal(PHONE_QUERY);
  /** Hoja abierta en el celular: un canal conectado o "Sincronizar precios". */
  readonly sheet = signal<ChannelKey | 'sync' | null>(null);
  /** Desconectar pide confirmar en la hoja: se corta la sincronización de stock. */
  readonly confirmDisconnect = signal(false);

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

  /**
   * Volver a la app (pestaña visible / ventana con foco) relee el estado del servidor.
   * En la PWA instalada de iOS el OAuth puede terminar en Safari o en una hoja aparte y la app
   * nunca recibe el redirect con `?ml_connected`: el estado del backend es la fuente de verdad.
   * `focus` y `visibilitychange` suelen llegar juntos: se ignora el segundo si fue hace < 1 s.
   */
  @HostListener('document:visibilitychange')
  @HostListener('window:focus')
  onAppVisible() {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const now = Date.now();
    if (now - this.lastVisibleRefresh < 1000) return;
    this.lastVisibleRefresh = now;
    this.loadStatus(true);
  }
  private lastVisibleRefresh = 0;

  /** `silent`: con un estado ya cargado no muestra "Cargando…" (refresco al volver a la app). */
  loadStatus(silent = false) {
    this.loading = !(silent && this.status);
    this.auth.getStatus().subscribe({
      next: s => {
        this.status = s;
        this.loading = false;
      },
      error: () => {
        this.loading = false;
        this.error = 'No se pudo conectar con el backend. Revisá que la URL del backend esté bien configurada y que el servicio esté en línea.';
      }
    });
  }

  channels(): ChannelView[] {
    const s = this.status;
    if (!s) return [];
    const state = (on: boolean, expired?: boolean): ChannelState => (on ? 'ok' : expired ? 'expired' : 'off');
    return [
      { key: 'ml', name: 'Mercado Libre', state: state(s.mercadolibre, s.mercadolibreExpired) },
      { key: 'tn', name: 'Tienda Nube', state: state(s.tiendanube, s.tiendanubeExpired) },
    ];
  }

  channel(key: ChannelKey): ChannelView | undefined {
    return this.channels().find(c => c.key === key);
  }

  openSheet(key: ChannelKey | 'sync') {
    this.confirmDisconnect.set(false);
    this.sheet.set(key);
  }

  closeSheet() {
    this.sheet.set(null);
    this.confirmDisconnect.set(false);
  }

  connect(key: ChannelKey) {
    if (key === 'ml') this.connectML(); else this.connectTN();
  }

  reconnect(key: ChannelKey) {
    if (key === 'ml') this.reconnectML(); else this.reconnectTN();
  }

  disconnect(key: ChannelKey) {
    this.closeSheet();
    if (key === 'ml') this.disconnectML(); else this.disconnectTN();
  }

  isDisconnecting(key: ChannelKey): boolean {
    return key === 'ml' ? this.disconnectingML : this.disconnectingTN;
  }

  connectML() {
    this.auth.getMercadoLibreAuthUrl().subscribe({
      next: r => window.location.href = r.url,
      error: e => this.error = e.error?.error || e.message
    });
  }

  reconnectML() {
    this.error = null;
    this.auth.disconnectMercadoLibre().subscribe({
      next: () => this.connectML(),
      error: e => this.error = e.error?.error || e.message || 'Error al desconectar para reconectar'
    });
  }

  connectTN() {
    this.auth.getTiendaNubeAuthUrl().subscribe({
      next: r => window.location.href = r.url,
      error: e => this.error = e.error?.error || e.message
    });
  }

  reconnectTN() {
    this.error = null;
    this.auth.disconnectTiendaNube().subscribe({
      next: () => this.connectTN(),
      error: e => this.error = e.error?.error || e.message || 'Error al desconectar para reconectar'
    });
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
