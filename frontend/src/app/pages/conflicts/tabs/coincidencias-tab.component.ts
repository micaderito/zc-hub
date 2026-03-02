import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ConflictAnalysis, MlRow, TnRow, mlLabel, tnLabel, matchSearchByTokens } from '../../../core/services/conflicts.service';

@Component({
  selector: 'app-conflicts-coincidencias-tab',
  standalone: true,
  imports: [CommonModule],
  styleUrls: ['./_conflicts-tabs-styles.scss'],
  template: `
    <section>
      <p>Pares con el mismo SKU en Mercado Libre y Tienda Nube. Acá solo gestionás el SKU (editar en ML, TN o ambos).</p>
      <div class="grid-scroll">
      <table class="table table-coincidencias">
        <colgroup>
          <col class="col-sku" />
          <col class="col-ml" />
          <col class="col-tn" />
          <col class="col-actions" />
        </colgroup>
        <thead>
          <tr>
            <th>SKU</th>
            <th>Descripción</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
          @for (pair of filteredMatched; track pair.ml.itemId + (pair.ml.variationId || '') + pair.tn.productId + pair.tn.variantId) {
            <tr>
              <td class="col-sku"><code>{{ pair.sku || pair.ml.sku || pair.tn.sku || '—' }}</code></td>
              <td class="col-ml pair-cell pair-cell-ml">
                @if (pair.ml.thumbnail) { <img [src]="pair.ml.thumbnail" alt="" /> }
                @else { <span class="no-thumb">—</span> }
                <span class="pair-label">{{ mlLabel(pair.ml) }}</span>
              </td>
              <td class="col-tn pair-cell pair-cell-tn">
                @if (pair.tn.thumbnail) { <img [src]="pair.tn.thumbnail" alt="" /> }
                @else { <span class="no-thumb">—</span> }
                <span class="pair-label">{{ tnLabel(pair.tn) }}</span>
              </td>
              <td class="col-actions cell-actions">
                <button type="button" (click)="editSku.emit({ channel: 'mercadolibre', row: pair.ml })">Editar SKU ML</button>
                <button type="button" (click)="editSku.emit({ channel: 'tiendanube', row: pair.tn })">Editar SKU TN</button>
                <button type="button" (click)="editBothSku.emit({ ml: pair.ml, tn: pair.tn })">Editar ambos SKU</button>
              </td>
            </tr>
          }
        </tbody>
      </table>
      </div>
    </section>
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
    const searchablePairs = this.analysis.matched.map((pair) => {
      const parts = [
        pair.ml.title,
        pair.ml.sku,
        pair.ml.variationName,
        pair.tn.productName,
        pair.tn.sku,
        pair.tn.variantName
      ].filter(Boolean);
      return [parts.join(' '), pair] as const;
    });
    return searchablePairs
      .filter(([searchable]) => matchSearchByTokens(q, searchable))
      .map(([, pair]) => pair);
  }
}
