import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TnRow, tnLabel } from '../../../core/services/conflicts.service';
import { ConflictRowComponent } from '../components/conflict-row/conflict-row.component';
import { PaginationComponent } from '../../../shared/components/pagination/pagination.component';

@Component({
  selector: 'app-conflicts-solo-tn-tab',
  standalone: true,
  imports: [CommonModule, ConflictRowComponent, PaginationComponent],
  styleUrls: ['./_conflicts-tabs-styles.scss'],
  template: `
    <p class="tab-hint">{{ paging.total }} variante{{ paging.total !== 1 ? 's' : '' }} de TN sin par en ML. Vinculá o asigná un SKU para emparejarlas.</p>

    @for (row of rows; track row.productId + row.variantId) {
      <zc-conflict-row channel="tiendanube" [name]="tnLabel(row)" [thumbnail]="row.thumbnail" [sku]="row.sku">
        <button type="button" class="btn-action ghost" (click)="editSku.emit({ channel: 'tiendanube', row })">Editar SKU</button>
        <button type="button" class="btn-action link-btn" (click)="linkFromTn.emit(row)"><i class="ti ti-link" aria-hidden="true"></i> Vincular</button>
      </zc-conflict-row>
    }

    @if (rows.length === 0) {
      <p class="tab-hint">Sin resultados para la búsqueda.</p>
    }

    <zc-pagination
      [currentPage]="paging.page"
      [totalPages]="paging.pages"
      [total]="paging.total"
      (prev)="pageChange.emit(paging.page - 1)"
      (next)="pageChange.emit(paging.page + 1)"
    />
  `
})
export class SoloTnTabComponent {
  @Input({ required: true }) rows: TnRow[] = [];
  @Input() paging: { page: number; limit: number; total: number; pages: number } = { page: 1, limit: 25, total: 0, pages: 1 };
  @Output() editSku = new EventEmitter<{ channel: 'tiendanube'; row: TnRow }>();
  @Output() linkFromTn = new EventEmitter<TnRow>();
  @Output() pageChange = new EventEmitter<number>();

  protected tnLabel = tnLabel;
}
