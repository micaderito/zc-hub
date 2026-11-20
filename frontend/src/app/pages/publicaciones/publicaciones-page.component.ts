import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { PHONE_QUERY, mediaSignal } from '../../shared/utils/media-signal';
import { TabsComponent, TabDef } from '../../shared/components/tabs/tabs.component';
import { HubProductsComponent } from './productos/hub-products.component';
import { PublicacionesComponent } from './publicaciones.component';

type TabKey = 'productos' | 'historial';

/**
 * Página "Publicaciones": pestaña Productos (cada producto del hub con sus publicaciones de ML y TN)
 * y pestaña Historial de publicación (lo que se publicó desde Crear producto). La pestaña vive en
 * `?tab=historial` para que el link y el F5 la conserven.
 */
@Component({
  selector: 'app-publicaciones-page',
  standalone: true,
  imports: [TabsComponent, HubProductsComponent, PublicacionesComponent],
  template: `
    <div class="pp">
      @if (!(phone() && detailOpen())) {
      <header class="pp-head">
        <div>
          <h1>Publicaciones</h1>
          <p>Tus productos con sus publicaciones de Mercado Libre y Tienda Nube, unidas por SKU.</p>
        </div>
        <zc-tabs [tabs]="tabs()" [activeKey]="tab()" (tabChange)="setTab($event)" />
      </header>
      }
      @if (tab() === 'productos') {
        <zc-hub-products />
      } @else {
        <app-publicaciones />
      }
    </div>
  `,
  styles: [`
    @use 'mobile' as m;
    :host { display: block; padding: 18px 20px 90px; }
    .pp-head {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 14px;
      h1 { margin: 0; font-size: 18px; font-weight: 500; }
      p { margin: 3px 0 0; font-size: 12px; color: var(--text-2); }
    }
    // El shell ya pone su margen en el celular: acá no se suma otro.
    @include m.phone {
      :host { padding: 0 0 24px; }
      // En el celu el título ya está en la barra de arriba: queda solo el de la página, sin la explicación.
      .pp-head { margin-bottom: 12px; p { display: none; } }
      .pp-head > zc-tabs { flex-basis: 100%; }
    }
  `],
})
export class PublicacionesPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly phone = mediaSignal(PHONE_QUERY);
  /** En el celu el producto abierto (`?p=`) ocupa la pantalla entera: sin encabezado ni pestañas. */
  readonly detailOpen = toSignal(this.route.queryParamMap.pipe(map((q) => !!q.get('p') && q.get('tab') !== 'historial')), {
    initialValue: !!this.route.snapshot.queryParamMap.get('p'),
  });

  /** En un celular muy angosto el rótulo largo no entra al lado de "Productos". */
  private readonly narrow = signal(false);
  readonly tabs = computed<TabDef[]>(() => [
    { key: 'productos', label: 'Productos' },
    { key: 'historial', label: this.narrow() ? 'Historial' : 'Historial de publicación' },
  ]);
  readonly tab = signal<TabKey>(this.route.snapshot.queryParamMap.get('tab') === 'historial' ? 'historial' : 'productos');

  constructor() {
    const mq = typeof window !== 'undefined' ? window.matchMedia?.('(max-width: 380px)') : undefined;
    if (mq) {
      this.narrow.set(mq.matches);
      const onChange = (e: MediaQueryListEvent) => this.narrow.set(e.matches);
      mq.addEventListener?.('change', onChange);
      inject(DestroyRef).onDestroy(() => mq.removeEventListener?.('change', onChange));
    }
  }

  setTab(key: string): void {
    const tab: TabKey = key === 'historial' ? 'historial' : 'productos';
    this.tab.set(tab);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab: tab === 'historial' ? 'historial' : null, p: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
}
