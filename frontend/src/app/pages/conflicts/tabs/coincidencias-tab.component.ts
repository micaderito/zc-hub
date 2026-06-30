import { Component, Input, Output, EventEmitter, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ConflictAnalysis, MlRow, TnRow, mlLabel, tnLabel, matchSearchByTokens } from '../../../core/services/conflicts.service';
import { ProductThumbComponent } from '../../../shared/components/product-thumb/product-thumb.component';
import { PaginationComponent } from '../../../shared/components/pagination/pagination.component';

const PAGE_SIZE = 20;

@Component({
  selector: 'app-conflicts-coincidencias-tab',
  standalone: true,
  imports: [CommonModule, ProductThumbComponent, PaginationComponent],
  styleUrls: ['./_conflicts-tabs-styles.scss'],
  template: `
    <p class="tab-hint">{{ filtered.length }} par{{ filtered.length !== 1 ? 'es' : '' }} con el mismo SKU en ML y TN. Editá el SKU si necesitás corregirlo.</p>

    @for (pair of page; track pair.ml.itemId + (pair.ml.variationId || '') + pair.tn.productId + pair.tn.variantId) {
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

    @if (filtered.length === 0) {
      <p class="tab-hint">Sin resultados para la búsqueda.</p>
    }

    <zc-pagination
      [currentPage]="currentPage()"
      [totalPages]="totalPages"
      [total]="filtered.length"
      (prev)="currentPage.set(currentPage() - 1)"
      (next)="currentPage.set(currentPage() + 1)"
    />
  `
})
export class CoincidenciasTabComponent {
  @Input({ required: true }) analysis!: ConflictAnalysis;
  @Input({ required: true }) set searchQuery(q: string) {
    this._searchQuery = q;
    this.currentPage.set(1);
  }
  @Output() editSku = new EventEmitter<{ channel: 'mercadolibre' | 'tiendanube'; row: MlRow | TnRow }>();
  @Output() editBothSku = new EventEmitter<{ ml: MlRow; tn: TnRow }>();

  protected mlLabel = mlLabel;
  protected tnLabel = tnLabel;
  protected currentPage = signal(1);

  private _searchQuery = '';

  get filtered(): typeof this.analysis.matched {
    const q = this._searchQuery.trim();
    if (!q) return this.analysis.matched;
    return this.analysis.matched.filter((pair) => {
      const s = [pair.ml.title, pair.ml.sku, pair.ml.variationName, pair.tn.productName, pair.tn.sku, pair.tn.variantName].filter(Boolean).join(' ');
      return matchSearchByTokens(q, s);
    });
  }

  get totalPages(): number {
    return Math.max(1, Math.ceil(this.filtered.length / PAGE_SIZE));
  }

  get page(): typeof this.analysis.matched {
    const start = (this.currentPage() - 1) * PAGE_SIZE;
    return this.filtered.slice(start, start + PAGE_SIZE);
  }
}
