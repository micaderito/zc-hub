import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MlCategoryPrediction } from '../../../../core/services/catalog.service';
import { ProductDraftStore } from '../../product-draft.store';
import { ImageGalleryComponent } from '../image-gallery/image-gallery.component';
import { MlAttributesComponent } from '../ml-attributes/ml-attributes.component';
import { OverrideTagComponent } from '../override-tag/override-tag.component';

/**
 * Todo lo propio de la publicación de Mercado Libre: proyección, título, categoría, garantía,
 * envío, descripción y galería. Las llamadas a la API de ML (predictor, árbol, atributos) las
 * orquesta la página y llegan por input/output.
 */
@Component({
  selector: 'zc-ml-section',
  standalone: true,
  imports: [FormsModule, ImageGalleryComponent, MlAttributesComponent, OverrideTagComponent],
  templateUrl: './ml-section.component.html',
  styleUrls: ['../section-shared.scss', './ml-section.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class MlSectionComponent {
  protected readonly store = inject(ProductDraftStore);

  readonly predictions = input.required<MlCategoryPrediction[]>();
  readonly predicting = input(false);
  readonly predictError = input<string | null>(null);
  readonly attrsLoading = input(false);
  readonly attrsError = input<string | null>(null);

  readonly predict = output<void>();
  readonly applyPrediction = output<MlCategoryPrediction>();
  readonly openTree = output<void>();
  readonly clearCategory = output<void>();
}
