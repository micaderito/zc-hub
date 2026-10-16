import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { DiscountProfile, PreviewRow, PricingService } from '../../../core/services/pricing.service';
import { PreciosStore } from '../precios.store';
import { apiError, discountPcts } from '../precios.utils';

/** Estado del formulario de carga manual de costo. */
export interface CostForm {
  sku: string;
  label: string;
  mode: 'bulk' | 'unit';
  bulkPrice: number | null;
  bulkQty: number | null;
  unitCost: number | null;
  marginOverride: number | null;
  /** Proveedor vigente (`''` = sin proveedor: sin descuento). */
  supplierKey: string;
  /** Config propia del SKU (`null` = la del pack o la default del proveedor). */
  profileId: number | null;
}

/** Alta / edición manual del costo de un SKU (por bulto o unitario), con proveedor y config. */
@Component({
  selector: 'zc-cost-form-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  templateUrl: './cost-form-dialog.component.html',
  styleUrl: './cost-form-dialog.component.scss',
})
export class CostFormDialogComponent implements OnInit {
  protected readonly store = inject(PreciosStore);
  private readonly pricing = inject(PricingService);

  /** Fila a editar; `null` = costo nuevo. */
  readonly row = input<PreviewRow | null>(null);

  readonly discountPcts = discountPcts;
  readonly form = signal<CostForm>(emptyCostForm());
  readonly saving = signal(false);
  readonly errorMsg = signal<string | null>(null);

  /** Configs del proveedor elegido. */
  readonly profiles = computed<DiscountProfile[]>(
    () => this.store.suppliers().find((s) => s.key === this.form().supplierKey)?.profiles ?? [],
  );

  ngOnInit(): void {
    const row = this.row();
    if (!row) {
      this.form.set(emptyCostForm(this.store.currentSupplier()?.key ?? this.store.suppliers()[0]?.key ?? ''));
      return;
    }
    const byBulk = row.bulkPrice != null && row.bulkQty != null;
    this.form.set({
      sku: row.sku, label: row.label ?? '', mode: byBulk ? 'bulk' : 'unit',
      bulkPrice: row.bulkPrice, bulkQty: row.bulkQty, unitCost: byBulk ? null : row.unitCost,
      marginOverride: null,
      supplierKey: row.supplierKey ?? '',
      profileId: row.discount?.level === 'sku' ? row.discount.profileId : null,
    });
  }

  update<K extends keyof CostForm>(key: K, value: CostForm[K]): void {
    // Cambiar de proveedor saca la config propia elegida: las configs son de cada proveedor.
    this.form.update((f) => ({ ...f, [key]: value, ...(key === 'supplierKey' ? { profileId: null } : {}) }));
  }

  async save(): Promise<void> {
    const f = this.form();
    if (!f.sku.trim()) { this.errorMsg.set('El SKU es obligatorio'); return; }
    this.saving.set(true);
    this.errorMsg.set(null);
    try {
      const supplier = { supplierKey: f.supplierKey || null };
      const payload = f.mode === 'bulk'
        ? { source: 'manual' as const, bulkPrice: f.bulkPrice, bulkQty: f.bulkQty, marginOverride: f.marginOverride, label: f.label, ...supplier, ...(f.supplierKey ? { profileId: f.profileId } : {}) }
        : { source: 'manual' as const, unitCost: f.unitCost, marginOverride: f.marginOverride, label: f.label, ...supplier };
      await firstValueFrom(this.pricing.saveCost(f.sku.trim(), payload));
      await this.store.refreshAll();
      this.store.close();
    } catch (e) {
      this.errorMsg.set(apiError(e, 'No se pudo guardar el costo'));
    } finally {
      this.saving.set(false);
    }
  }
}

function emptyCostForm(supplierKey = ''): CostForm {
  return {
    sku: '', label: '', mode: 'unit',
    bulkPrice: null, bulkQty: null, unitCost: null,
    marginOverride: null, supplierKey, profileId: null,
  };
}
