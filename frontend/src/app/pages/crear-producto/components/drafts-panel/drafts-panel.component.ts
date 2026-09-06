import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ProductDraftStore } from '../../product-draft.store';

/** Panel "Mis borradores": abrir, eliminar y ver cuál se está editando. */
@Component({
  selector: 'zc-drafts-panel',
  standalone: true,
  imports: [DatePipe],
  templateUrl: './drafts-panel.component.html',
  styleUrls: ['../section-shared.scss', './drafts-panel.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DraftsPanelComponent {
  protected readonly store = inject(ProductDraftStore);
}
