import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { MlFeeTier, MlFeesSync, PricingService, PricingSettings } from '../../../core/services/pricing.service';
import { PreciosStore } from '../precios.store';
import { apiError } from '../precios.utils';

/**
 * Ajustes: valores fijos del motor (comisión, impuestos, envío, tarjeta, redondeo, ganancia) y los
 * tramos de comisión fija de ML, con la opción de traerlos de la API de ML para comparar.
 */
@Component({
  selector: 'zc-pricing-settings-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  templateUrl: './pricing-settings-dialog.component.html',
  styleUrl: './pricing-settings-dialog.component.scss',
})
export class PricingSettingsDialogComponent implements OnInit {
  protected readonly store = inject(PreciosStore);
  private readonly pricing = inject(PricingService);

  readonly settingsDraft = signal<PricingSettings | null>(null);
  readonly tiersDraft = signal<MlFeeTier[]>([]);
  readonly saving = signal(false);
  readonly errorMsg = signal<string | null>(null);
  readonly syncingFees = signal(false);
  readonly feesSync = signal<MlFeesSync | null>(null);

  ngOnInit(): void {
    const c = this.store.config();
    if (!c) return;
    this.settingsDraft.set({ ...c.settings });
    this.tiersDraft.set(c.tiers.map((t) => ({ ...t })));
  }

  updateSettingsDraft<K extends keyof PricingSettings>(key: K, value: PricingSettings[K]): void {
    this.settingsDraft.update((s) => (s ? { ...s, [key]: value } : s));
  }

  updateTier(i: number, field: 'maxPrice' | 'fixedFee', value: number | null): void {
    this.tiersDraft.update((tiers) => tiers.map((t, idx) => (idx === i ? { ...t, [field]: value } : t)));
  }

  /** Trae de la API de ML la comisión y los tramos reales, para compararlos con lo cargado. */
  async fetchMlFees(): Promise<void> {
    this.syncingFees.set(true);
    this.errorMsg.set(null);
    this.feesSync.set(null);
    try {
      this.feesSync.set(await firstValueFrom(this.pricing.syncMlFees(false)));
    } catch (e) {
      this.errorMsg.set(`No se pudo consultar ML: ${apiError(e, String(e))}`);
    } finally {
      this.syncingFees.set(false);
    }
  }

  /** Vuelca a los campos del formulario la comisión y los tramos que trajo ML. */
  applyMlFeesToDraft(): void {
    const sync = this.feesSync();
    if (!sync) return;
    if (sync.remote.commissionPct != null) this.updateSettingsDraft('commissionPct', sync.remote.commissionPct);
    if (sync.remote.tiers?.length) this.tiersDraft.set(sync.remote.tiers.map((t) => ({ ...t })));
    this.feesSync.set(null);
  }

  /** Ajustes es global: cambia la fórmula de TODOS los productos; se resaltan los que se movieron. */
  async save(): Promise<void> {
    const draft = this.settingsDraft();
    if (!draft) return;
    this.saving.set(true);
    this.errorMsg.set(null);
    try {
      await firstValueFrom(this.pricing.saveConfig({ ...draft, tiers: this.tiersDraft() }));
      await this.store.refreshMarkingChanges();
      this.store.close();
    } catch (e) {
      this.errorMsg.set(apiError(e, 'No se pudo guardar'));
    } finally {
      this.saving.set(false);
    }
  }
}
