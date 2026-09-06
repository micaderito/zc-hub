import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ProductDraftStore } from '../../product-draft.store';

/** Costo, ganancia y precios sugeridos — mismo motor de cálculo que la sección Precios. */
@Component({
  selector: 'zc-price-profit-section',
  standalone: true,
  imports: [FormsModule, CurrencyPipe],
  templateUrl: './price-profit-section.component.html',
  styleUrls: ['../section-shared.scss', './price-profit-section.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PriceProfitSectionComponent {
  protected readonly store = inject(ProductDraftStore);
}
