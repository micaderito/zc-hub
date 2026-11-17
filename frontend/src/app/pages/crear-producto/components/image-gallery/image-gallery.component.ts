import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Channel } from '../../product-draft.model';
import { ProductThumbComponent } from '../../../../shared/components/product-thumb/product-thumb.component';
import { ProductDraftStore } from '../../product-draft.store';

/** Galería de un canal: subir fotos, reordenar con drag y elegir la portada (la primera). */
@Component({
  selector: 'zc-image-gallery',
  standalone: true,
  imports: [ProductThumbComponent],
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

  /** El zoom recorre la galería entera, con cada foto en grande (el preview es una miniatura). */
  protected readonly zoomPhotos = computed(() => this.images().map((img) => this.store.fullImageUrl(img)));

  protected images() {
    return this.store.images(this.channel());
  }
}
