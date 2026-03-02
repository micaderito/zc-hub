import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MlRow, mlLabel, matchSearchByTokens } from '../../../core/services/conflicts.service';

@Component({
  selector: 'app-conflicts-solo-ml-tab',
  standalone: true,
  imports: [CommonModule],
  styleUrls: ['./_conflicts-tabs-styles.scss'],
  template: `
    <section>
      <p>Publicaciones en Mercado Libre cuyo SKU no existe en Tienda Nube. Vincular manualmente con una variante de TN.</p>
      <div class="grid-scroll">
        <table class="table table-with-thumb">
          <thead><tr><th></th><th>ML (ítem / variante)</th><th>SKU actual</th><th></th></tr></thead>
          <tbody>
            @for (row of filteredRows; track row.itemId + (row.variationId || '')) {
              <tr>
                <td class="thumb">@if (row.thumbnail) { <img [src]="row.thumbnail" alt="" /> }</td>
                <td>{{ mlLabel(row) }}</td>
                <td><code>{{ row.sku || '—' }}</code></td>
                <td>
                  <button type="button" (click)="editSku.emit({ channel: 'mercadolibre', row })">Editar SKU</button>
                  <button type="button" (click)="linkFromMl.emit(row)">Vincular con TN</button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </section>
  `
})
export class SoloMlTabComponent {
  @Input({ required: true }) rows: MlRow[] = [];
  @Input() searchQuery = '';
  @Output() editSku = new EventEmitter<{ channel: 'mercadolibre'; row: MlRow }>();
  @Output() linkFromMl = new EventEmitter<MlRow>();

  protected mlLabel = mlLabel;

  get filteredRows(): MlRow[] {
    const q = this.searchQuery.trim();
    if (!q) return this.rows;
    return this.rows.filter((r) => {
      const searchable = [r.title, r.sku, r.variationName].filter(Boolean).join(' ');
      return matchSearchByTokens(q, searchable);
    });
  }
}
