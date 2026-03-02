import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TnRow, tnLabel, matchSearchByTokens } from '../../../core/services/conflicts.service';

@Component({
  selector: 'app-conflicts-solo-tn-tab',
  standalone: true,
  imports: [CommonModule],
  styleUrls: ['./_conflicts-tabs-styles.scss'],
  template: `
    <section>
      <p>Variantes en Tienda Nube cuyo SKU no existe en Mercado Libre. Vincular manualmente con una publicación de ML.</p>
      <div class="grid-scroll">
        <table class="table table-with-thumb">
          <thead><tr><th></th><th>TN (producto / variante)</th><th>SKU actual</th><th></th></tr></thead>
          <tbody>
            @for (row of filteredRows; track row.productId + row.variantId) {
              <tr>
                <td class="thumb">@if (row.thumbnail) { <img [src]="row.thumbnail" alt="" /> }</td>
                <td>{{ tnLabel(row) }}</td>
                <td><code>{{ row.sku || '—' }}</code></td>
                <td>
                  <button type="button" (click)="editSku.emit({ channel: 'tiendanube', row })">Editar SKU</button>
                  <button type="button" (click)="linkFromTn.emit(row)">Vincular con ML</button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </section>
  `
})
export class SoloTnTabComponent {
  @Input({ required: true }) rows: TnRow[] = [];
  @Input() searchQuery = '';
  @Output() editSku = new EventEmitter<{ channel: 'tiendanube'; row: TnRow }>();
  @Output() linkFromTn = new EventEmitter<TnRow>();

  protected tnLabel = tnLabel;

  get filteredRows(): TnRow[] {
    const q = this.searchQuery.trim();
    if (!q) return this.rows;
    return this.rows.filter((r) => {
      const searchable = [r.productName, r.sku, r.variantName].filter(Boolean).join(' ');
      return matchSearchByTokens(q, searchable);
    });
  }
}
