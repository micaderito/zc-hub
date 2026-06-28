import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MlRow, TnRow, mlLabel, tnLabel, matchSearchByTokens } from '../../../core/services/conflicts.service';

@Component({
  selector: 'app-conflicts-sin-sku-tab',
  standalone: true,
  imports: [CommonModule],
  styleUrls: ['./_conflicts-tabs-styles.scss'],
  template: `
    <p class="tab-hint">Productos sin SKU en ML o TN. Asigná un SKU para poder emparejarlos.</p>

    @if (filteredNoSkuML.length > 0) {
      <p class="tab-hint" style="font-weight:600;color:var(--text);margin-top:0.5rem">
        <span class="channel-badge ml">ML</span> Sin SKU en Mercado Libre ({{ filteredNoSkuML.length }})
      </p>
      @for (row of filteredNoSkuML; track row.itemId + (row.variationId || '')) {
        <div class="row-card ml-card">
          <div class="row-body">
            @if (row.thumbnail) { <img [src]="row.thumbnail" alt="" /> }
            @else { <span class="no-thumb"><i class="ti ti-photo-off" aria-hidden="true"></i></span> }
            <div class="row-info">
              <div class="row-name">{{ mlLabel(row) }}</div>
              <div class="row-meta">
                <span class="channel-badge ml">ML</span>
                <span class="sku-code" style="color:var(--warn)">sin SKU</span>
              </div>
            </div>
            <div class="row-actions">
              <button type="button" class="btn-action ghost" (click)="editSku.emit({ channel: 'mercadolibre', row })">Asignar SKU</button>
              <button type="button" class="btn-action link-btn" (click)="linkFromMl.emit(row)"><i class="ti ti-link" aria-hidden="true"></i> Vincular</button>
            </div>
          </div>
        </div>
      }
    }

    @if (filteredNoSkuTN.length > 0) {
      <p class="tab-hint" style="font-weight:600;color:var(--text);margin-top:0.75rem">
        <span class="channel-badge tn">TN</span> Sin SKU en Tienda Nube ({{ filteredNoSkuTN.length }})
      </p>
      @for (row of filteredNoSkuTN; track row.productId + row.variantId) {
        <div class="row-card tn-card">
          <div class="row-body">
            @if (row.thumbnail) { <img [src]="row.thumbnail" alt="" /> }
            @else { <span class="no-thumb"><i class="ti ti-photo-off" aria-hidden="true"></i></span> }
            <div class="row-info">
              <div class="row-name">{{ tnLabel(row) }}</div>
              <div class="row-meta">
                <span class="channel-badge tn">TN</span>
                <span class="sku-code" style="color:var(--warn)">sin SKU</span>
              </div>
            </div>
            <div class="row-actions">
              <button type="button" class="btn-action ghost" (click)="editSku.emit({ channel: 'tiendanube', row })">Asignar SKU</button>
              <button type="button" class="btn-action link-btn" (click)="linkFromTn.emit(row)"><i class="ti ti-link" aria-hidden="true"></i> Vincular</button>
            </div>
          </div>
        </div>
      }
    }

    @if (filteredNoSkuML.length === 0 && filteredNoSkuTN.length === 0) {
      <p class="tab-hint">Sin resultados para la búsqueda.</p>
    }
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
