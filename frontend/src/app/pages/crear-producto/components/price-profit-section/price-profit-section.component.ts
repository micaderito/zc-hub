import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ProductDraftStore } from '../../product-draft.store';
import { CanWriteDirective } from '../../../../shared/directives/can-write.directive';

/** Costo, ganancia y precios sugeridos — mismo motor de cálculo que la sección Precios. */
@Component({
  selector: 'zc-price-profit-section',
  standalone: true,
  imports: [FormsModule, CurrencyPipe, CanWriteDirective],
  templateUrl: './price-profit-section.component.html',
  styleUrls: ['../section-shared.scss', './price-profit-section.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PriceProfitSectionComponent {
  protected readonly store = inject(ProductDraftStore);

  /** "−25% −5%" (o "sin descuento"), igual que en Precios. */
  protected pcts(p: { discount1: number; discount2: number }): string {
    const parts = [p.discount1, p.discount2].filter((n) => n > 0).map((n) => `−${n}%`);
    return parts.length ? parts.join(' ') : 'sin descuento';
  }
}
