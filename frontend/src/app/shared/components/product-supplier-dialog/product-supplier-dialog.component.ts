import { ChangeDetectionStrategy, Component, OnInit, inject, input, output, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { QueryClient } from '@tanstack/angular-query-experimental';
import {
  PRODUCT_SUPPLIERS_QUERY_KEY, PricingService, ProductSupplierOverview, ProductSupplierResult, SkuSupplierInfo,
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

/** Un proveedor del producto en el diálogo, con la config que le toca. */
export interface SupplierRow {
  supplierKey: string;
  profileId: number | null;
}

/**
 * Proveedores de un producto o de un pack desde fuera de Precios (Productos). Un producto puede
 * comprarse a varios: cada uno con su config de descuento, y uno es el VIGENTE (el que manda el
 * costo). Guarda la lista completa con `PUT /pricing/product-supplier` (`suppliers`): los que se
 * sacan dejan de ser proveedores del producto, también su código. Un pack (o un SKU de un pack) se
 * asigna al pack entero, igual que en Precios.
 *
 * Con `bulk` (varios productos seleccionados) no se edita una lista —cada uno tiene la suya—: se
 * agrega un proveedor (opcionalmente como vigente) o se saca uno.
 */
@Component({
  selector: 'zc-product-supplier-dialog',
  standalone: true,
  imports: [FormsModule, ConfirmDialogComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <zc-confirm-dialog [title]="title()" icon="ti-building-store"
                       [confirmLabel]="result() ? 'Listo' : saving() ? 'Guardando…' : confirmLabel()"
                       (confirmed)="result() ? closed.emit() : save()" (cancelled)="closed.emit()">
      <div class="psd">
        @if (note()) { <p class="psd-note"><i class="ti ti-info-circle" aria-hidden="true"></i> {{ note() }}</p> }

        @if (result()) {
          <p class="psd-warn"><i class="ti ti-alert-triangle" aria-hidden="true"></i> {{ result() }}</p>
        } @else if (bulk()) {
          <div class="psd-modes" role="radiogroup" aria-label="Qué hacer">
            <label><input type="radio" name="psd-mode" [checked]="bulkMode() === 'add'" (change)="bulkMode.set('add')" /> Agregar proveedor</label>
            <label><input type="radio" name="psd-mode" [checked]="bulkMode() === 'remove'" (change)="bulkMode.set('remove')" /> Quitar proveedor</label>
          </div>
          <label class="psd-field">
            <span>Proveedor</span>
            <select class="zc-select" [ngModel]="supplierKey()" (ngModelChange)="setSupplier($event)">
              @for (s of suppliers(); track s.key) { <option [ngValue]="s.key">{{ s.name }}</option> }
            </select>
          </label>
          @if (bulkMode() === 'add') {
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
            <label class="psd-check">
              <input type="checkbox" [ngModel]="makeVigente()" (ngModelChange)="makeVigente.set($event)" />
              Que sea el vigente (el costo sale de este proveedor)
            </label>
            <p class="psd-hint">Se suma a los proveedores que ya tenga cada producto.</p>
          } @else {
            <p class="psd-hint">Deja de ser proveedor de estos productos y se saca su código. Si era el vigente, el producto queda sin vigente (el costo no se toca).</p>
          }
        } @else {
          @if (rows().length === 0) {
            <p class="psd-hint">Todavía no tiene proveedor.</p>
          } @else {
            <ul class="psd-rows">
              @for (r of rows(); track r.supplierKey) {
                <li class="psd-row">
                  <label class="psd-vig" [attr.title]="'El costo sale de este proveedor'">
                    <input type="radio" name="psd-vigente" [checked]="vigente() === r.supplierKey" (change)="vigente.set(r.supplierKey)" />
                    <b>{{ nameOf(r.supplierKey) }}</b>
                    @if (vigente() === r.supplierKey) { <span class="psd-badge">vigente</span> }
                  </label>
                  <select class="zc-select" [attr.aria-label]="'Descuento de ' + nameOf(r.supplierKey)"
                          [ngModel]="r.profileId" (ngModelChange)="setRowProfile(r.supplierKey, $event)">
                    @for (p of profilesOf(r.supplierKey); track p.id) {
                      <option [ngValue]="p.id">{{ p.name }} · {{ pcts(p) }}{{ p.isDefault ? ' (default)' : '' }}</option>
                    }
                  </select>
                  <button type="button" class="psd-x" (click)="removeRow(r.supplierKey)"
                          [attr.aria-label]="'Quitar ' + nameOf(r.supplierKey)" title="Quitar este proveedor">
                    <i class="ti ti-x"></i>
                  </button>
                </li>
              }
            </ul>
          }
          @if (available().length) {
            <div class="psd-add">
              <select class="zc-select" aria-label="Proveedor a agregar" [ngModel]="toAdd()" (ngModelChange)="toAdd.set($event)">
                @for (s of available(); track s.key) { <option [ngValue]="s.key">{{ s.name }}</option> }
              </select>
              <button type="button" class="zc-btn" (click)="addRow()"><i class="ti ti-plus"></i> Agregar</button>
            </div>
          }
          @if (removedNames().length) {
            <p class="psd-hint">Al guardar deja de comprarse a {{ removedNames().join(', ') }} (se saca su código).</p>
          }
          <p class="psd-hint">El vigente es el que manda el costo: si cambia, toma el precio de la última lista de ese proveedor. Las configs se administran en Precios.</p>
        }
        @if (error()) { <p class="psd-error">{{ error() }}</p> }
      </div>
    </zc-confirm-dialog>
  `,
  styles: [`
    .psd { display: flex; flex-direction: column; gap: 0.7rem; text-align: left; }
    .psd-field { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.75rem; color: var(--text-2); }
    .psd-note, .psd-hint { margin: 0; font-size: 0.72rem; color: var(--text-3); }
    .psd-warn { margin: 0; font-size: 0.78rem; color: var(--warn); display: flex; gap: 0.4rem; }
    .psd-error { margin: 0; font-size: 0.75rem; color: var(--err); }
    .psd-modes { display: flex; gap: 1rem; font-size: 0.8rem; }
    .psd-modes label, .psd-check { display: flex; align-items: center; gap: 0.35rem; font-size: 0.78rem; color: var(--text-2); }
    .psd-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
    .psd-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr) auto; gap: 0.5rem; align-items: center; }
    .psd-vig { display: flex; align-items: center; gap: 0.35rem; font-size: 0.8rem; min-width: 0; }
    .psd-vig b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .psd-badge { font-size: 0.65rem; padding: 0 0.35rem; border-radius: 999px; background: var(--brand-bg); color: var(--brand); }
    .psd-x { border: 0; background: none; color: var(--text-3); padding: 0.2rem; border-radius: 6px; cursor: pointer; }
    .psd-x:hover { color: var(--err); background: var(--surface-2); }
    .psd-add { display: flex; gap: 0.5rem; }
    .psd-add select { flex: 1; min-width: 0; }
    @media (max-width: 480px) { .psd-row { grid-template-columns: minmax(0, 1fr) auto; } .psd-row select { grid-column: 1 / -1; grid-row: 2; } }
  `],
})
export class ProductSupplierDialogComponent implements OnInit {
  private readonly pricing = inject(PricingService);
  private readonly queryClient = inject(QueryClient);

  readonly title = input('Proveedores');
  readonly skus = input<string[]>([]);
  readonly packId = input<number | null>(null);
  readonly note = input<string | null>(null);
  readonly info = input<SkuSupplierInfo | null>(null);
  readonly suppliers = input<OverviewSupplier[]>([]);
  /** `skus` son varios productos (selección masiva), no las variantes de uno solo. */
  readonly bulk = input(false);

  readonly closed = output<void>();
  readonly saved = output<void>();

  /* --- un producto: la lista completa --- */
  readonly rows = signal<SupplierRow[]>([]);
  readonly vigente = signal<string | null>(null);
  readonly toAdd = signal<string | null>(null);
  private initialKeys: string[] = [];

  /* --- varios productos: agregar o quitar uno --- */
  readonly bulkMode = signal<'add' | 'remove'>('add');
  readonly makeVigente = signal(true);
  readonly supplierKey = signal<string | null>(null);
  readonly profileId = signal<number | null>(null);

  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  /** Aviso después de guardar (lo que quedó sin precio o sin vigente); el diálogo queda abierto. */
  readonly result = signal<string | null>(null);

  readonly selected = computed(() => this.suppliers().find((s) => s.key === this.supplierKey()) ?? null);
  readonly available = computed(() => {
    const used = new Set(this.rows().map((r) => r.supplierKey));
    return this.suppliers().filter((s) => !used.has(s.key));
  });
  readonly removedNames = computed(() => {
    const now = new Set(this.rows().map((r) => r.supplierKey));
    return this.initialKeys.filter((k) => !now.has(k)).map((k) => this.nameOf(k));
  });
  readonly confirmLabel = computed(() => (this.bulk() && this.bulkMode() === 'remove' ? 'Quitar' : 'Guardar'));
  protected readonly pcts = discountPcts;

  ngOnInit(): void {
    if (this.bulk()) {
      this.setSupplier(this.suppliers()[0]?.key ?? null);
      return;
    }
    const info = this.info();
    const known = new Set(this.suppliers().map((s) => s.key));
    const keys = (info?.suppliers ?? []).filter((k) => known.has(k));
    this.initialKeys = keys;
    this.rows.set(keys.map((k) => {
      const d = info?.discounts?.[k] ?? (k === (info?.vigente ?? info?.suppliers[0]) ? info?.discount : null);
      const own = d && (d.level === 'sku' || d.level === 'pack') ? d.profileId : null;
      return { supplierKey: k, profileId: own ?? this.defaultProfileId(k) };
    }));
    this.vigente.set(info?.vigente && keys.includes(info.vigente) ? info.vigente : keys[0] ?? null);
    this.toAdd.set(this.available()[0]?.key ?? null);
  }

  nameOf(key: string): string {
    return this.suppliers().find((s) => s.key === key)?.name ?? key;
  }

  profilesOf(key: string): OverviewSupplier['profiles'] {
    return this.suppliers().find((s) => s.key === key)?.profiles ?? [];
  }

  private defaultProfileId(key: string | null): number | null {
    const profiles = key ? this.profilesOf(key) : [];
    return profiles.find((p) => p.isDefault)?.id ?? profiles[0]?.id ?? null;
  }

  setSupplier(key: string | null): void {
    this.supplierKey.set(key);
    this.profileId.set(this.defaultProfileId(key));
  }

  setRowProfile(key: string, id: number | null): void {
    this.rows.update((rows) => rows.map((r) => (r.supplierKey === key ? { ...r, profileId: id } : r)));
  }

  addRow(): void {
    const key = this.toAdd();
    if (!key || this.rows().some((r) => r.supplierKey === key)) return;
    this.rows.update((rows) => [...rows, { supplierKey: key, profileId: this.defaultProfileId(key) }]);
    if (!this.vigente()) this.vigente.set(key);
    this.toAdd.set(this.available()[0]?.key ?? null);
  }

  removeRow(key: string): void {
    this.rows.update((rows) => rows.filter((r) => r.supplierKey !== key));
    if (this.vigente() === key) this.vigente.set(this.rows()[0]?.supplierKey ?? null);
    if (!this.toAdd()) this.toAdd.set(this.available()[0]?.key ?? null);
  }

  async save(): Promise<void> {
    if (this.saving()) return;
    if (this.bulk() && !this.supplierKey()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      const res = await firstValueFrom(this.request());
      await this.queryClient.invalidateQueries({ queryKey: PRODUCT_SUPPLIERS_QUERY_KEY });
      this.saved.emit();
      const msg = this.resultMessage(res);
      if (msg) this.result.set(msg);
      else this.closed.emit();
    } catch (e) {
      const err = e as { error?: { error?: string }; message?: string };
      this.error.set(err?.error?.error || err?.message || 'No se pudo guardar el proveedor.');
    } finally {
      this.saving.set(false);
    }
  }

  private request() {
    const base = { skus: this.skus(), packId: this.packId() };
    if (!this.bulk()) {
      return this.pricing.setProductSupplier({ ...base, supplierKey: this.vigente(), suppliers: this.rows() });
    }
    if (this.bulkMode() === 'remove') {
      return this.pricing.removeProductSupplier({ ...base, supplierKey: this.supplierKey()!, bulk: true });
    }
    return this.pricing.setProductSupplier({
      ...base, supplierKey: this.supplierKey(), profileId: this.profileId(), bulk: true,
      ...(this.makeVigente() ? {} : { makeVigente: false }),
    });
  }

  private resultMessage(res: ProductSupplierResult | null | undefined): string | null {
    const plural = (n: number) => (n === 1 ? '' : 's');
    const noPrice = res?.withoutPrice?.length ?? 0;
    if (noPrice) {
      return `${noPrice} producto${plural(noPrice)} sin precio de lista de ${this.nameOf(this.vigente() ?? this.supplierKey() ?? '')}: `
        + 'quedó el costo de antes. Cargalo a mano o importá su lista en Precios.';
    }
    const lost = res?.lostVigente?.length ?? 0;
    if (lost) {
      return `${lost} producto${plural(lost)} tenía${lost === 1 ? '' : 'n'} a ${this.nameOf(this.supplierKey() ?? '')} de vigente `
        + 'y quedó sin vigente: el costo sigue, pero sin descuento. Elegí otro vigente en Precios.';
    }
    return null;
  }
}
