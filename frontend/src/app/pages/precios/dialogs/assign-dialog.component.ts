import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { DiscountProfile, PricingService, PricingTarget } from '../../../core/services/pricing.service';
import { PreciosStore } from '../precios.store';
import { apiError, defaultProfile, discountPcts } from '../precios.utils';

/** `discount` = asignar una config de descuento; `vigente` = cambiar el proveedor vigente. */
export type AssignMode = 'discount' | 'vigente';

/** Asignación masiva sobre lo seleccionado en la planilla. */
@Component({
  selector: 'zc-assign-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  templateUrl: './assign-dialog.component.html',
  styleUrl: './assign-dialog.component.scss',
})
export class AssignDialogComponent implements OnInit {
  protected readonly store = inject(PreciosStore);
  private readonly pricing = inject(PricingService);

  readonly mode = input.required<AssignMode>();
  readonly targets = input.required<PricingTarget[]>();
  readonly selectedCount = input.required<number>();
  readonly defaultSupplier = input<string>('');
  readonly closed = output<void>();

  readonly discountPcts = discountPcts;
  readonly supplierKey = signal('');
  readonly profileId = signal<number | null>(null);
  readonly saving = signal(false);
  readonly errorMsg = signal<string | null>(null);
  /** Aviso después de cambiar el vigente (lo que quedó sin precio de ese proveedor). */
  readonly result = signal<string | null>(null);

  readonly profiles = computed<DiscountProfile[]>(
    () => this.store.suppliers().find((s) => s.key === this.supplierKey())?.profiles ?? [],
  );

  ngOnInit(): void {
    this.setSupplier(this.defaultSupplier());
  }

  setSupplier(key: string): void {
    this.supplierKey.set(key);
    this.profileId.set(defaultProfile(this.store.suppliers().find((s) => s.key === key))?.id ?? null);
  }

  async confirm(): Promise<void> {
    const supplierKey = this.supplierKey();
    const targets = this.targets();
    if (!supplierKey || targets.length === 0) return;
    this.saving.set(true);
    this.errorMsg.set(null);
    try {
      if (this.mode() === 'discount') {
        await firstValueFrom(this.pricing.assignDiscount(supplierKey, targets, this.profileId()));
        await this.store.refreshMarkingChanges();
        this.closed.emit();
        return;
      }
      const res = await firstValueFrom(this.pricing.setVigente(supplierKey, targets));
      await this.store.refreshMarkingChanges();
      if (res.withoutPrice.length === 0) { this.closed.emit(); return; }
      // Sin precio de lista de ese proveedor: el costo quedó como estaba, hay que cargarlo.
      const n = res.withoutPrice.length;
      this.result.set(
        `${n} producto${n === 1 ? '' : 's'} sin precio de ${this.store.supplierName(supplierKey)}: `
        + `quedó el costo que tenía${n === 1 ? '' : 'n'}. Cargalo a mano o importá su lista.`,
      );
    } catch (e) {
      this.errorMsg.set(apiError(e, 'No se pudo asignar'));
    } finally {
      this.saving.set(false);
    }
  }
}
