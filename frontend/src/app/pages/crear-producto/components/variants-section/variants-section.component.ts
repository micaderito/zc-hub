import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ProductDraftStore } from '../../product-draft.store';
import { VariantPhotosComponent } from '../variant-photos/variant-photos.component';
import { VariantTitlesComponent } from '../variant-titles/variant-titles.component';

/**
 * Variantes: los ejes, la tabla (SKU, precios, "te queda", stock, código de barras) y — cuando no
 * hay variantes — los campos del producto simple. Los títulos y las fotos por variante son sus
 * propios componentes.
 */
@Component({
  selector: 'zc-variants-section',
  standalone: true,
  imports: [FormsModule, CurrencyPipe, DecimalPipe, VariantPhotosComponent, VariantTitlesComponent],
  templateUrl: './variants-section.component.html',
  styleUrls: ['../section-shared.scss', './variants-section.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class VariantsSectionComponent {
  protected readonly store = inject(ProductDraftStore);
}
