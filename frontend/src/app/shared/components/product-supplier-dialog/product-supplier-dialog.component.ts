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

/** Tilde de un proveedor: lo tienen todos, ninguno, o (con varios productos) solo algunos. */
export type SupplierCheck = 'on' | 'off' | 'mixed';
/** `'keep'` (solo con varios productos) = no tocar la config de los que ya tenían este proveedor. */
export type RowProfile = number | null | 'keep';

/** Un proveedor en el diálogo: todos los del hub aparecen, tildados los del producto. */
export interface SupplierRow {
  supplierKey: string;
  state: SupplierCheck;
  /** Cómo estaba al abrir: decide qué cambió al guardar. */
  initial: SupplierCheck;
  profileId: RowProfile;
  /** Con varios productos: cuántos lo tienen. */
  count: number;
}

/**
 * Proveedores de uno o de varios productos desde fuera de Precios (Productos: el chip del producto
 * o del pack, y "Proveedores…" con varios tildados). Es UN solo diálogo: una lista con todos los
 * proveedores, tildados los que ya tiene; cada tildado lleva su config de descuento y uno puede ser
 * el VIGENTE (el que manda el costo).
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
  imports: [FormsModule, ConfirmDialogComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <zc-confirm-dialog [title]="title()" icon="ti-building-store"
                       [confirmLabel]="result() ? 'Listo' : saving() ? 'Guardando…' : 'Guardar'"
                       (confirmed)="result() ? closed.emit() : save()" (cancelled)="closed.emit()">
      <div class="psd">
        @if (note()) { <p class="psd-note"><i class="ti ti-info-circle" aria-hidden="true"></i> {{ note() }}</p> }

        @if (result()) {
          <p class="psd-warn"><i class="ti ti-alert-triangle" aria-hidden="true"></i> {{ result() }}</p>
        } @else if (suppliers().length === 0) {
          <p class="psd-hint">Todavía no hay proveedores. Crealos en Precios.</p>
        } @else {
          <ul class="psd-rows" role="list">
            @for (r of rows(); track r.supplierKey) {
              <li class="psd-row" [class.on]="r.state === 'on'">
                <button type="button" class="psd-check" role="checkbox" [attr.aria-checked]="r.state === 'mixed' ? 'mixed' : r.state === 'on'"
                        (click)="toggle(r.supplierKey)">
                  <i class="ti" [class.ti-square-check]="r.state === 'on'" [class.ti-square-minus]="r.state === 'mixed'"
                     [class.ti-square]="r.state === 'off'" aria-hidden="true"></i>
                  <b>{{ nameOf(r.supplierKey) }}</b>
                  @if (bulk() && r.state === 'mixed') { <span class="psd-some">{{ r.count }} de {{ skus().length }}</span> }
                </button>
                @if (r.state === 'on') {
                  <select class="zc-select" [attr.aria-label]="'Descuento de ' + nameOf(r.supplierKey)"
                          [ngModel]="r.profileId" (ngModelChange)="setRowProfile(r.supplierKey, $event)">
                    @if (bulk() && r.initial !== 'off') { <option [ngValue]="'keep'">Mantener la de cada uno</option> }
                    @for (p of profilesOf(r.supplierKey); track p.id) {
                      <option [ngValue]="p.id">{{ p.name }} · {{ pcts(p) }}{{ p.isDefault ? ' (default)' : '' }}</option>
                    }
                  </select>
                  <label class="psd-vig" title="El costo sale de este proveedor">
                    <input type="radio" name="psd-vigente" [checked]="vigente() === r.supplierKey" (change)="vigente.set(r.supplierKey)" />
                    vigente
                  </label>
                }
              </li>
            }
          </ul>
          @if (bulk() && onRows().length) {
            <label class="psd-vig psd-keep">
              <input type="radio" name="psd-vigente" [checked]="vigente() === null" (change)="vigente.set(null)" />
              No cambiar el vigente
            </label>
          }
          @if (removedNames().length) {
            <p class="psd-hint">Al guardar deja de comprarse a {{ removedNames().join(', ') }}{{ bulk() ? ' en todos los seleccionados' : '' }} (se saca su código).</p>
          }
          <p class="psd-hint">
            @if (bulk()) { Solo cambia lo que toques: un proveedor a medias (lo tienen algunos) queda como está. }
            El vigente es el que manda el costo: si cambia, toma el precio de la última lista de ese proveedor. Las configs se administran en Precios.
          </p>
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
    .psd-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.15rem; max-height: 22rem; overflow-y: auto; }
    .psd-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr) auto; gap: 0.5rem; align-items: center;
      padding: 0.25rem 0.35rem; border-radius: 8px; min-height: 2.2rem; }
    .psd-row.on { background: var(--surface-2); }
    .psd-row:not(.on) .psd-check { grid-column: 1 / -1; }
    .psd-check { display: flex; align-items: center; gap: 0.45rem; min-width: 0; border: 0; background: none; padding: 0.2rem 0;
      font: inherit; font-size: 0.8rem; color: var(--text-1); cursor: pointer; text-align: left; }
    .psd-check i { font-size: 1.15rem; color: var(--text-3); }
    .psd-row.on .psd-check i, .psd-check[aria-checked="mixed"] i { color: var(--brand); }
    .psd-check b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
    .psd-some { font-size: 0.68rem; color: var(--text-3); white-space: nowrap; }
    .psd-vig { display: flex; align-items: center; gap: 0.3rem; font-size: 0.72rem; color: var(--text-2); white-space: nowrap; }
    .psd-keep { padding-left: 0.35rem; }
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
  /** Un producto: su proveedor actual. */
  readonly info = input<SkuSupplierInfo | null>(null);
  /** Varios productos: el proveedor de cada SKU (el `bySku` de `getProductSuppliers`). */
  readonly bySku = input<Record<string, SkuSupplierInfo>>({});
  readonly suppliers = input<OverviewSupplier[]>([]);
  /** `skus` son varios productos (selección masiva), no las variantes de uno solo. */
  readonly bulk = input(false);

  readonly closed = output<void>();
  readonly saved = output<void>();

  readonly rows = signal<SupplierRow[]>([]);
  /** El vigente elegido. Con varios productos, `null` = no cambiarlo. */
  readonly vigente = signal<string | null>(null);

  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  /** Aviso después de guardar (lo que quedó sin precio o sin vigente); el diálogo queda abierto. */
  readonly result = signal<string | null>(null);

  readonly onRows = computed(() => this.rows().filter((r) => r.state === 'on'));
  readonly removedNames = computed(() =>
    this.rows().filter((r) => r.state === 'off' && r.initial !== 'off').map((r) => this.nameOf(r.supplierKey)));
  protected readonly pcts = discountPcts;

  ngOnInit(): void {
    const rows = this.bulk() ? this.bulkRows() : this.singleRows();
    // Los que ya tiene arriba, después el resto, cada grupo en el orden de siempre.
    const rank = (r: SupplierRow) => (r.initial === 'off' ? 1 : 0);
    this.rows.set([...rows].sort((a, b) => rank(a) - rank(b)));
    if (!this.bulk()) {
      const info = this.info();
      const on = this.onRows().map((r) => r.supplierKey);
      this.vigente.set(info?.vigente && on.includes(info.vigente) ? info.vigente : on[0] ?? null);
    }
  }

  private singleRows(): SupplierRow[] {
    const info = this.info();
    const mine = new Set(info?.suppliers ?? []);
    return this.suppliers().map((s) => {
      const has = mine.has(s.key);
      const d = info?.discounts?.[s.key] ?? (s.key === (info?.vigente ?? info?.suppliers[0]) ? info?.discount : null);
      const own = has && d && (d.level === 'sku' || d.level === 'pack') ? d.profileId : null;
      const state: SupplierCheck = has ? 'on' : 'off';
      return { supplierKey: s.key, state, initial: state, profileId: own ?? this.defaultProfileId(s.key), count: has ? 1 : 0 };
    });
  }

  private bulkRows(): SupplierRow[] {
    const skus = this.skus();
    const bySku = this.bySku();
    return this.suppliers().map((s) => {
      const count = skus.filter((sku) => bySku[sku]?.suppliers.includes(s.key)).length;
      const state: SupplierCheck = count === 0 ? 'off' : count === skus.length ? 'on' : 'mixed';
      return { supplierKey: s.key, state, initial: state, profileId: count ? 'keep' : this.defaultProfileId(s.key), count };
    });
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

  /** Tildar / destildar. Uno a medias pasa por: a medias → todos → ninguno → a medias. */
  toggle(key: string): void {
    this.rows.update((rows) => rows.map((r) => {
      if (r.supplierKey !== key) return r;
      const state: SupplierCheck = r.state === 'mixed' ? 'on' : r.state === 'on' ? 'off' : (r.initial === 'mixed' ? 'mixed' : 'on');
      return { ...r, state };
    }));
    const on = this.onRows().map((r) => r.supplierKey);
    const vig = this.vigente();
    if (vig && !on.includes(vig)) this.vigente.set(null);
    // Un producto con proveedores siempre tiene vigente: el primero tildado.
    if (!this.bulk() && !this.vigente()) this.vigente.set(on[0] ?? null);
  }

  setRowProfile(key: string, id: RowProfile): void {
    this.rows.update((rows) => rows.map((r) => (r.supplierKey === key ? { ...r, profileId: id } : r)));
  }

  async save(): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      const results = this.bulk() ? await this.saveBulk() : [await firstValueFrom(this.saveSingle())];
      await this.queryClient.invalidateQueries({ queryKey: PRODUCT_SUPPLIERS_QUERY_KEY });
      if (results.length) this.saved.emit();
      const msg = this.resultMessage(results);
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
    const suppliers = this.onRows().map((r) => ({ supplierKey: r.supplierKey, profileId: r.profileId === 'keep' ? null : r.profileId }));
    return this.pricing.setProductSupplier({ skus: this.skus(), packId: this.packId(), supplierKey: this.vigente(), suppliers });
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

  private resultMessage(results: Array<ProductSupplierResult | null | undefined>): string | null {
    const plural = (n: number) => (n === 1 ? '' : 's');
    const noPrice = new Set(results.flatMap((r) => r?.withoutPrice ?? [])).size;
    if (noPrice) {
      return `${noPrice} producto${plural(noPrice)} sin precio de lista de ${this.nameOf(this.vigente() ?? '')}: `
        + 'quedó el costo de antes. Cargalo a mano o importá su lista en Precios.';
    }
    const lost = new Set(results.flatMap((r) => r?.lostVigente ?? [])).size;
    if (lost) {
      return `${lost} producto${plural(lost)} tenía${lost === 1 ? '' : 'n'} de vigente a un proveedor que sacaste `
        + 'y quedó sin vigente: el costo sigue, pero sin descuento. Elegí otro vigente acá o en Precios.';
    }
    return null;
  }
}
