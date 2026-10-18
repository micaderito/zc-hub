import { ChangeDetectionStrategy, Component, WritableSignal, computed, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ProductSupplierOverview, ProductSupplierResult, SkuSupplierInfo } from '../../../core/services/pricing.service';

export type OverviewSupplier = ProductSupplierOverview['suppliers'][number];

/** "−25% −5%" (o "sin descuento"), igual que en Precios. */
export function discountPcts(p: { discount1: number; discount2: number }): string {
  const parts = [p.discount1, p.discount2].filter((n) => n > 0).map((n) => `−${n}%`);
  return parts.length ? parts.join(' ') : 'sin descuento';
}

/** Tilde de un proveedor: lo tienen todos, ninguno, o (con varios productos) solo algunos. */
export type SupplierCheck = 'on' | 'off' | 'mixed';
/** `'keep'` (solo con varios productos) = no tocar la config de los que ya tenían este proveedor. */
export type RowProfile = number | null | 'keep';

/** Un proveedor en la lista: todos los del hub aparecen, tildados los del producto. */
export interface SupplierRow {
  supplierKey: string;
  state: SupplierCheck;
  /** Cómo estaba al abrir: decide qué cambió al guardar. */
  initial: SupplierCheck;
  profileId: RowProfile;
  /** Valor de `profileId` al abrir (para saber si algo cambió). */
  initialProfileId: RowProfile;
  /** Con varios productos: cuántos lo tienen. */
  count: number;
}

export interface SupplierPickerOptions {
  suppliers: OverviewSupplier[];
  /** Un producto / un pack: su proveedor actual. */
  info?: SkuSupplierInfo | null;
  /** `skus` son varios productos (selección masiva), no las variantes de uno solo. */
  bulk?: boolean;
  skus?: string[];
  /** Varios productos: el proveedor de cada SKU (el `bySku` de `getProductSuppliers`). */
  bySku?: Record<string, SkuSupplierInfo>;
}

let pickerSeq = 0;

/**
 * Estado de "a qué proveedores se le compra" (todos los proveedores con tilde, la config de cada
 * tildado y cuál es el vigente). Lo comparten el diálogo de proveedores de Productos y el formulario
 * de un pack, así las reglas (qué arranca tildado, el ciclo del tilde a medias, quién queda de
 * vigente) viven en un solo lugar. Se pinta con `<zc-supplier-picker>`.
 */
export class SupplierPicker {
  readonly suppliers: OverviewSupplier[];
  readonly bulk: boolean;
  readonly skus: string[];
  /** `name` del grupo de radios del vigente: único, por si hay dos listas en pantalla. */
  readonly radioName = `psd-vigente-${++pickerSeq}`;

  // Se crean ya con su valor (sin `.set` en el constructor): así se puede armar dentro de un `computed`.
  readonly rows: WritableSignal<SupplierRow[]>;
  /** El vigente elegido. Con varios productos, `null` = no cambiarlo. */
  readonly vigente: WritableSignal<string | null>;
  private readonly initialVigente: string | null;

  readonly onRows = computed(() => this.rows().filter((r) => r.state === 'on'));
  readonly removedNames = computed(() =>
    this.rows().filter((r) => r.state === 'off' && r.initial !== 'off').map((r) => this.nameOf(r.supplierKey)));
  /** Algo cambió desde que se abrió (tilde, config o vigente). */
  readonly dirty = computed(() =>
    this.vigente() !== this.initialVigente
    || this.rows().some((r) => r.state !== r.initial || (r.state !== 'off' && r.profileId !== r.initialProfileId)));

  constructor(opts: SupplierPickerOptions) {
    this.suppliers = opts.suppliers;
    this.bulk = !!opts.bulk;
    this.skus = opts.skus ?? [];
    const rows = this.bulk ? this.bulkRows(opts.bySku ?? {}) : this.singleRows(opts.info ?? null);
    // Los que ya tiene arriba, después el resto, cada grupo en el orden de siempre.
    const rank = (r: SupplierRow) => (r.initial === 'off' ? 1 : 0);
    const sorted = [...rows].sort((a, b) => rank(a) - rank(b));
    this.rows = signal(sorted);
    let vigente: string | null = null;
    if (!this.bulk) {
      const info = opts.info;
      const on = sorted.filter((r) => r.state === 'on').map((r) => r.supplierKey);
      vigente = info?.vigente && on.includes(info.vigente) ? info.vigente : on[0] ?? null;
    }
    this.vigente = signal(vigente);
    this.initialVigente = vigente;
  }

  private singleRows(info: SkuSupplierInfo | null): SupplierRow[] {
    const mine = new Set(info?.suppliers ?? []);
    return this.suppliers.map((s) => {
      const has = mine.has(s.key);
      const d = info?.discounts?.[s.key] ?? (s.key === (info?.vigente ?? info?.suppliers[0]) ? info?.discount : null);
      const own = has && d && (d.level === 'sku' || d.level === 'pack') ? d.profileId : null;
      const state: SupplierCheck = has ? 'on' : 'off';
      const profileId = own ?? this.defaultProfileId(s.key);
      return { supplierKey: s.key, state, initial: state, profileId, initialProfileId: profileId, count: has ? 1 : 0 };
    });
  }

  private bulkRows(bySku: Record<string, SkuSupplierInfo>): SupplierRow[] {
    const skus = this.skus;
    return this.suppliers.map((s) => {
      const count = skus.filter((sku) => bySku[sku]?.suppliers.includes(s.key)).length;
      const state: SupplierCheck = count === 0 ? 'off' : count === skus.length ? 'on' : 'mixed';
      const profileId: RowProfile = count ? 'keep' : this.defaultProfileId(s.key);
      return { supplierKey: s.key, state, initial: state, profileId, initialProfileId: profileId, count };
    });
  }

  nameOf(key: string): string {
    return this.suppliers.find((s) => s.key === key)?.name ?? key;
  }

  profilesOf(key: string): OverviewSupplier['profiles'] {
    return this.suppliers.find((s) => s.key === key)?.profiles ?? [];
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
    if (!this.bulk && !this.vigente()) this.vigente.set(on[0] ?? null);
  }

  setRowProfile(key: string, id: RowProfile): void {
    this.rows.update((rows) => rows.map((r) => (r.supplierKey === key ? { ...r, profileId: id } : r)));
  }

  /** Un producto / un pack: la lista completa para `PUT /pricing/product-supplier` (`suppliers`). */
  singleRequest(): { supplierKey: string | null; suppliers: Array<{ supplierKey: string; profileId: number | null }> } {
    const suppliers = this.onRows().map((r) => ({ supplierKey: r.supplierKey, profileId: r.profileId === 'keep' ? null : r.profileId }));
    return { supplierKey: this.vigente(), suppliers };
  }

  /** Aviso después de guardar (lo que quedó sin precio o sin vigente); `null` = nada que avisar. */
  resultMessage(results: Array<ProductSupplierResult | null | undefined>): string | null {
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

/** La lista de proveedores con tilde + config + vigente de un `SupplierPicker`. */
@Component({
  selector: 'zc-supplier-picker',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let p = picker();
    @if (p.suppliers.length === 0) {
      <p class="psd-hint">Todavía no hay proveedores. Crealos en Precios.</p>
    } @else {
      <ul class="psd-rows" role="list">
        @for (r of p.rows(); track r.supplierKey) {
          <li class="psd-row" [class.on]="r.state === 'on'">
            <button type="button" class="psd-check" role="checkbox" [attr.aria-checked]="r.state === 'mixed' ? 'mixed' : r.state === 'on'"
                    (click)="p.toggle(r.supplierKey)">
              <i class="ti" [class.ti-square-check]="r.state === 'on'" [class.ti-square-minus]="r.state === 'mixed'"
                 [class.ti-square]="r.state === 'off'" aria-hidden="true"></i>
              <b>{{ p.nameOf(r.supplierKey) }}</b>
              @if (p.bulk && r.state === 'mixed') { <span class="psd-some">{{ r.count }} de {{ p.skus.length }}</span> }
            </button>
            @if (r.state === 'on') {
              <select class="zc-select" [attr.aria-label]="'Descuento de ' + p.nameOf(r.supplierKey)"
                      [ngModel]="r.profileId" (ngModelChange)="p.setRowProfile(r.supplierKey, $event)">
                @if (p.bulk && r.initial !== 'off') { <option [ngValue]="'keep'">Mantener la de cada uno</option> }
                @for (pr of p.profilesOf(r.supplierKey); track pr.id) {
                  <option [ngValue]="pr.id">{{ pr.name }} · {{ pcts(pr) }}{{ pr.isDefault ? ' (default)' : '' }}</option>
                }
              </select>
              <label class="psd-vig" title="El costo sale de este proveedor">
                <input type="radio" [name]="p.radioName" [checked]="p.vigente() === r.supplierKey" (change)="p.vigente.set(r.supplierKey)" />
                vigente
              </label>
            }
          </li>
        }
      </ul>
      @if (p.bulk && p.onRows().length) {
        <label class="psd-vig psd-keep">
          <input type="radio" [name]="p.radioName" [checked]="p.vigente() === null" (change)="p.vigente.set(null)" />
          No cambiar el vigente
        </label>
      }
      @if (p.removedNames().length) {
        <p class="psd-hint">Al guardar deja de comprarse a {{ p.removedNames().join(', ') }}{{ p.bulk ? ' en todos los seleccionados' : '' }} (se saca su código).</p>
      }
    }
  `,
  styles: [`
    :host { display: flex; flex-direction: column; gap: 0.5rem; text-align: left; }
    .psd-hint { margin: 0; font-size: 0.72rem; color: var(--text-3); }
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
export class SupplierPickerComponent {
  readonly picker = input.required<SupplierPicker>();
  protected readonly pcts = discountPcts;
}
