import { ChangeDetectionStrategy, Component, HostListener, input, output } from '@angular/core';
import { MlCategoryNode, MlCategoryRef } from '../../../../core/services/catalog.service';

/**
 * Explorador del árbol de categorías de ML. Solo se puede publicar en una categoría HOJA, así que
 * el botón de confirmar aparece únicamente cuando el nodo actual lo es.
 */
@Component({
  selector: 'zc-ml-category-dialog',
  standalone: true,
  templateUrl: './ml-category-dialog.component.html',
  styleUrls: ['../section-shared.scss', './ml-category-dialog.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class MlCategoryDialogComponent {
  readonly node = input<MlCategoryNode | null>(null);
  readonly children = input.required<MlCategoryRef[]>();
  readonly loading = input(false);
  readonly error = input<string | null>(null);

  readonly navigate = output<string>();
  readonly breadcrumb = output<string | null>();
  readonly select = output<void>();
  readonly close = output<void>();

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.close.emit();
  }
}
