import { Component, Input, Output, EventEmitter, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MlRow, TnRow, mlLabel, tnLabel, matchSearchByTokens } from '../../../core/services/conflicts.service';
import { ConflictRowComponent } from '../components/conflict-row/conflict-row.component';
import { PaginationComponent } from '../../../shared/components/pagination/pagination.component';

const PAGE_SIZE = 20;

@Component({
  selector: 'app-conflicts-sin-sku-tab',
  standalone: true,
  imports: [CommonModule, ConflictRowComponent, PaginationComponent],
  styleUrls: ['./_conflicts-tabs-styles.scss'],
  template: `
    <p class="tab-hint">Productos sin SKU en ML o TN. Asigná un SKU para poder emparejarlos.</p>

    @if (filteredML.length > 0) {
      <p class="tab-hint" style="font-weight:600;color:var(--text);margin-top:0.5rem">
        <span class="zc-badge ml">ML</span> Sin SKU en Mercado Libre ({{ filteredML.length }})
      </p>
      @for (row of pageML; track row.itemId + (row.variationId || '')) {
        <zc-conflict-row channel="mercadolibre" [name]="mlLabel(row)" [thumbnail]="row.thumbnail" [sku]="null">
          <button type="button" class="btn-action ghost" (click)="editSku.emit({ channel: 'mercadolibre', row })">Asignar SKU</button>
          <button type="button" class="btn-action link-btn" (click)="linkFromMl.emit(row)"><i class="ti ti-link" aria-hidden="true"></i> Vincular</button>
        </zc-conflict-row>
      }
      <zc-pagination
        [currentPage]="pageML_n()"
        [totalPages]="totalPagesML"
        [total]="filteredML.length"
        (prev)="pageML_n.set(pageML_n() - 1)"
        (next)="pageML_n.set(pageML_n() + 1)"
      />
    }

    @if (filteredTN.length > 0) {
      <p class="tab-hint" style="font-weight:600;color:var(--text);margin-top:0.75rem">
        <span class="zc-badge tn">TN</span> Sin SKU en Tienda Nube ({{ filteredTN.length }})
      </p>
      @for (row of pageTN; track row.productId + row.variantId) {
        <zc-conflict-row channel="tiendanube" [name]="tnLabel(row)" [thumbnail]="row.thumbnail" [sku]="null">
          <button type="button" class="btn-action ghost" (click)="editSku.emit({ channel: 'tiendanube', row })">Asignar SKU</button>
          <button type="button" class="btn-action link-btn" (click)="linkFromTn.emit(row)"><i class="ti ti-link" aria-hidden="true"></i> Vincular</button>
        </zc-conflict-row>
      }
      <zc-pagination
        [currentPage]="pageTN_n()"
        [totalPages]="totalPagesTN"
        [total]="filteredTN.length"
        (prev)="pageTN_n.set(pageTN_n() - 1)"
        (next)="pageTN_n.set(pageTN_n() + 1)"
      />
    }

    @if (filteredML.length === 0 && filteredTN.length === 0) {
      <p class="tab-hint">Sin resultados para la búsqueda.</p>
    }
  `
})
export class SinSkuTabComponent {
  @Input({ required: true }) noSkuML: MlRow[] = [];
  @Input({ required: true }) noSkuTN: TnRow[] = [];
  @Input() set searchQuery(q: string) {
    this._searchQuery = q;
    this.pageML_n.set(1);
    this.pageTN_n.set(1);
  }
  @Output() editSku = new EventEmitter<{ channel: 'mercadolibre' | 'tiendanube'; row: MlRow | TnRow }>();
  @Output() linkFromMl = new EventEmitter<MlRow>();
  @Output() linkFromTn = new EventEmitter<TnRow>();

  protected mlLabel = mlLabel;
  protected tnLabel = tnLabel;
  protected pageML_n = signal(1);
  protected pageTN_n = signal(1);
  private _searchQuery = '';

  get filteredML(): MlRow[] {
    const q = this._searchQuery.trim();
    if (!q) return this.noSkuML;
    return this.noSkuML.filter((r) => matchSearchByTokens(q, [r.title, r.sku, r.variationName].filter(Boolean).join(' ')));
  }

  get filteredTN(): TnRow[] {
    const q = this._searchQuery.trim();
    if (!q) return this.noSkuTN;
    return this.noSkuTN.filter((r) => matchSearchByTokens(q, [r.productName, r.sku, r.variantName].filter(Boolean).join(' ')));
  }

  get totalPagesML(): number { return Math.max(1, Math.ceil(this.filteredML.length / PAGE_SIZE)); }
  get totalPagesTN(): number { return Math.max(1, Math.ceil(this.filteredTN.length / PAGE_SIZE)); }

  get pageML(): MlRow[] {
    const start = (this.pageML_n() - 1) * PAGE_SIZE;
    return this.filteredML.slice(start, start + PAGE_SIZE);
  }

  get pageTN(): TnRow[] {
    const start = (this.pageTN_n() - 1) * PAGE_SIZE;
    return this.filteredTN.slice(start, start + PAGE_SIZE);
  }
}
