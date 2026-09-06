import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ProductDraftStore } from '../../product-draft.store';

/**
 * Título de la publicación de cada variante, uno por canal. Solo aplica cuando algún canal está
 * en `one_per_variant`: ahí cada variante se publica por separado y necesita su propio título.
 */
@Component({
  selector: 'zc-variant-titles',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './variant-titles.component.html',
  styleUrls: ['../section-shared.scss', './variant-titles.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class VariantTitlesComponent {
  protected readonly store = inject(ProductDraftStore);

  protected readonly visible = computed(
    () =>
      this.store.draft().ml.mappingMode === 'one_per_variant' ||
      this.store.draft().tn.mappingMode === 'one_per_variant'
  );
}
