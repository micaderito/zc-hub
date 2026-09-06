import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ProductDraftStore } from '../../product-draft.store';

/** Datos que se comparten entre ambos canales (nombre base, marca, código de barras, medidas). */
@Component({
  selector: 'zc-common-data-section',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './common-data-section.component.html',
  styleUrl: '../section-shared.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class CommonDataSectionComponent {
  protected readonly store = inject(ProductDraftStore);
}
