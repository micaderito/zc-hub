import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
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
      <header class="pp-head">
        <div>
          <h1>Publicaciones</h1>
          <p>Tus productos con sus publicaciones de Mercado Libre y Tienda Nube, unidas por SKU.</p>
        </div>
        <zc-tabs [tabs]="tabs" [activeKey]="tab()" (tabChange)="setTab($event)" />
      </header>
      @if (tab() === 'productos') {
        <zc-hub-products />
      } @else {
        <app-publicaciones />
      }
    </div>
  `,
  styles: [`
    :host { display: block; padding: 18px 20px 90px; }
    .pp { max-width: 1320px; margin: 0 auto; }
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
    @media (max-width: 640px) { :host { padding: 14px 16px 90px; } }
  `],
})
export class PublicacionesPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly tabs: TabDef[] = [
    { key: 'productos', label: 'Productos' },
    { key: 'historial', label: 'Historial de publicación' },
  ];
  readonly tab = signal<TabKey>(this.route.snapshot.queryParamMap.get('tab') === 'historial' ? 'historial' : 'productos');

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
