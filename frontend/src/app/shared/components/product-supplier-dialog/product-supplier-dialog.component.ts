import { ChangeDetectionStrategy, Component, OnInit, inject, input, output, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { QueryClient } from '@tanstack/angular-query-experimental';
import {
  PRODUCT_SUPPLIERS_QUERY_KEY, PricingService, ProductSupplierResult, SkuSupplierInfo,
} from '../../../core/services/pricing.service';
import { ConfirmDialogComponent } from '../confirm-dialog/confirm-dialog.component';
import { OverviewSupplier, RowProfile, SupplierPicker, SupplierPickerComponent } from './supplier-picker';

export { discountPcts, SupplierPicker, SupplierPickerComponent } from './supplier-picker';
export type { RowProfile, SupplierCheck, SupplierRow } from './supplier-picker';

/** Rótulo del chip de proveedor ("Punto Cero · Agendas"), `null` = sin proveedor. */
export function supplierChipLabel(info: SkuSupplierInfo | null | undefined, suppliers: OverviewSupplier[]): string | null {
  const key = info?.vigente ?? info?.suppliers?.[0] ?? null;
  if (!key) return null;
  const name = suppliers.find((s) => s.key === key)?.name ?? key;
  const extra = (info?.suppliers.length ?? 0) > 1 ? ` +${info!.suppliers.length - 1}` : '';
  return info?.discount.name ? `${name} · ${info.discount.name}${extra}` : `${name}${extra}`;
}

/**
 * Proveedores de uno o de varios productos desde fuera de Precios (Productos: el chip del producto
 * o del pack, y "Proveedores…" con varios tildados). Es UN solo diálogo: una lista con todos los
 * proveedores, tildados los que ya tiene; cada tildado lleva su config de descuento y uno puede ser
 * el VIGENTE (el que manda el costo). La lista y sus reglas son `SupplierPicker` (las comparte con
 * el formulario de un pack).
 *
 * - **Un producto / un pack**: guarda la lista completa con `PUT /pricing/product-supplier`
 *   (`suppliers`): lo destildado deja de ser proveedor (también su código). Un pack (o un SKU de un
 *   pack) se asigna al pack entero, igual que en Precios.
 * - **Varios (`bulk`)**: cada uno tiene su propia lista, así que solo se aplica lo que se tocó. Un
 *   proveedor que tienen algunos sale con tilde a medias (`mixed`) y queda como está si no se toca;
 *   tildarlo lo suma a todos y destildarlo lo saca de todos. El vigente es opcional ("No cambiar").
 */
@Component({
  selector: 'zc-product-supplier-dialog',
  standalone: true,
  imports: [ConfirmDialogComponent, SupplierPickerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <zc-confirm-dialog [title]="title()" icon="ti-building-store"
                       [confirmLabel]="result() ? 'Listo' : saving() ? 'Guardando…' : 'Guardar'"
                       (confirmed)="result() ? closed.emit() : save()" (cancelled)="closed.emit()">
      <div class="psd">
        @if (note()) { <p class="psd-note"><i class="ti ti-info-circle" aria-hidden="true"></i> {{ note() }}</p> }

        @if (result()) {
          <p class="psd-warn"><i class="ti ti-alert-triangle" aria-hidden="true"></i> {{ result() }}</p>
        } @else {
          <zc-supplier-picker [picker]="picker" />
          @if (suppliers().length) {
            <p class="psd-hint">
              @if (bulk()) { Solo cambia lo que toques: un proveedor a medias (lo tienen algunos) queda como está. }
              El vigente es el que manda el costo: si cambia, toma el precio de la última lista de ese proveedor. Las configs se administran en Precios.
            </p>
          }
        }
        @if (error()) { <p class="psd-error">{{ error() }}</p> }
      </div>
    </zc-confirm-dialog>
  `,
  styles: [`
    .psd { display: flex; flex-direction: column; gap: 0.7rem; text-align: left; }
    .psd-note, .psd-hint { margin: 0; font-size: 0.72rem; color: var(--text-3); }
    .psd-warn { margin: 0; font-size: 0.78rem; color: var(--warn); display: flex; gap: 0.4rem; }
    .psd-error { margin: 0; font-size: 0.75rem; color: var(--err); }
  `],
})
export class ProductSupplierDialogComponent implements OnInit {
  private readonly pricing = inject(PricingService);
  private readonly queryClient = inject(QueryClient);

  readonly title = input('Proveedores');
  readonly skus = input<string[]>([]);
  readonly packId = input<number | null>(null);
  readonly note = input<string | null>(null);
  /** Un producto: su proveedor actual. */
  readonly info = input<SkuSupplierInfo | null>(null);
  /** Varios productos: el proveedor de cada SKU (el `bySku` de `getProductSuppliers`). */
  readonly bySku = input<Record<string, SkuSupplierInfo>>({});
  readonly suppliers = input<OverviewSupplier[]>([]);
  /** `skus` son varios productos (selección masiva), no las variantes de uno solo. */
  readonly bulk = input(false);

  readonly closed = output<void>();
  readonly saved = output<void>();

  /** La lista con tildes (se arma al abrir, con los inputs ya puestos). */
  picker!: SupplierPicker;
  get rows() { return this.picker.rows; }
  /** El vigente elegido. Con varios productos, `null` = no cambiarlo. */
  get vigente() { return this.picker.vigente; }
  get onRows() { return this.picker.onRows; }
  get removedNames() { return this.picker.removedNames; }

  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  /** Aviso después de guardar (lo que quedó sin precio o sin vigente); el diálogo queda abierto. */
  readonly result = signal<string | null>(null);

  ngOnInit(): void {
    this.picker = new SupplierPicker({
      suppliers: this.suppliers(), info: this.info(), bulk: this.bulk(), skus: this.skus(), bySku: this.bySku(),
    });
  }

  nameOf(key: string): string {
    return this.picker.nameOf(key);
  }

  toggle(key: string): void {
    this.picker.toggle(key);
  }

  setRowProfile(key: string, id: RowProfile): void {
    this.picker.setRowProfile(key, id);
  }

  async save(): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      const results = this.bulk() ? await this.saveBulk() : [await firstValueFrom(this.saveSingle())];
      await this.queryClient.invalidateQueries({ queryKey: PRODUCT_SUPPLIERS_QUERY_KEY });
      if (results.length) this.saved.emit();
      const msg = this.picker.resultMessage(results);
      if (msg) this.result.set(msg);
      else this.closed.emit();
    } catch (e) {
      // Con varios, lo que se llegó a aplicar antes del error ya quedó: refrescar el chip.
      void this.queryClient.invalidateQueries({ queryKey: PRODUCT_SUPPLIERS_QUERY_KEY });
      const err = e as { error?: { error?: string }; message?: string };
      this.error.set(err?.error?.error || err?.message || 'No se pudo guardar el proveedor.');
    } finally {
      this.saving.set(false);
    }
  }

  private saveSingle() {
    const { supplierKey, suppliers } = this.picker.singleRequest();
    return this.pricing.setProductSupplier({ skus: this.skus(), packId: this.packId(), supplierKey, suppliers });
  }

  /**
   * Con varios productos, una llamada por proveedor tocado: primero los que se sacan, después los
   * que se suman o cambian de config, y el vigente al final (así queda el que se eligió).
   */
  private async saveBulk(): Promise<ProductSupplierResult[]> {
    const base = { skus: this.skus(), packId: this.packId(), bulk: true };
    const vigente = this.vigente();
    const out: ProductSupplierResult[] = [];
    for (const r of this.rows()) {
      if (r.state === 'off' && r.initial !== 'off') {
        out.push(await firstValueFrom(this.pricing.removeProductSupplier({ ...base, supplierKey: r.supplierKey })));
      }
    }
    const touched = this.onRows().filter((r) => r.initial !== 'on' || r.profileId !== 'keep' || r.supplierKey === vigente);
    touched.sort((a, b) => Number(a.supplierKey === vigente) - Number(b.supplierKey === vigente));
    for (const r of touched) {
      out.push(await firstValueFrom(this.pricing.setProductSupplier({
        ...base, supplierKey: r.supplierKey,
        ...(r.profileId === 'keep' ? { keepProfile: true } : { profileId: r.profileId }),
        ...(r.supplierKey === vigente ? {} : { makeVigente: false }),
      })));
    }
    return out;
  }
}
