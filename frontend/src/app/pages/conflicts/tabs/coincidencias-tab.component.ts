import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MlRow, TnRow, mlLabel, tnLabel } from '../../../core/services/conflicts.service';
import { ProductThumbComponent } from '../../../shared/components/product-thumb/product-thumb.component';
import { PaginationComponent } from '../../../shared/components/pagination/pagination.component';

@Component({
  selector: 'app-conflicts-coincidencias-tab',
  standalone: true,
  imports: [CommonModule, ProductThumbComponent, PaginationComponent],
  styleUrls: ['./_conflicts-tabs-styles.scss'],
  template: `
    <p class="tab-hint">{{ paging.total }} par{{ paging.total !== 1 ? 'es' : '' }} con el mismo SKU en ML y TN. Editá el SKU si necesitás corregirlo.</p>

    @for (pair of pairs; track pair.ml.itemId + (pair.ml.variationId || '') + pair.tn.productId + pair.tn.variantId) {
      <div class="pair-card">
        <div class="pair-top-border"></div>
        <div class="pair-body">
          <div class="pair-half">
            <zc-product-thumb [src]="pair.ml.thumbnail" />
            <div class="half-info">
              <span class="zc-badge ml">ML</span>
              <div class="half-name">{{ mlLabel(pair.ml) }}</div>
            </div>
          </div>
          <div class="pair-half">
            <zc-product-thumb [src]="pair.tn.thumbnail" />
            <div class="half-info">
              <span class="zc-badge tn">TN</span>
              <div class="half-name">{{ tnLabel(pair.tn) }}</div>
            </div>
          </div>
        </div>
        <div class="pair-footer">
          <code class="sku-code">{{ pair.sku || pair.ml.sku || pair.tn.sku || '—' }}</code>
          <div class="pair-actions">
            <button type="button" class="btn-action ghost" (click)="editSku.emit({ channel: 'mercadolibre', row: pair.ml })">SKU ML</button>
            <button type="button" class="btn-action ghost" (click)="editSku.emit({ channel: 'tiendanube', row: pair.tn })">SKU TN</button>
            <button type="button" class="btn-action" (click)="editBothSku.emit({ ml: pair.ml, tn: pair.tn })">Ambos SKU</button>
          </div>
        </div>
      </div>
    }

    @if (pairs.length === 0) {
      <p class="tab-hint">Sin resultados para la búsqueda.</p>
    }

    <zc-pagination
      [currentPage]="paging.page"
      [totalPages]="paging.pages"
      [total]="paging.total"
      (prev)="pageChange.emit(paging.page - 1)"
      (next)="pageChange.emit(paging.page + 1)"
    />
  `
})
export class CoincidenciasTabComponent {
  @Input({ required: true }) pairs: { ml: MlRow; tn: TnRow; sku?: string }[] = [];
  @Input() paging: { page: number; limit: number; total: number; pages: number } = { page: 1, limit: 25, total: 0, pages: 1 };
  @Output() editSku = new EventEmitter<{ channel: 'mercadolibre' | 'tiendanube'; row: MlRow | TnRow }>();
  @Output() editBothSku = new EventEmitter<{ ml: MlRow; tn: TnRow }>();
  @Output() pageChange = new EventEmitter<number>();

  protected mlLabel = mlLabel;
  protected tnLabel = tnLabel;
}
