import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ProductDraftStore } from '../../product-draft.store';
import { VariantPhotosDialogComponent } from '../variant-photos-dialog/variant-photos-dialog.component';

/**
 * Fotos por variante: una fila por variante con el conteo y un botón que abre el modal.
 *
 * Con el modal cerrado, el DOM de esta sección son N filas — antes eran `variantes × (fotos ML +
 * fotos TN)` botones e `<img>` (225 de cada uno con 5 variantes y 45 fotos).
 */
@Component({
  selector: 'zc-variant-photos',
  standalone: true,
  imports: [VariantPhotosDialogComponent],
  templateUrl: './variant-photos.component.html',
  styleUrl: './variant-photos.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class VariantPhotosComponent {
  protected readonly store = inject(ProductDraftStore);

  /** Se guarda el ID, no la variante: así sobrevive a un `normalizeDraft` o a abrir otro borrador. */
  private readonly openForVariantId = signal<string | null>(null);

  protected readonly hasImages = computed(
    () => this.store.draft().ml.images.length > 0 || this.store.draft().tn.images.length > 0
  );

  protected readonly openVariant = computed(
    () => this.store.draft().variants.find((v) => v.id === this.openForVariantId()) ?? null
  );

  protected open(id: string): void {
    this.openForVariantId.set(id);
  }

  protected close(): void {
    this.openForVariantId.set(null);
  }
}
