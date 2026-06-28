import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ConflictAnalysis, MlRow, TnRow, mlLabel, tnLabel, matchSearchByTokens } from '../../../core/services/conflicts.service';

@Component({
  selector: 'app-conflicts-coincidencias-tab',
  standalone: true,
  imports: [CommonModule],
  styleUrls: ['./_conflicts-tabs-styles.scss'],
  template: `
    <p class="tab-hint">{{ filteredMatched.length }} par{{ filteredMatched.length !== 1 ? 'es' : '' }} con el mismo SKU en ML y TN. Editá el SKU si necesitás corregirlo.</p>

    @for (pair of filteredMatched; track pair.ml.itemId + (pair.ml.variationId || '') + pair.tn.productId + pair.tn.variantId) {
      <div class="pair-card">
        <div class="pair-top-border"></div>
        <div class="pair-body">
          <div class="pair-half">
            @if (pair.ml.thumbnail) { <img [src]="pair.ml.thumbnail" alt="" /> }
            @else { <span class="no-thumb"><i class="ti ti-photo-off" aria-hidden="true"></i></span> }
            <div class="half-info">
              <span class="channel-badge ml">ML</span>
              <div class="half-name">{{ mlLabel(pair.ml) }}</div>
            </div>
          </div>
          <div class="pair-half">
            @if (pair.tn.thumbnail) { <img [src]="pair.tn.thumbnail" alt="" /> }
            @else { <span class="no-thumb"><i class="ti ti-photo-off" aria-hidden="true"></i></span> }
            <div class="half-info">
              <span class="channel-badge tn">TN</span>
              <div class="half-name">{{ tnLabel(pair.tn) }}</div>
            </div>
          </div>
        </div>
        <div class="pair-footer">
          <span class="sku-code">{{ pair.sku || pair.ml.sku || pair.tn.sku || '—' }}</span>
          <div class="pair-actions">
            <button type="button" class="btn-action ghost" (click)="editSku.emit({ channel: 'mercadolibre', row: pair.ml })">SKU ML</button>
            <button type="button" class="btn-action ghost" (click)="editSku.emit({ channel: 'tiendanube', row: pair.tn })">SKU TN</button>
            <button type="button" class="btn-action" (click)="editBothSku.emit({ ml: pair.ml, tn: pair.tn })">Ambos SKU</button>
          </div>
        </div>
      </div>
    }

    @if (filteredMatched.length === 0) {
      <p class="tab-hint">Sin resultados para la búsqueda.</p>
    }
  `
})
export class CoincidenciasTabComponent {
  @Input({ required: true }) analysis!: ConflictAnalysis;
  @Input({ required: true }) searchQuery = '';
  @Output() editSku = new EventEmitter<{ channel: 'mercadolibre' | 'tiendanube'; row: MlRow | TnRow }>();
  @Output() editBothSku = new EventEmitter<{ ml: MlRow; tn: TnRow }>();

  protected mlLabel = mlLabel;
  protected tnLabel = tnLabel;

  get filteredMatched(): typeof this.analysis.matched {
    const q = this.searchQuery.trim();
    if (!q) return this.analysis.matched;
    return this.analysis.matched.filter((pair) => {
      const searchable = [pair.ml.title, pair.ml.sku, pair.ml.variationName, pair.tn.productName, pair.tn.sku, pair.tn.variantName].filter(Boolean).join(' ');
      return matchSearchByTokens(q, searchable);
    });
  }
}
