import { Component, input, output, computed } from '@angular/core';
import { TabsComponent, TabDef } from '../../../../shared/components/tabs/tabs.component';

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
  imports: [TabsComponent],
  template: `
    <zc-tabs [tabs]="tabDefs()" [activeKey]="filter()" (tabChange)="onTabChange($event)" />
  `,
})
export class StockFilterTabsComponent {
  readonly filter = input.required<StockFilter>();
  readonly summary = input<StockSummary | undefined>();
  readonly filterChange = output<StockFilter>();

  onTabChange(key: string) {
    this.filterChange.emit(key as StockFilter);
  }

  readonly tabDefs = computed<TabDef[]>(() => {
    const s = this.summary();
    return [
      { key: 'all',        label: 'Todos',          count: s?.total      ?? 0 },
      { key: 'mismatch',   label: 'Stock distinto',  count: s?.mismatch   ?? 0, countVariant: 'warn' as const },
      { key: 'synced',     label: 'Mismo stock',     count: s?.synced     ?? 0, countVariant: 'ok'   as const },
      { key: 'no-stock',   label: 'Sin stock',       count: s?.noStock    ?? 0 },
      { key: 'with-stock', label: 'Con stock',       count: s?.withStock  ?? 0, countVariant: 'ok'   as const },
    ];
  });
}
