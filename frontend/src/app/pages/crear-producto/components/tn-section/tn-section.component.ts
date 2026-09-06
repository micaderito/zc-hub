import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TnCategory } from '../../../../core/services/catalog.service';
import { ProductDraftStore } from '../../product-draft.store';
import { ImageGalleryComponent } from '../image-gallery/image-gallery.component';
import { OverrideTagComponent } from '../override-tag/override-tag.component';
import { TnCategoryPickerComponent } from '../tn-category-picker/tn-category-picker.component';

/**
 * Todo lo propio del producto de Tienda Nube: proyección, nombre (es/pt), handle, categorías,
 * SEO, video, descripción y galería. La lista de categorías y la generación de SEO las resuelve
 * la página.
 */
@Component({
  selector: 'zc-tn-section',
  standalone: true,
  imports: [FormsModule, ImageGalleryComponent, OverrideTagComponent, TnCategoryPickerComponent],
  templateUrl: './tn-section.component.html',
  styleUrl: '../section-shared.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class TnSectionComponent {
  protected readonly store = inject(ProductDraftStore);

  readonly categories = input.required<TnCategory[]>();
  readonly categoriesLoading = input(false);
  readonly categoriesError = input<string | null>(null);
  readonly seoGenerating = input(false);
  readonly seoError = input<string | null>(null);

  readonly reloadCategories = output<void>();
  readonly generateSeo = output<void>();
}
