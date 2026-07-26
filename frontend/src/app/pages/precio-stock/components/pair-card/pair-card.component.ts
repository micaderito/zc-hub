import { Component, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CurrencyInputDirective } from '../../../../directives/currency-input.directive';
import { MlRow, TnRow, mlLabel, tnLabel } from '../../../../core/services/conflicts.service';

export interface PairPrices {
  priceML: number;
  priceTN: number;
  syncStock: number;
}

@Component({
  selector: 'zc-pair-card',
  standalone: true,
  imports: [FormsModule, CurrencyInputDirective],
  templateUrl: './pair-card.component.html',
  styleUrl: './pair-card.component.scss',
})
export class PairCardComponent {
  readonly pair = input.required<{ ml: MlRow; tn: TnRow; sku?: string }>();
  readonly prices = input.required<PairPrices>();
  readonly displayStockML = input.required<number>();
  readonly displayStockTN = input.required<number>();
  readonly isPending = input(false);
  /**
   * Hay un cambio de stock esperando en la cola de ML: todavía no se aplicó, así que los canales
   * difieren por eso y no por un conflicto. Ver `isStockQueued` en el badge.
   */
  readonly isStockQueued = input(false);
  readonly isCollapsed = input(false);
  readonly syncError = input<string | null>(null);

  readonly toggleCollapse = output<void>();
  readonly updatePrices = output<void>();
  readonly syncStock = output<void>();
  readonly showHistory = output<void>();

  protected mlLabel = mlLabel;
  protected tnLabel = tnLabel;

  get isStockSynced(): boolean {
    return this.displayStockML() === this.displayStockTN();
  }

  /**
   * Estado del badge de stock. Una escritura en cola gana sobre la comparación de valores: mientras
   * el worker no la aplicó, los canales difieren por eso y llamarlo "Stock distinto" sería avisar
   * de un conflicto que no existe. Si la tarea falla sale de la cola, y ahí el conflicto sí es real.
   */
  get stockBadge(): { label: string; icon: string; variant: 'ok' | 'warn' | 'busy' } {
    if (this.isStockQueued()) return { label: 'Actualizándose…', icon: 'ti-clock', variant: 'busy' };
    return this.isStockSynced
      ? { label: 'Mismo stock', icon: 'ti-check', variant: 'ok' }
      : { label: 'Stock distinto', icon: 'ti-alert-triangle', variant: 'warn' };
  }
}
