import { Component, Input, Output, EventEmitter, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MlRow, TnRow, mlLabel, tnLabel, matchSearchByTokens } from '../../../core/services/conflicts.service';
import { ProductThumbComponent } from '../../../shared/components/product-thumb/product-thumb.component';
import { PaginationComponent } from '../../../shared/components/pagination/pagination.component';

const PAGE_SIZE = 20;

@Component({
  selector: 'app-conflicts-duplicados-tab',
  standalone: true,
  imports: [CommonModule, ProductThumbComponent, PaginationComponent],
  styleUrls: ['./_conflicts-tabs-styles.scss'],
  template: `
    <p class="tab-hint">El mismo SKU está usado por varios ítems. Asigná un SKU único a cada uno para que el mapeo funcione.</p>

    @for (group of pageML; track group.sku) {
      <div class="dup-group ml-group">
        <div class="dup-group-header">
          <span class="zc-badge ml">ML</span>
          <code class="sku-code">{{ group.sku }}</code>
          <span class="dup-count">{{ group.items.length }} ítems</span>
          <button type="button" class="btn-action" (click)="editBulkSku.emit({ channel: 'mercadolibre', sku: group.sku, items: group.items })">
            <i class="ti ti-pencil" aria-hidden="true"></i> Editar en lote
          </button>
        </div>
        @for (row of group.items; track row.itemId + (row.variationId || '')) {
          <div class="dup-item">
            <zc-product-thumb [src]="row.thumbnail" style="--thumb-size: 30px" />
            <span class="dup-name">{{ mlLabel(row) }}</span>
            <button type="button" class="btn-action ghost" (click)="editSku.emit({ channel: 'mercadolibre', row })">Editar SKU</button>
          </div>
        }
      </div>
    }

    @for (group of pageTN; track group.sku) {
      <div class="dup-group tn-group">
        <div class="dup-group-header">
          <span class="zc-badge tn">TN</span>
          <code class="sku-code">{{ group.sku }}</code>
          <span class="dup-count">{{ group.items.length }} variantes</span>
          <button type="button" class="btn-action" (click)="editBulkSku.emit({ channel: 'tiendanube', sku: group.sku, items: group.items })">
            <i class="ti ti-pencil" aria-hidden="true"></i> Editar en lote
          </button>
        </div>
        @for (row of group.items; track row.productId + row.variantId) {
          <div class="dup-item">
            <zc-product-thumb [src]="row.thumbnail" style="--thumb-size: 30px" />
            <span class="dup-name">{{ tnLabel(row) }}</span>
            <button type="button" class="btn-action ghost" (click)="editSku.emit({ channel: 'tiendanube', row })">Editar SKU</button>
          </div>
        }
      </div>
    }

    @if (filteredML.length === 0 && filteredTN.length === 0) {
      <p class="tab-hint">Sin resultados para la búsqueda.</p>
    }

    <zc-pagination
      [currentPage]="currentPage()"
      [totalPages]="totalPages"
      [total]="filteredML.length + filteredTN.length"
      (prev)="currentPage.set(currentPage() - 1)"
      (next)="currentPage.set(currentPage() + 1)"
    />
  `
})
export class DuplicadosTabComponent {
  @Input({ required: true }) duplicateSkuML: { sku: string; items: MlRow[] }[] = [];
  @Input({ required: true }) duplicateSkuTN: { sku: string; items: TnRow[] }[] = [];
  @Input() set searchQuery(q: string) {
    this._searchQuery = q;
    this.currentPage.set(1);
  }
  @Output() editSku = new EventEmitter<{ channel: 'mercadolibre' | 'tiendanube'; row: MlRow | TnRow }>();
  @Output() editBulkSku = new EventEmitter<{ channel: 'mercadolibre' | 'tiendanube'; sku: string; items: MlRow[] | TnRow[] }>();

  protected mlLabel = mlLabel;
  protected tnLabel = tnLabel;
  protected currentPage = signal(1);
  private _searchQuery = '';

  get filteredML(): { sku: string; items: MlRow[] }[] {
    const q = this._searchQuery.trim();
    if (!q) return this.duplicateSkuML;
    return this.duplicateSkuML
      .map((g) => ({ sku: g.sku, items: g.items.filter((r) => matchSearchByTokens(q, [r.title, r.sku, r.variationName].filter(Boolean).join(' '))) }))
      .filter((g) => g.items.length > 0);
  }

  get filteredTN(): { sku: string; items: TnRow[] }[] {
    const q = this._searchQuery.trim();
    if (!q) return this.duplicateSkuTN;
    return this.duplicateSkuTN
      .map((g) => ({ sku: g.sku, items: g.items.filter((r) => matchSearchByTokens(q, [r.productName, r.sku, r.variantName].filter(Boolean).join(' '))) }))
      .filter((g) => g.items.length > 0);
  }

  get allGroups(): ({ channel: 'mercadolibre'; sku: string; items: MlRow[] } | { channel: 'tiendanube'; sku: string; items: TnRow[] })[] {
    return [
      ...this.filteredML.map((g) => ({ channel: 'mercadolibre' as const, ...g })),
      ...this.filteredTN.map((g) => ({ channel: 'tiendanube' as const, ...g })),
    ];
  }

  get totalPages(): number { return Math.max(1, Math.ceil(this.allGroups.length / PAGE_SIZE)); }

  get pageML(): { sku: string; items: MlRow[] }[] {
    const start = (this.currentPage() - 1) * PAGE_SIZE;
    const end = start + PAGE_SIZE;
    return this.filteredML.slice(start, Math.min(end, this.filteredML.length));
  }

  get pageTN(): { sku: string; items: TnRow[] }[] {
    const start = Math.max(0, (this.currentPage() - 1) * PAGE_SIZE - this.filteredML.length);
    const end = Math.max(0, this.currentPage() * PAGE_SIZE - this.filteredML.length);
    return this.filteredTN.slice(start, Math.min(end, this.filteredTN.length));
  }
}
