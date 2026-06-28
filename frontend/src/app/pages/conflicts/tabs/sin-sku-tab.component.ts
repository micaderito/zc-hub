import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MlRow, TnRow, mlLabel, tnLabel, matchSearchByTokens } from '../../../core/services/conflicts.service';
import { ConflictRowComponent } from '../components/conflict-row/conflict-row.component';

@Component({
  selector: 'app-conflicts-sin-sku-tab',
  standalone: true,
  imports: [CommonModule, ConflictRowComponent],
  styleUrls: ['./_conflicts-tabs-styles.scss'],
  template: `
    <p class="tab-hint">Productos sin SKU en ML o TN. Asigná un SKU para poder emparejarlos.</p>

    @if (filteredNoSkuML.length > 0) {
      <p class="tab-hint" style="font-weight:600;color:var(--text);margin-top:0.5rem">
        <span class="zc-badge ml">ML</span> Sin SKU en Mercado Libre ({{ filteredNoSkuML.length }})
      </p>
      @for (row of filteredNoSkuML; track row.itemId + (row.variationId || '')) {
        <zc-conflict-row channel="mercadolibre" [name]="mlLabel(row)" [thumbnail]="row.thumbnail" [sku]="null">
          <button type="button" class="btn-action ghost" (click)="editSku.emit({ channel: 'mercadolibre', row })">Asignar SKU</button>
          <button type="button" class="btn-action link-btn" (click)="linkFromMl.emit(row)"><i class="ti ti-link" aria-hidden="true"></i> Vincular</button>
        </zc-conflict-row>
      }
    }

    @if (filteredNoSkuTN.length > 0) {
      <p class="tab-hint" style="font-weight:600;color:var(--text);margin-top:0.75rem">
        <span class="zc-badge tn">TN</span> Sin SKU en Tienda Nube ({{ filteredNoSkuTN.length }})
      </p>
      @for (row of filteredNoSkuTN; track row.productId + row.variantId) {
        <zc-conflict-row channel="tiendanube" [name]="tnLabel(row)" [thumbnail]="row.thumbnail" [sku]="null">
          <button type="button" class="btn-action ghost" (click)="editSku.emit({ channel: 'tiendanube', row })">Asignar SKU</button>
          <button type="button" class="btn-action link-btn" (click)="linkFromTn.emit(row)"><i class="ti ti-link" aria-hidden="true"></i> Vincular</button>
        </zc-conflict-row>
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
    return this.noSkuML.filter((r) => matchSearchByTokens(q, [r.title, r.sku, r.variationName].filter(Boolean).join(' ')));
  }

  get filteredNoSkuTN(): TnRow[] {
    const q = this.searchQuery.trim();
    if (!q) return this.noSkuTN;
    return this.noSkuTN.filter((r) => matchSearchByTokens(q, [r.productName, r.sku, r.variantName].filter(Boolean).join(' ')));
  }
}
