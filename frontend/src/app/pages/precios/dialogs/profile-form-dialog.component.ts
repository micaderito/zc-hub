import { ChangeDetectionStrategy, Component, OnInit, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { DiscountProfile, PricingService } from '../../../core/services/pricing.service';
import { PreciosStore } from '../precios.store';
import { apiError } from '../precios.utils';

/** Alta / edición de una configuración de descuento de un proveedor. */
@Component({
  selector: 'zc-profile-form-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  templateUrl: './profile-form-dialog.component.html',
})
export class ProfileFormDialogComponent implements OnInit {
  protected readonly store = inject(PreciosStore);
  private readonly pricing = inject(PricingService);

  readonly supplierKey = input.required<string>();
  /** `null` = configuración nueva. */
  readonly profile = input<DiscountProfile | null>(null);

  readonly name = signal('');
  readonly discount1 = signal<number | null>(0);
  readonly discount2 = signal<number | null>(0);
  readonly saving = signal(false);
  readonly errorMsg = signal<string | null>(null);

  ngOnInit(): void {
    const p = this.profile();
    if (!p) return;
    this.name.set(p.name);
    this.discount1.set(p.discount1);
    this.discount2.set(p.discount2);
  }

  /** Guarda la config; los precios de todo lo que la usa se recalculan y se marcan los que cambiaron. */
  async save(): Promise<void> {
    const name = this.name().trim();
    if (!name) { this.errorMsg.set('Poné un nombre a la configuración'); return; }
    this.saving.set(true);
    this.errorMsg.set(null);
    const body = { name, discount1: Number(this.discount1()) || 0, discount2: Number(this.discount2()) || 0 };
    try {
      const p = this.profile();
      if (p) await firstValueFrom(this.pricing.updateProfile(p.id, body));
      else await firstValueFrom(this.pricing.createProfile(this.supplierKey(), body));
      await this.store.refreshMarkingChanges();
      this.store.close();
    } catch (e) {
      this.errorMsg.set(apiError(e, 'No se pudo guardar la configuración'));
    } finally {
      this.saving.set(false);
    }
  }
}
