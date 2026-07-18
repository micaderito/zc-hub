import { Component, inject, input, output, computed } from '@angular/core';
import { DatePipe } from '@angular/common';
import { injectQuery } from '@tanstack/angular-query-experimental';
import { firstValueFrom } from 'rxjs';
import { SyncService, SyncAuditRow, SyncAuditResponse, AuditSource } from '../../../../core/services/sync.service';

/**
 * Historial de stock de un producto puntual. El SKU es la unidad que une ML ↔ TN, así que trae los
 * cambios de los dos canales juntos y ordenados: es la respuesta a "¿qué le pasó a ESTE producto?".
 */
@Component({
  selector: 'zc-stock-history-dialog',
  standalone: true,
  imports: [DatePipe],
  styleUrl: './stock-history-dialog.component.scss',
  template: `
    <div class="hist-backdrop" (click)="closed.emit()">
      <div class="hist-card" (click)="$event.stopPropagation()" role="dialog" aria-modal="true"
           aria-labelledby="hist-title">
        <div class="hist-head">
          <div>
            <h2 id="hist-title">Historial de stock</h2>
            <code class="hist-sku">{{ sku() }}</code>
          </div>
          <button type="button" class="hist-close" (click)="closed.emit()" aria-label="Cerrar">
            <i class="ti ti-x" aria-hidden="true"></i>
          </button>
        </div>

        <div class="hist-body">
          @if (historyQuery.isLoading()) {
            <p class="hist-msg">Cargando historial…</p>
          } @else if (historyQuery.isError()) {
            <p class="hist-msg err">No se pudo cargar el historial.</p>
          } @else if (rows().length === 0) {
            <div class="hist-empty">
              <i class="ti ti-history" aria-hidden="true"></i>
              <p>Este producto todavía no tiene cambios registrados.</p>
              <p class="hint">Se registran desde que la función existe: los cambios anteriores no quedaron guardados.</p>
            </div>
          } @else {
            <ul class="hist-list">
              @for (row of rows(); track row.id) {
                <li class="hist-row">
                  <div class="hist-row-main">
                    <span class="hist-source" [class.manual]="row.source === 'manual'">{{ sourceLabel(row.source) }}</span>
                    <span class="zc-badge" [class.ml]="row.updatedChannel === 'mercadolibre'"
                          [class.tn]="row.updatedChannel === 'tiendanube'">
                      {{ row.updatedChannel === 'mercadolibre' ? 'ML' : 'TN' }}
                    </span>
                    @if (row.packId) {
                      <span class="hist-order">Venta <code>{{ row.packId }}</code></span>
                    }
                    @if (row.revertedAt) {
                      <span class="hist-reverted">Revertido</span>
                    }
                  </div>
                  <div class="hist-row-right">
                    <span class="hist-stock">
                      {{ row.stockBefore }}
                      <i class="ti ti-arrow-right" aria-hidden="true"></i>
                      <strong [class.down]="row.stockAfter < row.stockBefore"
                              [class.up]="row.stockAfter > row.stockBefore">{{ row.stockAfter }}</strong>
                    </span>
                    <span class="hist-date">{{ row.createdAt | date: 'dd/MM/yy HH:mm' }}</span>
                  </div>
                </li>
              }
            </ul>
            @if (hasMore()) {
              <p class="hist-more">Se muestran los {{ rows().length }} cambios más recientes de {{ total() }}.</p>
            }
          }
        </div>
      </div>
    </div>
  `,
})
export class StockHistoryDialogComponent {
  readonly sku = input.required<string>();
  readonly closed = output<void>();

  private readonly sync = inject(SyncService);

  readonly historyQuery = injectQuery<SyncAuditResponse>(() => ({
    queryKey: ['sync', 'stock-history', this.sku()],
    queryFn: () => firstValueFrom(this.sync.getStockHistoryBySku(this.sku())),
    staleTime: 30_000,
  }));

  protected readonly rows = computed<SyncAuditRow[]>(() => this.historyQuery.data()?.rows ?? []);
  protected readonly total = computed(() => this.historyQuery.data()?.total ?? 0);
  protected readonly hasMore = computed(() => this.total() > this.rows().length);

  protected sourceLabel(source: AuditSource): string {
    if (source === 'manual') return 'Manual';
    if (source === 'devolucion') return 'Devolución';
    return 'Venta';
  }
}
