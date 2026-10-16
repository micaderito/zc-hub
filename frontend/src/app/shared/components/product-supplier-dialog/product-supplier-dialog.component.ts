import { ChangeDetectionStrategy, Component, OnInit, inject, input, output, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { QueryClient } from '@tanstack/angular-query-experimental';
import {
  PRODUCT_SUPPLIERS_QUERY_KEY, PricingService, ProductSupplierOverview, SkuSupplierInfo,
} from '../../../core/services/pricing.service';
import { ConfirmDialogComponent } from '../confirm-dialog/confirm-dialog.component';

type OverviewSupplier = ProductSupplierOverview['suppliers'][number];

/** "−25% −5%" (o "sin descuento"), igual que en Precios. */
export function discountPcts(p: { discount1: number; discount2: number }): string {
  const parts = [p.discount1, p.discount2].filter((n) => n > 0).map((n) => `−${n}%`);
  return parts.length ? parts.join(' ') : 'sin descuento';
}

/** Rótulo del chip de proveedor ("Punto Cero · Agendas"), `null` = sin proveedor. */
export function supplierChipLabel(info: SkuSupplierInfo | null | undefined, suppliers: OverviewSupplier[]): string | null {
  const key = info?.vigente ?? info?.suppliers?.[0] ?? null;
  if (!key) return null;
  const name = suppliers.find((s) => s.key === key)?.name ?? key;
  const extra = (info?.suppliers.length ?? 0) > 1 ? ` +${info!.suppliers.length - 1}` : '';
  return info?.discount.name ? `${name} · ${info.discount.name}${extra}` : `${name}${extra}`;
}

/**
 * Elegir el proveedor y la config de descuento de un producto o de un pack desde fuera de Precios
 * (Productos). Guarda con `PUT /pricing/product-supplier`: un pack (o un SKU de un pack) se asigna
 * al pack entero, igual que en Precios. El costo no se toca acá (se carga en Precios o en el form).
 */
@Component({
  selector: 'zc-product-supplier-dialog',
  standalone: true,
  imports: [FormsModule, ConfirmDialogComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <zc-confirm-dialog [title]="title()" icon="ti-building-store" [confirmLabel]="saving() ? 'Guardando…' : 'Guardar'"
                       (confirmed)="save()" (cancelled)="closed.emit()">
      <div class="psd">
        @if (note()) { <p class="psd-note"><i class="ti ti-info-circle" aria-hidden="true"></i> {{ note() }}</p> }
        <label class="psd-field">
          <span>Proveedor</span>
          <select class="zc-select" [ngModel]="supplierKey()" (ngModelChange)="setSupplier($event)">
            @for (s of suppliers(); track s.key) { <option [ngValue]="s.key">{{ s.name }}</option> }
          </select>
        </label>
        @if (selected(); as sup) {
          <label class="psd-field">
            <span>Descuento</span>
            <select class="zc-select" [ngModel]="profileId()" (ngModelChange)="profileId.set($event)">
              @for (p of sup.profiles; track p.id) {
                <option [ngValue]="p.id">{{ p.name }} · {{ pcts(p) }}{{ p.isDefault ? ' (default)' : '' }}</option>
              }
            </select>
          </label>
        }
        <p class="psd-hint">Si ya tenía costo de otro proveedor, pasa a ser de este. Las configs se administran en Precios.</p>
        @if (error()) { <p class="psd-error">{{ error() }}</p> }
      </div>
    </zc-confirm-dialog>
  `,
  styles: [`
    .psd { display: flex; flex-direction: column; gap: 0.7rem; text-align: left; }
    .psd-field { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.75rem; color: var(--text-2); }
    .psd-note, .psd-hint { margin: 0; font-size: 0.72rem; color: var(--text-3); }
    .psd-error { margin: 0; font-size: 0.75rem; color: var(--err); }
  `],
})
export class ProductSupplierDialogComponent implements OnInit {
  private readonly pricing = inject(PricingService);
  private readonly queryClient = inject(QueryClient);

  readonly title = input('Proveedor');
  readonly skus = input<string[]>([]);
  readonly packId = input<number | null>(null);
  readonly note = input<string | null>(null);
  readonly info = input<SkuSupplierInfo | null>(null);
  readonly suppliers = input<OverviewSupplier[]>([]);

  readonly closed = output<void>();
  readonly saved = output<void>();

  readonly supplierKey = signal<string | null>(null);
  readonly profileId = signal<number | null>(null);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly selected = computed(() => this.suppliers().find((s) => s.key === this.supplierKey()) ?? null);
  protected readonly pcts = discountPcts;

  ngOnInit(): void {
    const info = this.info();
    const key = info?.vigente ?? info?.suppliers[0] ?? this.suppliers()[0]?.key ?? null;
    this.setSupplier(key);
    if (info?.discount.profileId != null && key === (info.vigente ?? info.suppliers[0])) this.profileId.set(info.discount.profileId);
  }

  setSupplier(key: string | null): void {
    this.supplierKey.set(key);
    const sup = this.suppliers().find((s) => s.key === key);
    this.profileId.set(sup?.profiles.find((p) => p.isDefault)?.id ?? sup?.profiles[0]?.id ?? null);
  }

  async save(): Promise<void> {
    if (this.saving() || !this.supplierKey()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      await firstValueFrom(this.pricing.setProductSupplier({
        skus: this.skus(), packId: this.packId(), supplierKey: this.supplierKey(), profileId: this.profileId(),
      }));
      await this.queryClient.invalidateQueries({ queryKey: PRODUCT_SUPPLIERS_QUERY_KEY });
      this.saved.emit();
      this.closed.emit();
    } catch (e) {
      const err = e as { error?: { error?: string }; message?: string };
      this.error.set(err?.error?.error || err?.message || 'No se pudo guardar el proveedor.');
    } finally {
      this.saving.set(false);
    }
  }
}
