import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ProductDraftStore } from '../../product-draft.store';

/**
 * Características de la categoría de ML. Las obligatorias se muestran siempre; las opcionales
 * (que en algunas categorías son 50-150) solo se arman cuando se abre el desplegable.
 */
@Component({
  selector: 'zc-ml-attributes',
  standalone: true,
  imports: [FormsModule, NgTemplateOutlet],
  templateUrl: './ml-attributes.component.html',
  styleUrls: ['../section-shared.scss', './ml-attributes.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class MlAttributesComponent {
  protected readonly store = inject(ProductDraftStore);

  readonly loading = input(false);
  readonly error = input<string | null>(null);
}
