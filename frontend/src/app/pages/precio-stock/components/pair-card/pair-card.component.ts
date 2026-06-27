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
  readonly isCollapsed = input(false);

  readonly toggleCollapse = output<void>();
  readonly updatePrices = output<void>();
  readonly syncStock = output<void>();

  protected mlLabel = mlLabel;
  protected tnLabel = tnLabel;

  get isStockSynced(): boolean {
    return this.displayStockML() === this.displayStockTN();
  }
}
