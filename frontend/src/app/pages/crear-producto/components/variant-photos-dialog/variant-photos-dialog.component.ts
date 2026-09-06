import { ChangeDetectionStrategy, Component, HostListener, computed, inject, input, output, signal } from '@angular/core';
import { PaginationComponent } from '../../../../shared/components/pagination/pagination.component';
import { ProductThumbComponent } from '../../../../shared/components/product-thumb/product-thumb.component';
import { Channel, DraftImage, ProductVariant, positiveLimit } from '../../product-draft.model';
import { ML_MAX_PICTURES_PER_VAR_FALLBACK, ProductDraftStore } from '../../product-draft.store';

/** Fotos por página dentro del modal: acota el DOM sin necesitar virtual scroll. */
const PAGE_SIZE = 24;

/**
 * Elegir qué fotos muestra una variante, en un modal.
 *
 * Antes esto era una grilla inline que repetía TODAS las fotos de ambos canales en la fila de cada
 * variante: con 33 fotos de TN + 12 de ML y 5 variantes eran 225 `<button>` y 225 `<img>` en la
 * página, y era la causa de que el click tardara en marcarse. Acá la galería aparece una sola vez,
 * solo mientras el modal está abierto, y con miniaturas grandes — a 40 px no se distinguía una
 * foto de otra, que era el otro problema.
 */
@Component({
  selector: 'zc-variant-photos-dialog',
  standalone: true,
  imports: [PaginationComponent, ProductThumbComponent],
  templateUrl: './variant-photos-dialog.component.html',
  styleUrl: './variant-photos-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class VariantPhotosDialogComponent {
  protected readonly store = inject(ProductDraftStore);

  readonly variant = input.required<ProductVariant>();
  readonly close = output<void>();

  protected readonly mlPage = signal(1);
  protected readonly tnPage = signal(1);

  protected readonly mlImages = computed(() => this.store.draft().ml.images);
  protected readonly tnImages = computed(() => this.store.draft().tn.images);

  /**
   * La variante tal como está AHORA en el draft.
   *
   * Es un método y NO un `computed()` a propósito: la variante se muta en el lugar, así que un
   * computed devolvería siempre el MISMO objeto, Angular lo compararía con `Object.is`, lo daría
   * por "sin cambios" y no avisaría a los computeds que dependen de él — los contadores se
   * quedaban congelados aunque el modelo sí hubiera cambiado. Cada computed de abajo lee
   * `store.draft()` por su cuenta (que sí cambia de referencia en cada `touch()`) y de ahí deriva
   * un valor primitivo, que es lo que se compara bien.
   */
  private liveVariant(): ProductVariant {
    return this.store.draft().variants.find((v) => v.id === this.variant().id) ?? this.variant();
  }

  /** Tope real de fotos por variación en ML (el 0 que informa ML no es un límite válido). */
  protected readonly mlLimit = computed(() =>
    positiveLimit(this.store.mlMaxPicturesPerVar(), ML_MAX_PICTURES_PER_VAR_FALLBACK)
  );
  protected readonly mlSelectedCount = computed(() => this.liveVariant().ml.pictureIds.length);
  protected readonly tnSelectedCount = computed(() => this.liveVariant().tn.imageIds.length);
  protected readonly mlAtLimit = computed(() => this.mlSelectedCount() >= this.mlLimit());

  /* Paginación local, con la página clampeada contra el total (patrón de packs-tab). */
  protected readonly mlTotalPages = computed(() => Math.max(1, Math.ceil(this.mlImages().length / PAGE_SIZE)));
  protected readonly tnTotalPages = computed(() => Math.max(1, Math.ceil(this.tnImages().length / PAGE_SIZE)));
  protected readonly mlEffectivePage = computed(() => Math.min(this.mlPage(), this.mlTotalPages()));
  protected readonly tnEffectivePage = computed(() => Math.min(this.tnPage(), this.tnTotalPages()));
  protected readonly mlPageImages = computed(() => this.pageOf(this.mlImages(), this.mlEffectivePage()));
  protected readonly tnPageImages = computed(() => this.pageOf(this.tnImages(), this.tnEffectivePage()));

  private pageOf(images: DraftImage[], page: number): DraftImage[] {
    const start = (page - 1) * PAGE_SIZE;
    return images.slice(start, start + PAGE_SIZE);
  }

  protected isSelected(channel: Channel, imageId: string): boolean {
    const v = this.liveVariant();
    return channel === 'ml' ? this.store.isVariantMlImage(v, imageId) : this.store.isVariantTnImage(v, imageId);
  }

  protected toggle(channel: Channel, imageId: string): void {
    const v = this.liveVariant();
    if (channel === 'ml') this.store.toggleVariantMlImage(v, imageId);
    else this.store.toggleVariantTnImage(v, imageId);
  }

  /** Un tile solo se bloquea si sumaría una foto por encima del tope; deseleccionar siempre se puede. */
  protected isDisabled(channel: Channel, imageId: string): boolean {
    return channel === 'ml' && this.mlAtLimit() && !this.isSelected('ml', imageId);
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.close.emit();
  }
}
