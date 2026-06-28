import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MlRow, mlLabel, matchSearchByTokens } from '../../../core/services/conflicts.service';
import { ConflictRowComponent } from '../components/conflict-row/conflict-row.component';

@Component({
  selector: 'app-conflicts-solo-ml-tab',
  standalone: true,
  imports: [CommonModule, ConflictRowComponent],
  styleUrls: ['./_conflicts-tabs-styles.scss'],
  template: `
    <p class="tab-hint">{{ filteredRows.length }} publicación{{ filteredRows.length !== 1 ? 'es' : '' }} de ML sin par en TN. Vinculá o asigná un SKU para emparejarlas.</p>

    @for (row of filteredRows; track row.itemId + (row.variationId || '')) {
      <zc-conflict-row channel="mercadolibre" [name]="mlLabel(row)" [thumbnail]="row.thumbnail" [sku]="row.sku">
        <button type="button" class="btn-action ghost" (click)="editSku.emit({ channel: 'mercadolibre', row })">Editar SKU</button>
        <button type="button" class="btn-action link-btn" (click)="linkFromMl.emit(row)"><i class="ti ti-link" aria-hidden="true"></i> Vincular</button>
      </zc-conflict-row>
    }

    @if (filteredRows.length === 0) {
      <p class="tab-hint">Sin resultados para la búsqueda.</p>
    }
  `
})
export class SoloMlTabComponent {
  @Input({ required: true }) rows: MlRow[] = [];
  @Input() searchQuery = '';
  @Output() editSku = new EventEmitter<{ channel: 'mercadolibre'; row: MlRow }>();
  @Output() linkFromMl = new EventEmitter<MlRow>();

  protected mlLabel = mlLabel;

  get filteredRows(): MlRow[] {
    const q = this.searchQuery.trim();
    if (!q) return this.rows;
    return this.rows.filter((r) => {
      const searchable = [r.title, r.sku, r.variationName].filter(Boolean).join(' ');
      return matchSearchByTokens(q, searchable);
    });
  }
}
