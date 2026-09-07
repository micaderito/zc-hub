import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ProductDraftStore } from '../../product-draft.store';
import { VariantAxis } from '../../product-draft.model';
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

  /**
   * El eje pasa a mapear el atributo elegido (o "propio" con el value vacío del <select>). Se
   * copian los `allowedValues` de ESE momento para poder resolver `value_id` al publicar (ver
   * `axisAttributes` en el backend) — si la categoría cambia después, `mlVariationAttrs` se
   * recarga pero un eje ya mapeado no se re-sincroniza solo; conviene volver a elegirlo.
   */
  onAxisAttributeChange(axis: VariantAxis, attributeId: string): void {
    const attr = this.store.mlVariationAttrs().find((a) => a.id === attributeId);
    axis.mlAttributeId = attributeId || undefined;
    axis.allowedValues = attr?.allowedValues;
    this.store.touch();
  }
}
