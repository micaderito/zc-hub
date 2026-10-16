import { ChangeDetectionStrategy, Component, OnInit, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { PricingService, Supplier } from '../../../core/services/pricing.service';
import { PreciosStore } from '../precios.store';
import { apiError } from '../precios.utils';

/** Alta de un proveedor (con su descuento default) o renombre de uno existente. */
@Component({
  selector: 'zc-supplier-form-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  templateUrl: './supplier-form-dialog.component.html',
})
export class SupplierFormDialogComponent implements OnInit {
  protected readonly store = inject(PreciosStore);
  private readonly pricing = inject(PricingService);

  /** `null` = proveedor nuevo. */
  readonly supplier = input<Supplier | null>(null);

  readonly name = signal('');
  readonly discount1 = signal<number | null>(0);
  readonly discount2 = signal<number | null>(0);
  readonly saving = signal(false);
  readonly errorMsg = signal<string | null>(null);

  ngOnInit(): void {
    this.name.set(this.supplier()?.name ?? '');
  }

  async save(): Promise<void> {
    const name = this.name().trim();
    if (!name) { this.errorMsg.set('Poné el nombre del proveedor'); return; }
    this.saving.set(true);
    this.errorMsg.set(null);
    try {
      const current = this.supplier();
      if (current) {
        await firstValueFrom(this.pricing.renameSupplier(current.key, name));
      } else {
        const { key } = await firstValueFrom(this.pricing.createSupplier({
          name, discount1: Number(this.discount1()) || 0, discount2: Number(this.discount2()) || 0,
        }));
        this.store.setSupplierTab(key);
      }
      await this.store.configQuery.refetch();
      this.store.close();
    } catch (e) {
      this.errorMsg.set(apiError(e, 'No se pudo guardar el proveedor'));
    } finally {
      this.saving.set(false);
    }
  }
}
