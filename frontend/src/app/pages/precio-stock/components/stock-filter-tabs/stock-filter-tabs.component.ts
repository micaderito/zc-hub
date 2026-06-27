import { Component, input, output } from '@angular/core';

export type StockFilter = 'all' | 'mismatch' | 'synced' | 'no-stock' | 'with-stock';

export interface StockSummary {
  total: number;
  mismatch: number;
  synced: number;
  noStock: number;
  withStock: number;
}

@Component({
  selector: 'zc-stock-filter-tabs',
  standalone: true,
  styleUrl: './stock-filter-tabs.component.scss',
  template: `
    <div class="tabs" role="tablist" aria-label="Filtrar por estado de stock">
      <button type="button" role="tab" [class.active]="filter() === 'all'"
        (click)="filterChange.emit('all')">
        Todos <span class="tab-count">{{ summary()?.total ?? 0 }}</span>
      </button>
      <button type="button" role="tab" [class.active]="filter() === 'mismatch'"
        (click)="filterChange.emit('mismatch')">
        Stock distinto <span class="tab-count warn">{{ summary()?.mismatch ?? 0 }}</span>
      </button>
      <button type="button" role="tab" [class.active]="filter() === 'synced'"
        (click)="filterChange.emit('synced')">
        Mismo stock <span class="tab-count ok">{{ summary()?.synced ?? 0 }}</span>
      </button>
      <button type="button" role="tab" [class.active]="filter() === 'no-stock'"
        (click)="filterChange.emit('no-stock')">
        Sin stock <span class="tab-count">{{ summary()?.noStock ?? 0 }}</span>
      </button>
      <button type="button" role="tab" [class.active]="filter() === 'with-stock'"
        (click)="filterChange.emit('with-stock')">
        Con stock <span class="tab-count ok">{{ summary()?.withStock ?? 0 }}</span>
      </button>
    </div>
  `,
})
export class StockFilterTabsComponent {
  readonly filter = input.required<StockFilter>();
  readonly summary = input<StockSummary | undefined>();
  readonly filterChange = output<StockFilter>();
}
