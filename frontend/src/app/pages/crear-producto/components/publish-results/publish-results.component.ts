import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { Channel, PublishResult } from '../../product-draft.model';

/** Resultado por canal de la publicación, con reintento del canal que falló. */
@Component({
  selector: 'zc-publish-results',
  standalone: true,
  templateUrl: './publish-results.component.html',
  styleUrls: ['../section-shared.scss', './publish-results.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PublishResultsComponent {
  readonly results = input.required<PublishResult[]>();
  readonly dismiss = output<void>();
  readonly retry = output<Channel>();
}
