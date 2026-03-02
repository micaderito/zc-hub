import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MlRow, TnRow, mlLabel, tnLabel, matchSearchByTokens } from '../../../core/services/conflicts.service';

@Component({
  selector: 'app-conflicts-duplicados-tab',
  standalone: true,
  imports: [CommonModule],
  styleUrls: ['./_conflicts-tabs-styles.scss'],
  template: `
    <section>
      <p>El mismo SKU está usado por varios ítems. Corregí el SKU en cada uno para que sea único.</p>
      <div class="grid-scroll">
      @for (group of filteredDuplicateSkuML; track group.sku) {
        <div class="dup-group">
          <div class="dup-group-header">
            <strong>SKU «{{ group.sku }}» en ML ({{ group.items.length }} ítems)</strong>
            <button type="button" class="btn-bulk" (click)="editBulkSku.emit({ channel: 'mercadolibre', sku: group.sku, items: group.items })">Editar en lote</button>
          </div>
          <ul>
            @for (row of group.items; track row.itemId + (row.variationId || '')) {
              <li>
                @if (row.thumbnail) { <img [src]="row.thumbnail" alt="" class="dup-thumb" /> }
                {{ mlLabel(row) }} <button type="button" (click)="editSku.emit({ channel: 'mercadolibre', row })">Editar SKU</button>
              </li>
            }
          </ul>
        </div>
      }
      @for (group of filteredDuplicateSkuTN; track group.sku) {
        <div class="dup-group">
          <div class="dup-group-header">
            <strong>SKU «{{ group.sku }}» en TN ({{ group.items.length }} variantes)</strong>
            <button type="button" class="btn-bulk" (click)="editBulkSku.emit({ channel: 'tiendanube', sku: group.sku, items: group.items })">Editar en lote</button>
          </div>
          <ul>
            @for (row of group.items; track row.productId + row.variantId) {
              <li>
                @if (row.thumbnail) { <img [src]="row.thumbnail" alt="" class="dup-thumb" /> }
                {{ tnLabel(row) }} <button type="button" (click)="editSku.emit({ channel: 'tiendanube', row })">Editar SKU</button>
              </li>
            }
          </ul>
        </div>
      }
      </div>
    </section>
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
      .map((g) => ({
        sku: g.sku,
        items: g.items.filter((r) => {
          const searchable = [r.title, r.sku, r.variationName].filter(Boolean).join(' ');
          return matchSearchByTokens(q, searchable);
        })
      }))
      .filter((g) => g.items.length > 0);
  }

  get filteredDuplicateSkuTN(): { sku: string; items: TnRow[] }[] {
    const q = this.searchQuery.trim();
    if (!q) return this.duplicateSkuTN;
    return this.duplicateSkuTN
      .map((g) => ({
        sku: g.sku,
        items: g.items.filter((r) => {
          const searchable = [r.productName, r.sku, r.variantName].filter(Boolean).join(' ');
          return matchSearchByTokens(q, searchable);
        })
      }))
      .filter((g) => g.items.length > 0);
  }
}
