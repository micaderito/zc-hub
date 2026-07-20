import { Component, inject, input, output, computed } from '@angular/core';
import { DatePipe, CurrencyPipe } from '@angular/common';
import { injectQuery } from '@tanstack/angular-query-experimental';
import { firstValueFrom } from 'rxjs';
import { SyncService, SyncAuditRow, SyncAuditResponse, AuditSource } from '../../../../core/services/sync.service';
import { PricingService, PriceAuditRow, PriceHistoryResponse } from '../../../../core/services/pricing.service';

/** Una entrada de la línea de tiempo: o un cambio de stock o uno de precio. */
type HistoryEntry =
  | { kind: 'stock'; at: string; row: SyncAuditRow }
  | { kind: 'price'; at: string; row: PriceAuditRow };

/**
 * Historial de un producto puntual. El SKU es la unidad que une ML ↔ TN, así que trae los cambios
 * de los dos canales juntos y ordenados: es la respuesta a "¿qué le pasó a ESTE producto?".
 *
 * Fusiona dos fuentes en una sola línea de tiempo: los cambios de STOCK (sync_audit, que produce la
 * sincronización de ventas/devoluciones o un cambio a mano) y los de PRECIO (price_audit, que
 * produce la sección de Precios al aplicar). Se mantienen en tablas separadas porque tienen forma
 * distinta —el stock es entero y cuelga de una venta, el precio es decimal y por canal de
 * publicación— pero para quien mira son la misma pregunta.
 */
@Component({
  selector: 'zc-product-history-dialog',
  standalone: true,
  imports: [DatePipe, CurrencyPipe],
  styleUrl: './product-history-dialog.component.scss',
  template: `
    <div class="hist-backdrop" (click)="closed.emit()">
      <div class="hist-card" (click)="$event.stopPropagation()" role="dialog" aria-modal="true"
           aria-labelledby="hist-title">
        <div class="hist-head">
          <div>
            <h2 id="hist-title">Historial del producto</h2>
            <code class="hist-sku">{{ sku() }}</code>
          </div>
          <button type="button" class="hist-close" (click)="closed.emit()" aria-label="Cerrar">
            <i class="ti ti-x" aria-hidden="true"></i>
          </button>
        </div>

        <div class="hist-body">
          @if (isLoading()) {
            <p class="hist-msg">Cargando historial…</p>
          } @else if (isError()) {
            <p class="hist-msg err">No se pudo cargar el historial.</p>
          } @else if (entries().length === 0) {
            <div class="hist-empty">
              <i class="ti ti-history" aria-hidden="true"></i>
              <p>Este producto todavía no tiene cambios registrados.</p>
              <p class="hint">Se registran desde que la función existe: los cambios anteriores no quedaron guardados.</p>
            </div>
          } @else {
            <ul class="hist-list">
              @for (entry of entries(); track entry.kind + '-' + entry.row.id) {
                <li class="hist-row">
                  @if (entry.kind === 'stock') {
                    <div class="hist-row-main">
                      <span class="hist-kind stock" title="Cambio de stock"><i class="ti ti-package" aria-hidden="true"></i></span>
                      <span class="hist-source" [class.manual]="entry.row.source === 'manual'">{{ sourceLabel(entry.row.source) }}</span>
                      <span class="zc-badge" [class.ml]="entry.row.updatedChannel === 'mercadolibre'"
                            [class.tn]="entry.row.updatedChannel === 'tiendanube'">
                        {{ entry.row.updatedChannel === 'mercadolibre' ? 'ML' : 'TN' }}
                      </span>
                      @if (entry.row.packId) {
                        <span class="hist-order">Venta <code>{{ entry.row.packId }}</code></span>
                      }
                      @if (entry.row.revertedAt) {
                        <span class="hist-reverted">Revertido</span>
                      }
                    </div>
                    <div class="hist-row-right">
                      <span class="hist-stock">
                        {{ entry.row.stockBefore }}
                        <i class="ti ti-arrow-right" aria-hidden="true"></i>
                        <strong [class.down]="entry.row.stockAfter < entry.row.stockBefore"
                                [class.up]="entry.row.stockAfter > entry.row.stockBefore">{{ entry.row.stockAfter }}</strong>
                      </span>
                      <span class="hist-date">{{ entry.at | date: 'dd/MM/yy HH:mm' }}</span>
                    </div>
                  } @else {
                    <div class="hist-row-main">
                      <span class="hist-kind price" title="Cambio de precio"><i class="ti ti-tag" aria-hidden="true"></i></span>
                      <span class="hist-source" [class.manual]="entry.row.source === 'manual'">{{ priceSourceLabel(entry.row.source) }}</span>
                      <span class="zc-badge" [class.ml]="entry.row.channel === 'mercadolibre'"
                            [class.tn]="entry.row.channel === 'tiendanube'">
                        {{ entry.row.channel === 'mercadolibre' ? 'ML' : 'TN' }}
                      </span>
                    </div>
                    <div class="hist-row-right">
                      <span class="hist-stock">
                        @if (entry.row.priceBefore !== null) {
                          {{ entry.row.priceBefore | currency:'ARS':'symbol':'1.0-0' }}
                          <i class="ti ti-arrow-right" aria-hidden="true"></i>
                        }
                        <strong [class.down]="isPriceDown(entry.row)" [class.up]="isPriceUp(entry.row)">
                          {{ entry.row.priceAfter | currency:'ARS':'symbol':'1.0-0' }}
                        </strong>
                      </span>
                      <span class="hist-date">{{ entry.at | date: 'dd/MM/yy HH:mm' }}</span>
                    </div>
                  }
                </li>
              }
            </ul>
            @if (hasMore()) {
              <p class="hist-more">Se muestran los {{ entries().length }} cambios más recientes de {{ total() }}.</p>
            }
          }
        </div>
      </div>
    </div>
  `,
})
export class ProductHistoryDialogComponent {
  readonly sku = input.required<string>();
  readonly closed = output<void>();

  private readonly sync = inject(SyncService);
  private readonly pricing = inject(PricingService);

  readonly historyQuery = injectQuery<SyncAuditResponse>(() => ({
    queryKey: ['sync', 'stock-history', this.sku()],
    queryFn: () => firstValueFrom(this.sync.getStockHistoryBySku(this.sku())),
    staleTime: 30_000,
  }));

  readonly priceHistoryQuery = injectQuery<PriceHistoryResponse>(() => ({
    queryKey: ['pricing', 'price-history', this.sku()],
    queryFn: () => firstValueFrom(this.pricing.getPriceHistoryBySku(this.sku())),
    staleTime: 30_000,
  }));

  protected readonly isLoading = computed(
    () => this.historyQuery.isLoading() || this.priceHistoryQuery.isLoading(),
  );

  /**
   * Solo es error si fallan las DOS fuentes. Si una responde, se muestra lo que hay: es mejor ver
   * el historial de stock aunque el de precios no cargue (o al revés) que una pantalla de error.
   */
  protected readonly isError = computed(
    () => this.historyQuery.isError() && this.priceHistoryQuery.isError(),
  );

  private readonly stockRows = computed<SyncAuditRow[]>(() => this.historyQuery.data()?.rows ?? []);
  private readonly priceRows = computed<PriceAuditRow[]>(() => this.priceHistoryQuery.data()?.rows ?? []);

  /** Las dos fuentes fusionadas y ordenadas por fecha, más reciente primero. */
  protected readonly entries = computed<HistoryEntry[]>(() => {
    const merged: HistoryEntry[] = [
      ...this.stockRows().map((row) => ({ kind: 'stock' as const, at: row.createdAt, row })),
      ...this.priceRows().map((row) => ({ kind: 'price' as const, at: row.createdAt, row })),
    ];
    return merged.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  });

  protected readonly total = computed(
    () => (this.historyQuery.data()?.total ?? 0) + (this.priceHistoryQuery.data()?.total ?? 0),
  );
  protected readonly hasMore = computed(() => this.total() > this.entries().length);

  protected sourceLabel(source: AuditSource): string {
    if (source === 'manual') return 'Manual';
    if (source === 'devolucion') return 'Devolución';
    return 'Venta';
  }

  protected priceSourceLabel(source: PriceAuditRow['source']): string {
    return source === 'manual' ? 'Manual' : 'Precios';
  }

  protected isPriceDown(row: PriceAuditRow): boolean {
    return row.priceBefore !== null && row.priceAfter < row.priceBefore;
  }

  protected isPriceUp(row: PriceAuditRow): boolean {
    return row.priceBefore !== null && row.priceAfter > row.priceBefore;
  }
}
