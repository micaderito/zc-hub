import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MlRow, TnRow, mlLabel, tnLabel, matchSearchByTokens } from '../../../core/services/conflicts.service';

@Component({
  selector: 'app-conflicts-duplicados-tab',
  standalone: true,
  imports: [CommonModule],
  styleUrls: ['./_conflicts-tabs-styles.scss'],
  template: `
    <p class="tab-hint">El mismo SKU está usado por varios ítems. Asigná un SKU único a cada uno para que el mapeo funcione.</p>

    @for (group of filteredDuplicateSkuML; track group.sku) {
      <div class="dup-group ml-group">
        <div class="dup-group-header">
          <span class="channel-badge ml">ML</span>
          <span class="dup-sku">{{ group.sku }}</span>
          <span class="dup-count">{{ group.items.length }} ítems</span>
          <button type="button" class="btn-action" (click)="editBulkSku.emit({ channel: 'mercadolibre', sku: group.sku, items: group.items })">
            <i class="ti ti-pencil" aria-hidden="true"></i> Editar en lote
          </button>
        </div>
        @for (row of group.items; track row.itemId + (row.variationId || '')) {
          <div class="dup-item">
            @if (row.thumbnail) { <img [src]="row.thumbnail" alt="" /> }
            @else { <span class="no-thumb"></span> }
            <span class="dup-name">{{ mlLabel(row) }}</span>
            <button type="button" class="btn-action ghost" (click)="editSku.emit({ channel: 'mercadolibre', row })">Editar SKU</button>
          </div>
        }
      </div>
    }

    @for (group of filteredDuplicateSkuTN; track group.sku) {
      <div class="dup-group tn-group">
        <div class="dup-group-header">
          <span class="channel-badge tn">TN</span>
          <span class="dup-sku">{{ group.sku }}</span>
          <span class="dup-count">{{ group.items.length }} variantes</span>
          <button type="button" class="btn-action" (click)="editBulkSku.emit({ channel: 'tiendanube', sku: group.sku, items: group.items })">
            <i class="ti ti-pencil" aria-hidden="true"></i> Editar en lote
          </button>
        </div>
        @for (row of group.items; track row.productId + row.variantId) {
          <div class="dup-item">
            @if (row.thumbnail) { <img [src]="row.thumbnail" alt="" /> }
            @else { <span class="no-thumb"></span> }
            <span class="dup-name">{{ tnLabel(row) }}</span>
            <button type="button" class="btn-action ghost" (click)="editSku.emit({ channel: 'tiendanube', row })">Editar SKU</button>
          </div>
        }
      </div>
    }

    @if (filteredDuplicateSkuML.length === 0 && filteredDuplicateSkuTN.length === 0) {
      <p class="tab-hint">Sin resultados para la búsqueda.</p>
    }
  `
})
export class DuplicadosTabComponent {
  @Input({ required: true }) duplicateSkuML: { sku: string; items: MlRow[] }[] = [];
  @Input({ required: true }) duplicateSkuTN: { sku: string; items: TnRow[] }[] = [];
  @Input() searchQuery = '';
  @Output() editSku = new EventEmitter<{ channel: 'mercadolibre' | 'tiendanube'; row: MlRow | TnRow }>();
  @Output() editBulkSku = new EventEmitter<{ channel: 'mercadolibre' | 'tiendanube'; sku: string; items: MlRow[] | TnRow[] }>();

  protected mlLabel = mlLabel;
  protected tnLabel = tnLabel;

  get filteredDuplicateSkuML(): { sku: string; items: MlRow[] }[] {
    const q = this.searchQuery.trim();
    if (!q) return this.duplicateSkuML;
    return this.duplicateSkuML
      .map((g) => ({ sku: g.sku, items: g.items.filter((r) => matchSearchByTokens(q, [r.title, r.sku, r.variationName].filter(Boolean).join(' '))) }))
      .filter((g) => g.items.length > 0);
  }

  get filteredDuplicateSkuTN(): { sku: string; items: TnRow[] }[] {
    const q = this.searchQuery.trim();
    if (!q) return this.duplicateSkuTN;
    return this.duplicateSkuTN
      .map((g) => ({ sku: g.sku, items: g.items.filter((r) => matchSearchByTokens(q, [r.productName, r.sku, r.variantName].filter(Boolean).join(' '))) }))
      .filter((g) => g.items.length > 0);
  }
}
