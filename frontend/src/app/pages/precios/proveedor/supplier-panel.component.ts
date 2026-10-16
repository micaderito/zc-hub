import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { DiscountProfile, PricingService, Supplier } from '../../../core/services/pricing.service';
import { PreciosStore } from '../precios.store';
import { apiError, discountPcts } from '../precios.utils';

/**
 * Cabecera de la pestaña de un proveedor: renombrar / borrar el proveedor y sus configuraciones de
 * descuento como tarjetas (editar, hacer default, borrar, nueva). Los formularios abren como
 * diálogos de la página (PreciosStore.open).
 */
@Component({
  selector: 'zc-supplier-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './supplier-panel.component.html',
  styleUrl: './supplier-panel.component.scss',
})
export class SupplierPanelComponent {
  protected readonly store = inject(PreciosStore);
  private readonly pricing = inject(PricingService);

  readonly supplier = input.required<Supplier>();

  readonly discountPcts = discountPcts;
  readonly confirmDelete = signal(false);
  readonly confirmDeleteProfileId = signal<number | null>(null);
  readonly errorMsg = signal<string | null>(null);

  openProfile(profile: DiscountProfile | null = null): void {
    this.store.open({ kind: 'profile', supplierKey: this.supplier().key, profile });
  }

  async deleteSupplier(): Promise<void> {
    this.errorMsg.set(null);
    try {
      await firstValueFrom(this.pricing.deleteSupplier(this.supplier().key));
      this.confirmDelete.set(false);
      this.store.setSupplierTab('all');
      await this.store.configQuery.refetch();
    } catch (e) {
      this.confirmDelete.set(false);
      this.errorMsg.set(apiError(e, 'No se pudo borrar el proveedor'));
    }
  }

  async makeDefault(p: DiscountProfile): Promise<void> {
    this.errorMsg.set(null);
    try {
      await firstValueFrom(this.pricing.updateProfile(p.id, { isDefault: true }));
      await this.store.refreshMarkingChanges();
    } catch (e) {
      this.errorMsg.set(apiError(e, 'No se pudo cambiar la default'));
    }
  }

  async deleteProfile(p: DiscountProfile): Promise<void> {
    this.errorMsg.set(null);
    try {
      await firstValueFrom(this.pricing.deleteProfile(p.id));
      this.confirmDeleteProfileId.set(null);
      await this.store.refreshMarkingChanges();
    } catch (e) {
      this.errorMsg.set(apiError(e, 'No se pudo borrar la configuración'));
    }
  }
}
