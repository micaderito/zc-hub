import { Component, input } from '@angular/core';
import { ProductThumbComponent } from '../../../../shared/components/product-thumb/product-thumb.component';

@Component({
  selector: 'zc-conflict-row',
  standalone: true,
  imports: [ProductThumbComponent],
  template: `
    <div class="row-card" [class.ml-card]="channel() === 'mercadolibre'" [class.tn-card]="channel() === 'tiendanube'">
      <div class="row-body">
        <zc-product-thumb [src]="thumbnail()" />
        <div class="row-info">
          <div class="row-name">{{ name() }}</div>
          <div class="row-meta">
            <span class="zc-badge" [class.ml]="channel() === 'mercadolibre'" [class.tn]="channel() === 'tiendanube'">
              {{ channel() === 'mercadolibre' ? 'ML' : 'TN' }}
            </span>
            @if (sku()) {
              <code class="sku-code">{{ sku() }}</code>
            } @else {
              <code class="sku-code sku-missing">sin SKU</code>
            }
          </div>
        </div>
        <div class="row-actions">
          <ng-content />
        </div>
      </div>
    </div>
  `,
  styleUrl: './conflict-row.component.scss',
})
export class ConflictRowComponent {
  readonly channel = input.required<'mercadolibre' | 'tiendanube'>();
  readonly name = input.required<string>();
  readonly thumbnail = input<string | null | undefined>();
  readonly sku = input<string | null | undefined>();
}
