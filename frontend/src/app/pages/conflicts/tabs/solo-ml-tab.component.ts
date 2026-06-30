import { Component, Input, Output, EventEmitter, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MlRow, mlLabel, matchSearchByTokens } from '../../../core/services/conflicts.service';
import { ConflictRowComponent } from '../components/conflict-row/conflict-row.component';
import { PaginationComponent } from '../../../shared/components/pagination/pagination.component';

const PAGE_SIZE = 20;

@Component({
  selector: 'app-conflicts-solo-ml-tab',
  standalone: true,
  imports: [CommonModule, ConflictRowComponent, PaginationComponent],
  styleUrls: ['./_conflicts-tabs-styles.scss'],
  template: `
    <p class="tab-hint">{{ filtered.length }} publicación{{ filtered.length !== 1 ? 'es' : '' }} de ML sin par en TN. Vinculá o asigná un SKU para emparejarlas.</p>

    @for (row of page; track row.itemId + (row.variationId || '')) {
      <zc-conflict-row channel="mercadolibre" [name]="mlLabel(row)" [thumbnail]="row.thumbnail" [sku]="row.sku">
        <button type="button" class="btn-action ghost" (click)="editSku.emit({ channel: 'mercadolibre', row })">Editar SKU</button>
        <button type="button" class="btn-action link-btn" (click)="linkFromMl.emit(row)"><i class="ti ti-link" aria-hidden="true"></i> Vincular</button>
      </zc-conflict-row>
    }

    @if (filtered.length === 0) {
      <p class="tab-hint">Sin resultados para la búsqueda.</p>
    }

    <zc-pagination
      [currentPage]="currentPage()"
      [totalPages]="totalPages"
      [total]="filtered.length"
      (prev)="currentPage.set(currentPage() - 1)"
      (next)="currentPage.set(currentPage() + 1)"
    />
  `
})
export class SoloMlTabComponent {
  @Input({ required: true }) rows: MlRow[] = [];
  @Input() set searchQuery(q: string) {
    this._searchQuery = q;
    this.currentPage.set(1);
  }
  @Output() editSku = new EventEmitter<{ channel: 'mercadolibre'; row: MlRow }>();
  @Output() linkFromMl = new EventEmitter<MlRow>();

  protected mlLabel = mlLabel;
  protected currentPage = signal(1);
  private _searchQuery = '';

  get filtered(): MlRow[] {
    const q = this._searchQuery.trim();
    if (!q) return this.rows;
    return this.rows.filter((r) => matchSearchByTokens(q, [r.title, r.sku, r.variationName].filter(Boolean).join(' ')));
  }

  get totalPages(): number {
    return Math.max(1, Math.ceil(this.filtered.length / PAGE_SIZE));
  }

  get page(): MlRow[] {
    const start = (this.currentPage() - 1) * PAGE_SIZE;
    return this.filtered.slice(start, start + PAGE_SIZE);
  }
}
