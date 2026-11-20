import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { MlRow, TnRow } from '../../../../core/services/conflicts.service';
import { ProductThumbComponent } from '../../../../shared/components/product-thumb/product-thumb.component';

export type PairRowState = 'same' | 'diff' | 'out' | 'busy';

/** Nombre del producto sin la variante (la variante va en la línea de abajo). */
export function pairTitle(pair: { ml: MlRow; tn: TnRow }): string {
  return pair.ml.title || pair.tn.productName || '—';
}

export function pairVariant(pair: { ml: MlRow; tn: TnRow }): string | null {
  return (pair.ml.variationName || pair.tn.variantName || '').trim() || null;
}

/**
 * Fila de Productos en el celular (prototipo docs/prototype/productos-mobile.html, opción A): foto,
 * nombre, variante y SKU; a la derecha el stock de los dos canales (ámbar si no coinciden, rojo en 0)
 * y los precios en una línea chica. Tocarla emite `open` (la hoja del producto la abre la página).
 */
@Component({
  selector: 'zc-pair-row',
  standalone: true,
  imports: [ProductThumbComponent],
  styleUrl: './pair-row.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pr-row {{ state() }}" [class.sel]="selected()">
      @if (selectable()) {
        <input type="checkbox" class="pr-check" [checked]="selected()" (change)="selectToggle.emit()" aria-label="Seleccionar producto" />
      }
      <zc-product-thumb [src]="pair().ml.thumbnail || pair().tn.thumbnail" [photos]="[pair().ml.thumbnail, pair().tn.thumbnail]"
                        [title]="title()" [subtitle]="sku() ? 'SKU ' + sku() : null" />
      <button type="button" class="pr-main" (click)="open.emit()">
        <span class="pr-info">
          <span class="pr-title">{{ title() }}</span>
          <span class="pr-sub">
            @if (variant()) { <span>{{ variant() }}</span> · }<span class="pr-sku">{{ sku() || 'sin SKU' }}</span>
            @if (packName()) { <span class="zc-badge busy pr-pack"><i class="ti ti-box" aria-hidden="true"></i>{{ packName() }}</span> }
          </span>
          <span class="pr-prices"><span class="stock-dot ml"></span>{{ money(priceML()) }} · <span class="stock-dot tn"></span>{{ money(priceTN()) }}</span>
          @if (error()) { <span class="pr-err"><i class="ti ti-alert-circle" aria-hidden="true"></i> {{ error() }}</span> }
        </span>
        <span class="pr-stock">
          @if (state() === 'diff') {
            <span class="pr-pair"><span><span class="stock-dot ml"></span><b>{{ stockML() }}</b></span><span><span class="stock-dot tn"></span><b class="warn">{{ stockTN() }}</b></span></span>
            <span class="zc-badge warn"><i class="ti ti-alert-triangle" aria-hidden="true"></i>distinto</span>
          } @else if (state() === 'busy') {
            <span class="pr-pair"><span><span class="stock-dot ml"></span><b>{{ stockML() }}</b></span><span><span class="stock-dot tn"></span><b>{{ stockTN() }}</b></span></span>
            <span class="zc-badge busy"><i class="ti ti-clock" aria-hidden="true"></i>{{ pending() ? 'guardando' : 'en cola' }}</span>
          } @else {
            <span class="pr-one" [class.err]="state() === 'out'">{{ stockML() }}</span>
            <small>{{ state() === 'out' ? 'sin stock' : 'en los dos' }}</small>
          }
        </span>
      </button>
    </div>
  `,
})
export class PairRowComponent {
  readonly pair = input.required<{ ml: MlRow; tn: TnRow; sku?: string }>();
  readonly packName = input<string | null>(null);
  readonly stockML = input.required<number>();
  readonly stockTN = input.required<number>();
  readonly priceML = input<number>(0);
  readonly priceTN = input<number>(0);
  readonly pending = input(false);
  readonly stockQueued = input(false);
  readonly error = input<string | null>(null);
  readonly selectable = input(false);
  readonly selected = input(false);

  readonly open = output<void>();
  readonly selectToggle = output<void>();

  readonly title = computed(() => pairTitle(this.pair()));
  readonly variant = computed(() => pairVariant(this.pair()));
  readonly sku = computed(() => this.pair().sku || this.pair().ml.sku || this.pair().tn.sku || '');

  readonly state = computed<PairRowState>(() => {
    if (this.pending() || this.stockQueued()) return 'busy';
    if (this.stockML() !== this.stockTN()) return 'diff';
    return this.stockML() <= 0 ? 'out' : 'same';
  });

  money(v: number): string {
    return v > 0 ? '$' + Math.round(v).toLocaleString('es-AR') : '—';
  }
}
