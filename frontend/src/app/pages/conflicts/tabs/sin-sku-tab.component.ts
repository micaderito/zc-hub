import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MlRow, TnRow, mlLabel, tnLabel, matchSearchByTokens } from '../../../core/services/conflicts.service';

@Component({
  selector: 'app-conflicts-sin-sku-tab',
  standalone: true,
  imports: [CommonModule],
  styleUrls: ['./_conflicts-tabs-styles.scss'],
  template: `
    <section>
      <p>Productos sin SKU en ML o TN. Asigná un SKU (se actualiza en la plataforma) y luego vinculá si corresponde.</p>
      <h3>Sin SKU en Mercado Libre</h3>
      <div class="grid-scroll">
        <table class="table table-with-thumb">
          <thead><tr><th></th><th>ML</th><th></th></tr></thead>
          <tbody>
            @for (row of filteredNoSkuML; track row.itemId + (row.variationId || '')) {
              <tr>
                <td class="thumb">@if (row.thumbnail) { <img [src]="row.thumbnail" alt="" /> }</td>
                <td>{{ mlLabel(row) }}</td>
                <td>
                  <button type="button" (click)="editSku.emit({ channel: 'mercadolibre', row })">Asignar SKU</button>
                  <button type="button" class="link" (click)="linkFromMl.emit(row)">Vincular con TN</button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <h3>Sin SKU en Tienda Nube</h3>
      <div class="grid-scroll">
        <table class="table table-with-thumb">
          <thead><tr><th></th><th>TN</th><th></th></tr></thead>
          <tbody>
            @for (row of filteredNoSkuTN; track row.productId + row.variantId) {
              <tr>
                <td class="thumb">@if (row.thumbnail) { <img [src]="row.thumbnail" alt="" /> }</td>
                <td>{{ tnLabel(row) }}</td>
                <td>
                  <button type="button" (click)="editSku.emit({ channel: 'tiendanube', row })">Asignar SKU</button>
                  <button type="button" class="link" (click)="linkFromTn.emit(row)">Vincular con ML</button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </section>
  `
})
export class SinSkuTabComponent {
  @Input({ required: true }) noSkuML: MlRow[] = [];
  @Input({ required: true }) noSkuTN: TnRow[] = [];
  @Input() searchQuery = '';
  @Output() editSku = new EventEmitter<{ channel: 'mercadolibre' | 'tiendanube'; row: MlRow | TnRow }>();
  @Output() linkFromMl = new EventEmitter<MlRow>();
  @Output() linkFromTn = new EventEmitter<TnRow>();

  protected mlLabel = mlLabel;
  protected tnLabel = tnLabel;

  get filteredNoSkuML(): MlRow[] {
    const q = this.searchQuery.trim();
    if (!q) return this.noSkuML;
    return this.noSkuML.filter((r) => {
      const searchable = [r.title, r.sku, r.variationName].filter(Boolean).join(' ');
      return matchSearchByTokens(q, searchable);
    });
  }

  get filteredNoSkuTN(): TnRow[] {
    const q = this.searchQuery.trim();
    if (!q) return this.noSkuTN;
    return this.noSkuTN.filter((r) => {
      const searchable = [r.productName, r.sku, r.variantName].filter(Boolean).join(' ');
      return matchSearchByTokens(q, searchable);
    });
  }
}
