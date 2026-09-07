import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
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

  /**
   * `results()[0]`/`[1]` asumía SIEMPRE 2 resultados — con un solo canal (reintento de uno solo,
   * o el backend devolviendo un array de 1) `results()[1]` es `undefined` y `.status` explota.
   * `every` funciona igual con 1 o 2 elementos, y con 0 (`dismiss` ya cerró el panel) da `true`
   * sin re-render raro.
   */
  readonly allOk = computed(() => this.results().every((r) => r.status === 'ok'));
}
