import { ChangeDetectionStrategy, Component, ViewEncapsulation, inject } from '@angular/core';
import { TabDef, TabsComponent } from '../../shared/components/tabs/tabs.component';
import { MapeoProveedorComponent } from './mapeo/mapeo-proveedor.component';
import { PreciosPlanillaComponent } from './planilla/precios-planilla.component';
import { PreciosAplicacionesComponent } from './aplicaciones/precios-aplicaciones.component';
import { SupplierPanelComponent } from './proveedor/supplier-panel.component';
import { PricingSettingsDialogComponent } from './dialogs/pricing-settings-dialog.component';
import { ImportListDialogComponent } from './dialogs/import-list-dialog.component';
import { CostFormDialogComponent } from './dialogs/cost-form-dialog.component';
import { PriceListsDialogComponent } from './dialogs/price-lists-dialog.component';
import { SupplierFormDialogComponent } from './dialogs/supplier-form-dialog.component';
import { ProfileFormDialogComponent } from './dialogs/profile-form-dialog.component';
import { MappingProduct } from '../../core/services/pricing.service';
import { PreciosStore } from './precios.store';

/**
 * Sección de Precios — "Planilla viva". Del costo del proveedor al precio publicado. Esta es la
 * página contenedora: encabezado, una pestaña por proveedor (con sus configuraciones de descuento
 * arriba), la vista Planilla / Mapeo y el diálogo que esté abierto. El estado compartido vive en
 * PreciosStore (provisto acá, uno por visita); cada parte es su propio componente OnPush.
 *
 * Sin encapsulación a propósito: precios.component.scss define los estilos de base que comparten
 * todos los componentes de la sección (botones, badges, modales, campos), una sola vez y bajo
 * `:where(.pr-page)` — especificidad baja, así los estilos propios de cada componente los pisan.
 */
@Component({
  selector: 'app-precios',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  providers: [PreciosStore],
  imports: [
    TabsComponent, MapeoProveedorComponent, PreciosPlanillaComponent, PreciosAplicacionesComponent, SupplierPanelComponent,
    PricingSettingsDialogComponent, ImportListDialogComponent, CostFormDialogComponent,
    PriceListsDialogComponent, SupplierFormDialogComponent, ProfileFormDialogComponent,
  ],
  templateUrl: './precios.component.html',
  styleUrl: './precios.component.scss',
})
export class PreciosComponent {
  protected readonly store = inject(PreciosStore);

  readonly viewTabs: TabDef[] = [
    { key: 'precios', label: 'Planilla' },
    { key: 'mapeo', label: 'Mapeo con el proveedor' },
    { key: 'aplicaciones', label: 'Aplicaciones' },
  ];

  /** Lo que cambió desde la pestaña de mapeo (código asignado a mano) se resalta en la planilla. */
  onMappingCostsChanged(skus: string[]): void {
    this.store.markChanged(skus);
    void this.store.previewQuery.refetch();
  }

  /**
   * "Cargar costo" desde Mapeo: un producto que no mapea con ninguna lista también necesita costo
   * para tener precio. Si ya tiene, se edita la fila de la planilla; si no, costo nuevo con el
   * proveedor de la pestaña (queda como vigente y pasa a su planilla). Un pack con código propio
   * carga el mismo bulto a todos sus modelos.
   */
  onMappingEditCost(p: MappingProduct): void {
    const skus = p.kind === 'pack' ? p.memberSkus : [p.sku];
    // El costo que ya tenga (en un pack, el del primer modelo con costo) arranca precargado.
    const row = skus.map((sku) => this.store.allRows().find((r) => r.sku === sku)).find(Boolean) ?? null;
    if (row && skus.length === 1) {
      this.store.open({ kind: 'cost', row });
      return;
    }
    const supplierKey = this.store.currentSupplier()?.key ?? null;
    this.store.open({ kind: 'cost', row, prefill: { skus, label: p.name, supplierKey } });
  }
}
