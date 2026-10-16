import { ChangeDetectionStrategy, Component, OnInit, ViewEncapsulation, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { SyncService, SyncConfig } from '../../core/services/sync.service';
import { TabsComponent, TabDef } from '../../shared/components/tabs/tabs.component';
import { SessionService } from '../../core/services/session.service';
import { CanWriteDirective } from '../../shared/directives/can-write.directive';
import { SyncStore } from './sync.store';
import { errorMessage } from './sync.utils';
import { SyncHistorialComponent } from './historial/sync-historial.component';
import { SyncDevolucionesComponent } from './devoluciones/sync-devoluciones.component';
import { SyncColaComponent } from './cola/sync-cola.component';

const TAB_KEYS = ['historial', 'devoluciones', 'cola', 'estado'];

/**
 * "Historial y cola" — página contenedora: encabezado, pestañas (con `?tab=` en la URL) y la
 * pestaña Estado (toggle de la sync + webhooks). Historial, Devoluciones y Cola ML son su propio
 * componente OnPush, montado solo mientras se ve; lo que comparten vive en SyncStore (provisto
 * acá, uno por visita).
 *
 * Sin encapsulación a propósito: sync.component.scss define la base que usan todas las pestañas
 * (botones, alertas, inputs, estado vacío) una sola vez y bajo `:where(.sync-page)` —
 * especificidad cero, así el estilo propio de cada pestaña la pisa. Mismo patrón que Precios.
 */
@Component({
  selector: 'app-sync',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  providers: [SyncStore],
  imports: [CanWriteDirective, TabsComponent, SyncHistorialComponent, SyncDevolucionesComponent, SyncColaComponent],
  templateUrl: './sync.component.html',
  styleUrl: './sync.component.scss'
})
export class SyncComponent implements OnInit {
  readonly session = inject(SessionService);
  readonly store = inject(SyncStore);
  private readonly sync = inject(SyncService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly activeTab = signal<string>('historial');

  readonly config = signal<SyncConfig | null>(null);
  readonly loading = signal(true);
  readonly savingToggle = signal(false);
  readonly error = signal<string | null>(null);

  readonly registeringWebhooks = signal(false);
  readonly webhooksResult = signal<string | null>(null);

  readonly tabs = computed<TabDef[]>(() => {
    const returns = this.store.returnsTotal();
    const failed = this.store.failedTasksCount();
    const taskCount = this.store.activeTasksCount() + failed;
    return [
      { key: 'historial', label: 'Historial' },
      {
        key: 'devoluciones',
        label: 'Devoluciones',
        ...(returns > 0 ? { count: returns, countVariant: 'err' as const } : {})
      },
      {
        key: 'cola',
        label: 'Cola ML',
        ...(taskCount > 0 ? { count: taskCount, countVariant: (failed > 0 ? 'err' : 'warn') as 'err' | 'warn' } : {})
      },
      { key: 'estado', label: 'Estado' }
    ];
  });

  constructor() {
    // `?tab=devoluciones` es el acceso directo "Devoluciones" del menú lateral. Se escucha el
    // query param (no solo el snapshot) porque el menú puede cambiarlo sin recrear la página.
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe(params => {
      const tab = params.get('tab') ?? 'historial';
      if (TAB_KEYS.includes(tab) && tab !== this.activeTab()) this.onTabChange(tab);
    });
  }

  ngOnInit(): void {
    this.loadConfig();
    this.store.loadAudit();
  }

  loadConfig(): void {
    this.loading.set(true);
    this.error.set(null);
    this.sync.getConfig().subscribe({
      next: (c) => {
        this.config.set(c);
        this.loading.set(false);
        // Habilita las queries de devoluciones y Cola ML. El crawl de reclamos a ML NO se dispara
        // acá: lo dispara la pestaña Devoluciones al abrirse.
        if (c?.hasDatabase) this.store.hasDatabase.set(true);
      },
      error: (e) => {
        this.error.set(errorMessage(e, 'Error al cargar.'));
        this.loading.set(false);
      }
    });
  }

  onTabChange(key: string): void {
    this.activeTab.set(key);
    // La tab queda en la URL para que el menú lateral marque bien "Devoluciones" vs. "Historial y cola".
    // Solo si cambió: si la tab ya vino en la URL (acceso directo del menú), re-navegar en plena
    // carga cancela esa navegación y el menú nunca recibe el NavigationEnd.
    if ((this.route.snapshot.queryParamMap.get('tab') ?? 'historial') !== key) {
      this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { tab: key === 'historial' ? null : key },
        queryParamsHandling: 'merge',
        replaceUrl: true
      });
    }
  }

  toggleSync(enabled: boolean): void {
    if (!this.config()?.hasDatabase) return;
    this.savingToggle.set(true);
    this.error.set(null);
    this.sync.setSyncEnabled(enabled).subscribe({
      next: (r) => {
        this.config.update(c => c && { ...c, enabled: r.enabled });
        this.savingToggle.set(false);
      },
      error: (e) => {
        this.error.set(errorMessage(e, 'No se pudo actualizar.'));
        this.savingToggle.set(false);
      }
    });
  }

  registerWebhooks(): void {
    this.webhooksResult.set(null);
    this.registeringWebhooks.set(true);
    this.sync.registerWebhooks().subscribe({
      next: (r) => {
        this.registeringWebhooks.set(false);
        this.webhooksResult.set(r.registered > 0
          ? `Webhooks registrados: ${r.registered}.`
          : 'Ya estaban registrados con la URL actual.');
      },
      error: (e) => {
        this.webhooksResult.set(errorMessage(e, 'Error al registrar webhooks.'));
        this.registeringWebhooks.set(false);
      }
    });
  }
}
