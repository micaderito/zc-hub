import { Component, ChangeDetectionStrategy, ElementRef, HostListener, computed, inject, input, output, signal } from '@angular/core';

export type StockFilter = 'all' | 'mismatch' | 'synced' | 'no-stock' | 'with-stock';

export interface StockSummary {
  total: number;
  mismatch: number;
  synced: number;
  noStock: number;
  withStock: number;
}

/** `''` = todos, `'none'` = sin proveedor, si no la `key` del proveedor. */
export type SupplierFilter = string;
/** Con / sin regla de alerta de stock, o modelo de algún pack del hub (Productos → Packs) o no. */
export type PresenceFilter = 'all' | 'with' | 'without';

export interface ProductFiltersValue {
  stock: StockFilter;
  supplier: SupplierFilter;
  alert: PresenceFilter;
  pack: PresenceFilter;
}

type Menu = 'supplier' | 'alert' | 'pack';

/**
 * Panel de filtros de Productos: una sola tarjeta con el buscador arriba (proyectado) y una hilera
 * abajo. Stock es un segmentado con sus conteos siempre a la vista (es lo de todos los días);
 * Proveedor, Alerta y Pack son botones que abren un menú corto y, con algo elegido, muestran el
 * valor y una × para sacarlo. Diseño: docs/prototype/productos-filtros.html (opción D).
 */
@Component({
  selector: 'zc-product-filters',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './product-filters.component.scss',
  template: `
    <div class="fpanel">
      <div class="row1"><ng-content /></div>
      <div class="row2">
        <span class="lbl" id="pf-stock-lbl">Stock</span>
        <div class="sseg" role="radiogroup" aria-labelledby="pf-stock-lbl">
          @for (o of stockOptions(); track o.key) {
            <button type="button" role="radio" [class.sel]="value().stock === o.key" [attr.aria-checked]="value().stock === o.key"
                    (click)="set({ stock: o.key })">
              {{ o.label }} <span class="cnt" [class.ok]="o.variant === 'ok'" [class.warn]="o.variant === 'warn'">{{ o.count }}</span>
            </button>
          }
        </div>
        <span class="vsep" aria-hidden="true"></span>

        <div class="fwrap">
          <button type="button" class="fbtn" [class.on]="!!value().supplier" aria-haspopup="menu"
                  [attr.aria-expanded]="open() === 'supplier'" (click)="toggle('supplier')">
            <i class="ti ti-building-store" aria-hidden="true"></i>
            @if (value().supplier) { <span class="val">{{ supplierLabel() }}</span> } @else { Proveedor }
          </button>
          @if (value().supplier) {
            <button type="button" class="fclear" (click)="set({ supplier: '' })" aria-label="Sacar filtro de proveedor"><i class="ti ti-x" aria-hidden="true"></i></button>
          }
          @if (open() === 'supplier') {
            <div class="pop" role="menu">
              <button type="button" role="menuitemradio" class="o" [class.sel]="!value().supplier" [attr.aria-checked]="!value().supplier" (click)="pick({ supplier: '' })">
                <i class="ti" [class.ti-check]="!value().supplier" aria-hidden="true"></i> Todos
              </button>
              <button type="button" role="menuitemradio" class="o" [class.sel]="value().supplier === 'none'" [attr.aria-checked]="value().supplier === 'none'" (click)="pick({ supplier: 'none' })">
                <i class="ti" [class.ti-check]="value().supplier === 'none'" aria-hidden="true"></i> Sin proveedor
              </button>
              @if (suppliers().length) {
                <hr />
                <div class="h">Proveedores</div>
                @for (s of suppliers(); track s.key) {
                  <button type="button" role="menuitemradio" class="o" [class.sel]="value().supplier === s.key" [attr.aria-checked]="value().supplier === s.key" (click)="pick({ supplier: s.key })">
                    <i class="ti" [class.ti-check]="value().supplier === s.key" aria-hidden="true"></i> {{ s.name }}
                  </button>
                }
              }
            </div>
          }
        </div>

        @for (f of presenceFilters; track f.key) {
          <div class="fwrap">
            <button type="button" class="fbtn" [class.on]="value()[f.key] !== 'all'" aria-haspopup="menu"
                    [attr.aria-expanded]="open() === f.key" (click)="toggle(f.key)">
              <i [class]="'ti ' + f.icon" aria-hidden="true"></i>
              @if (value()[f.key] === 'all') { {{ f.label }} } @else { <span class="val">{{ value()[f.key] === 'with' ? f.with : f.without }}</span> }
            </button>
            @if (value()[f.key] !== 'all') {
              <button type="button" class="fclear" (click)="set(presence(f.key, 'all'))" [attr.aria-label]="'Sacar filtro de ' + f.label.toLowerCase()"><i class="ti ti-x" aria-hidden="true"></i></button>
            }
            @if (open() === f.key) {
              <div class="pop" role="menu">
                @for (o of presenceOptions(f); track o.key) {
                  <button type="button" role="menuitemradio" class="o" [class.sel]="value()[f.key] === o.key" [attr.aria-checked]="value()[f.key] === o.key"
                          (click)="pick(presence(f.key, o.key))">
                    <i class="ti" [class.ti-check]="value()[f.key] === o.key" aria-hidden="true"></i> {{ o.label }}
                  </button>
                }
              </div>
            }
          </div>
        }

        @if (anyExtra()) {
          <button type="button" class="clear" (click)="set({ supplier: '', alert: 'all', pack: 'all' })">Limpiar</button>
        }
      </div>
    </div>
  `,
})
export class ProductFiltersComponent {
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly value = input.required<ProductFiltersValue>();
  readonly summary = input<StockSummary | undefined>();
  readonly suppliers = input<Array<{ key: string; name: string }>>([]);
  readonly valueChange = output<ProductFiltersValue>();

  readonly open = signal<Menu | null>(null);

  readonly presenceFilters = [
    { key: 'alert' as const, label: 'Alerta', icon: 'ti-bell', all: 'Todas', with: 'Con alerta', without: 'Sin alerta' },
    { key: 'pack' as const, label: 'Pack', icon: 'ti-packages', all: 'Todos', with: 'En un pack', without: 'Sin pack' },
  ];

  readonly stockOptions = computed(() => {
    const s = this.summary();
    return [
      { key: 'all' as StockFilter, label: 'Todos', count: s?.total ?? 0, variant: null },
      { key: 'mismatch' as StockFilter, label: 'Stock distinto', count: s?.mismatch ?? 0, variant: 'warn' },
      { key: 'synced' as StockFilter, label: 'Mismo stock', count: s?.synced ?? 0, variant: 'ok' },
      { key: 'no-stock' as StockFilter, label: 'Sin stock', count: s?.noStock ?? 0, variant: null },
      { key: 'with-stock' as StockFilter, label: 'Con stock', count: s?.withStock ?? 0, variant: 'ok' },
    ];
  });

  readonly supplierLabel = computed(() => {
    const key = this.value().supplier;
    if (key === 'none') return 'Sin proveedor';
    return this.suppliers().find((s) => s.key === key)?.name ?? key;
  });

  readonly anyExtra = computed(() => {
    const v = this.value();
    return !!v.supplier || v.alert !== 'all' || v.pack !== 'all';
  });

  presenceOptions(f: (typeof this.presenceFilters)[number]): Array<{ key: PresenceFilter; label: string }> {
    return [{ key: 'all', label: f.all }, { key: 'with', label: f.with }, { key: 'without', label: f.without }];
  }

  presence(key: 'alert' | 'pack', v: PresenceFilter): Partial<ProductFiltersValue> {
    return { [key]: v };
  }

  toggle(menu: Menu): void {
    this.open.update((cur) => (cur === menu ? null : menu));
  }

  set(patch: Partial<ProductFiltersValue>): void {
    this.valueChange.emit({ ...this.value(), ...patch });
  }

  pick(patch: Partial<ProductFiltersValue>): void {
    this.open.set(null);
    this.set(patch);
  }

  @HostListener('document:click', ['$event'])
  onDocClick(ev: MouseEvent): void {
    const target = ev.target as Element | null;
    // Afuera del panel, o en el panel pero fuera de un botón con menú: se cierra.
    if (this.open() && (!this.host.nativeElement.contains(target) || !target?.closest('.fwrap'))) this.open.set(null);
  }

  @HostListener('document:keydown.escape')
  onEsc(): void {
    this.open.set(null);
  }
}
