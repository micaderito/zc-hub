import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { BottomSheetComponent } from '../../../../shared/components/bottom-sheet/bottom-sheet.component';
import { PresenceFilter, ProductFiltersValue, StockFilter, StockSummary } from './product-filters.component';

/**
 * Filtros de Productos en el celular (opción A de docs/prototype/productos-mobile.html): buscador
 * (proyectado), chips de stock con su conteo en una fila que se desliza, y un chip "Filtros" que abre
 * una hoja con Proveedor / Alerta / Pack. Mismo `ProductFiltersValue` que `zc-product-filters`.
 */
@Component({
  selector: 'zc-phone-filters',
  standalone: true,
  imports: [BottomSheetComponent],
  styleUrl: './phone-filters.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-content />
    <div class="pf-chips" role="radiogroup" aria-label="Stock">
      @for (o of stockOptions(); track o.key) {
        <button type="button" role="radio" class="pf-chip" [class.on]="value().stock === o.key" [attr.aria-checked]="value().stock === o.key"
                (click)="set({ stock: o.key })">
          {{ o.label }} <span class="pf-n" [class.warn]="o.warn && o.count > 0">{{ o.count }}</span>
        </button>
      }
      <button type="button" class="pf-chip" [class.on]="extraCount() > 0" (click)="sheetOpen.set(true)" aria-haspopup="dialog">
        <i class="ti ti-adjustments-horizontal" aria-hidden="true"></i> Filtros
        @if (extraCount()) { <span class="pf-n">{{ extraCount() }}</span> }
      </button>
    </div>

    @if (sheetOpen()) {
      <zc-bottom-sheet title="Filtros" (closed)="sheetOpen.set(false)">
        <div class="pf-lbl">Proveedor</div>
        <div class="pf-opts">
          <button type="button" class="pf-chip" [class.on]="!value().supplier" (click)="set({ supplier: '' })">Todos</button>
          <button type="button" class="pf-chip" [class.on]="value().supplier === 'none'" (click)="set({ supplier: 'none' })">Sin proveedor</button>
          @for (s of suppliers(); track s.key) {
            <button type="button" class="pf-chip" [class.on]="value().supplier === s.key" (click)="set({ supplier: s.key })">{{ s.name }}</button>
          }
        </div>
        @for (f of presence; track f.key) {
          <div class="pf-lbl">{{ f.label }}</div>
          <div class="pf-opts">
            @for (o of f.options; track o.key) {
              <button type="button" class="pf-chip" [class.on]="value()[f.key] === o.key" (click)="setPresence(f.key, o.key)">{{ o.label }}</button>
            }
          </div>
        }
        <div class="pf-actions">
          <button type="button" class="pf-btn" (click)="set({ supplier: '', alert: 'all', pack: 'all' })" [disabled]="!extraCount()">Limpiar</button>
          <button type="button" class="pf-btn primary" (click)="sheetOpen.set(false)">Listo</button>
        </div>
      </zc-bottom-sheet>
    }
  `,
})
export class PhoneFiltersComponent {
  readonly value = input.required<ProductFiltersValue>();
  readonly summary = input<StockSummary | undefined>();
  readonly suppliers = input<Array<{ key: string; name: string }>>([]);
  readonly valueChange = output<ProductFiltersValue>();

  readonly sheetOpen = signal(false);

  readonly presence = [
    { key: 'alert' as const, label: 'Alerta de stock', options: [{ key: 'all' as PresenceFilter, label: 'Todas' }, { key: 'with' as PresenceFilter, label: 'Con alerta' }, { key: 'without' as PresenceFilter, label: 'Sin alerta' }] },
    { key: 'pack' as const, label: 'Pack', options: [{ key: 'all' as PresenceFilter, label: 'Todos' }, { key: 'with' as PresenceFilter, label: 'En un pack' }, { key: 'without' as PresenceFilter, label: 'Sin pack' }] },
  ];

  readonly stockOptions = computed(() => {
    const s = this.summary();
    return [
      { key: 'all' as StockFilter, label: 'Todos', count: s?.total ?? 0, warn: false },
      { key: 'mismatch' as StockFilter, label: 'Distinto', count: s?.mismatch ?? 0, warn: true },
      { key: 'no-stock' as StockFilter, label: 'Sin stock', count: s?.noStock ?? 0, warn: false },
      { key: 'with-stock' as StockFilter, label: 'Con stock', count: s?.withStock ?? 0, warn: false },
      { key: 'synced' as StockFilter, label: 'Mismo stock', count: s?.synced ?? 0, warn: false },
    ];
  });

  /** Cuántos de Proveedor / Alerta / Pack están puestos (el punto del chip "Filtros"). */
  readonly extraCount = computed(() => {
    const v = this.value();
    return (v.supplier ? 1 : 0) + (v.alert !== 'all' ? 1 : 0) + (v.pack !== 'all' ? 1 : 0);
  });

  set(patch: Partial<ProductFiltersValue>): void {
    this.valueChange.emit({ ...this.value(), ...patch });
  }

  setPresence(key: 'alert' | 'pack', v: PresenceFilter): void {
    this.set({ [key]: v });
  }
}
