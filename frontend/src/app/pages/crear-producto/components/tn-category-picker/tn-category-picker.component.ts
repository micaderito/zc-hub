import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { TnCategory } from '../../../../core/services/catalog.service';
import { ProductDraftStore } from '../../product-draft.store';

/** Multi-select de categorías EXISTENTES de la tienda (TN espera ids, no nombres). */
@Component({
  selector: 'zc-tn-category-picker',
  standalone: true,
  templateUrl: './tn-category-picker.component.html',
  styleUrls: ['../section-shared.scss', './tn-category-picker.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class TnCategoryPickerComponent {
  protected readonly store = inject(ProductDraftStore);

  readonly categories = input.required<TnCategory[]>();
  readonly loading = input(false);
  readonly error = input<string | null>(null);
  readonly reload = output<void>();

  /** Índice id → breadcrumb: el chip de cada categoría elegida se resuelve en O(1). */
  private readonly pathById = computed(() => new Map(this.categories().map((c) => [c.id, c.path])));

  protected categoryName(id: number): string {
    return this.pathById().get(id) ?? `#${id}`;
  }
}
