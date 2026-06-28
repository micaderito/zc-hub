import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TnRow, tnLabel, matchSearchByTokens } from '../../../core/services/conflicts.service';
import { ConflictRowComponent } from '../components/conflict-row/conflict-row.component';

@Component({
  selector: 'app-conflicts-solo-tn-tab',
  standalone: true,
  imports: [CommonModule, ConflictRowComponent],
  styleUrls: ['./_conflicts-tabs-styles.scss'],
  template: `
    <p class="tab-hint">{{ filteredRows.length }} variante{{ filteredRows.length !== 1 ? 's' : '' }} de TN sin par en ML. Vinculá o asigná un SKU para emparejarlas.</p>

    @for (row of filteredRows; track row.productId + row.variantId) {
      <zc-conflict-row channel="tiendanube" [name]="tnLabel(row)" [thumbnail]="row.thumbnail" [sku]="row.sku">
        <button type="button" class="btn-action ghost" (click)="editSku.emit({ channel: 'tiendanube', row })">Editar SKU</button>
        <button type="button" class="btn-action link-btn" (click)="linkFromTn.emit(row)"><i class="ti ti-link" aria-hidden="true"></i> Vincular</button>
      </zc-conflict-row>
    }

    @if (filteredRows.length === 0) {
      <p class="tab-hint">Sin resultados para la búsqueda.</p>
    }
  `
})
export class SoloTnTabComponent {
  @Input({ required: true }) rows: TnRow[] = [];
  @Input() searchQuery = '';
  @Output() editSku = new EventEmitter<{ channel: 'tiendanube'; row: TnRow }>();
  @Output() linkFromTn = new EventEmitter<TnRow>();

  protected tnLabel = tnLabel;

  get filteredRows(): TnRow[] {
    const q = this.searchQuery.trim();
    if (!q) return this.rows;
    return this.rows.filter((r) => {
      const searchable = [r.productName, r.sku, r.variantName].filter(Boolean).join(' ');
      return matchSearchByTokens(q, searchable);
    });
  }
}
