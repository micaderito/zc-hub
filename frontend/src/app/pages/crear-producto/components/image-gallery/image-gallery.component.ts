import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Channel } from '../../product-draft.model';
import { ProductDraftStore } from '../../product-draft.store';

/** Galería de un canal: subir fotos, reordenar con drag y elegir la portada (la primera). */
@Component({
  selector: 'zc-image-gallery',
  standalone: true,
  templateUrl: './image-gallery.component.html',
  styleUrl: './image-gallery.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ImageGalleryComponent {
  protected readonly store = inject(ProductDraftStore);

  readonly channel = input.required<Channel>();
  readonly limit = input.required<number>();

  /** Solo el error de ESTA galería: el de otro canal o el de las variantes se muestra en su lugar. */
  protected readonly ownError = computed(() => {
    const scope = this.channel() === 'ml' ? 'ml-gallery' : 'tn-gallery';
    return this.store.imageErrorScope() === scope ? this.store.imageError() : null;
  });

  protected images() {
    return this.store.images(this.channel());
  }
}
