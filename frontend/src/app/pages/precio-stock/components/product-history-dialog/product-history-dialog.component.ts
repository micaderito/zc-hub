import { Component, inject, input, output, computed } from '@angular/core';
import { DatePipe, CurrencyPipe } from '@angular/common';
import { injectQuery } from '@tanstack/angular-query-experimental';
import { firstValueFrom } from 'rxjs';
import { SyncService, SyncAuditRow, SyncAuditResponse, AuditSource } from '../../../../core/services/sync.service';
import { PricingService, PriceAuditRow, PriceHistoryResponse } from '../../../../core/services/pricing.service';

/** Canal al que corresponde una línea de stock. */
type Channel = 'mercadolibre' | 'tiendanube';

/**
 * Un evento de la línea de tiempo. Un evento de stock agrupa las DOS caras del mismo hecho: lo que
 * pasó en el canal donde se vendió y lo que escribió el hub en el otro. Los de precio son de a uno.
 */
interface TimelineEvent {
  id: string;
  kind: 'stock' | 'price';
  at: string;
  /** Timestamp de la línea más vieja del evento; se usa para agrupar por cercanía. */
  startedAt: number;
  label: string;
  source: AuditSource | PriceAuditRow['source'];
  /** Nro de venta, si el evento viene de una orden. */
  packId: string | null;
  reverted: boolean;
  stockRows: SyncAuditRow[];
  priceRow: PriceAuditRow | null;
  /** Stock conocido de cada canal DESPUÉS de este evento (null = todavía no vimos ese canal). */
  mlAfter: number | null;
  tnAfter: number | null;
  /** Los dos canales quedaron en números distintos. */
  desync: boolean;
}

/** Ventana para agrupar cambios que no cuelgan de una orden (ej. el "sincronizar stock" manual). */
const GROUP_WINDOW_MS = 60_000;

/**
 * Historial de un producto puntual. El SKU es la unidad que une ML ↔ TN, así que trae los cambios
 * de los dos canales juntos y ordenados: es la respuesta a "¿qué le pasó a ESTE producto?".
 *
 * Fusiona dos fuentes en una sola línea de tiempo: los cambios de STOCK (sync_audit, que produce la
 * sincronización de ventas/devoluciones o un cambio a mano) y los de PRECIO (price_audit, que
 * produce la sección de Precios al aplicar). Se mantienen en tablas separadas porque tienen forma
 * distinta —el stock es entero y cuelga de una venta, el precio es decimal y por canal de
 * publicación— pero para quien mira son la misma pregunta.
 *
 * Cada movimiento de stock tiene DOS caras: la del canal donde se vendió (que descuenta solo) y la
 * del canal espejo (que escribe el hub). Se muestran juntas, con el número en el que quedó cada
 * canal, porque la pregunta que importa no es "¿se descontó?" sino "¿quedaron iguales?". Cuando no
 * quedan iguales el evento se marca como desincronizado: puede faltar la cara del espejo (la
 * escritura falló, el SKU no está vinculado) o los dos números pueden no coincidir.
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
          } @else if (events().length === 0) {
            <div class="hist-empty">
              <i class="ti ti-history" aria-hidden="true"></i>
              <p>Este producto todavía no tiene cambios registrados.</p>
              <p class="hint">Se registran desde que la función existe: los cambios anteriores no quedaron guardados.</p>
            </div>
          } @else {
            @if (latestState(); as st) {
              <div class="hist-summary" [class.desync]="st.desync">
                <i class="ti" [class.ti-circle-check]="!st.desync" [class.ti-alert-triangle]="st.desync"
                   aria-hidden="true"></i>
                <span class="hist-summary-text">{{ st.desync ? 'Desincronizado' : 'Sincronizado' }}</span>
                <span class="hist-pair">
                  <span class="zc-badge ml">ML</span> {{ st.ml }}
                  <span class="zc-badge tn">TN</span> {{ st.tn }}
                </span>
              </div>
            }

            <ul class="hist-list">
              @for (ev of events(); track ev.id) {
                <li class="hist-row" [class.desync]="ev.desync">
                  <div class="hist-row-main">
                    <span class="hist-kind" [class.stock]="ev.kind === 'stock'" [class.price]="ev.kind === 'price'"
                          [title]="ev.kind === 'stock' ? 'Cambio de stock' : 'Cambio de precio'">
                      <i class="ti" [class.ti-package]="ev.kind === 'stock'" [class.ti-tag]="ev.kind === 'price'"
                         aria-hidden="true"></i>
                    </span>
                    <span class="hist-source" [class.manual]="ev.source === 'manual'"
                          [class.externo]="ev.source === 'externo'">{{ ev.label }}</span>
                    @if (ev.packId) {
                      <span class="hist-order">Venta <code>{{ ev.packId }}</code></span>
                    }
                    @if (ev.reverted) {
                      <span class="hist-reverted">Revertido</span>
                    }
                    <span class="hist-date">{{ ev.at | date: 'dd/MM/yy HH:mm' }}</span>
                  </div>

                  @if (ev.kind === 'stock') {
                    <div class="hist-sides">
                      @for (row of ev.stockRows; track row.id) {
                        <span class="hist-side">
                          <span class="zc-badge" [class.ml]="row.updatedChannel === 'mercadolibre'"
                                [class.tn]="row.updatedChannel === 'tiendanube'">
                            {{ row.updatedChannel === 'mercadolibre' ? 'ML' : 'TN' }}
                          </span>
                          <span class="hist-stock">
                            {{ row.stockBefore }}
                            <i class="ti ti-arrow-right" aria-hidden="true"></i>
                            <strong [class.down]="row.stockAfter < row.stockBefore"
                                    [class.up]="row.stockAfter > row.stockBefore">{{ row.stockAfter }}</strong>
                          </span>
                        </span>
                      }
                      @if (missingChannel(ev); as missing) {
                        <span class="hist-side missing" title="No quedó registrado ningún cambio en este canal">
                          <span class="zc-badge" [class.ml]="missing === 'mercadolibre'"
                                [class.tn]="missing === 'tiendanube'">
                            {{ missing === 'mercadolibre' ? 'ML' : 'TN' }}
                          </span>
                          <span class="hist-stock">sin cambio</span>
                        </span>
                      }
                      @if (ev.mlAfter !== null && ev.tnAfter !== null) {
                        <span class="hist-state" [class.desync]="ev.desync">
                          @if (ev.desync) {
                            <i class="ti ti-alert-triangle" aria-hidden="true"></i> ML {{ ev.mlAfter }} · TN {{ ev.tnAfter }}
                          } @else {
                            <i class="ti ti-circle-check" aria-hidden="true"></i> {{ ev.mlAfter }} en ambos
                          }
                        </span>
                      }
                    </div>
                  } @else if (ev.priceRow) {
                    @let row = ev.priceRow;
                    <div class="hist-sides">
                      <span class="hist-side">
                        <span class="zc-badge" [class.ml]="row.channel === 'mercadolibre'"
                              [class.tn]="row.channel === 'tiendanube'">
                          {{ row.channel === 'mercadolibre' ? 'ML' : 'TN' }}
                        </span>
                        <span class="hist-stock">
                          @if (row.priceBefore !== null) {
                            {{ row.priceBefore | currency:'ARS':'symbol':'1.0-0' }}
                            <i class="ti ti-arrow-right" aria-hidden="true"></i>
                          }
                          <strong [class.down]="isPriceDown(row)" [class.up]="isPriceUp(row)">
                            {{ row.priceAfter | currency:'ARS':'symbol':'1.0-0' }}
                          </strong>
                        </span>
                      </span>
                    </div>
                  }
                </li>
              }
            </ul>
            @if (hasMore()) {
              <p class="hist-more">Se muestran los {{ rowCount() }} cambios más recientes de {{ total() }}.</p>
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

  /**
   * La línea de tiempo, más reciente primero, con las dos caras de cada movimiento de stock juntas
   * y el estado en que quedaron los dos canales después de cada evento.
   *
   * El estado se calcula recorriendo de lo más VIEJO a lo más nuevo y arrastrando el último stock
   * conocido de cada canal. Por eso se agrupa antes de comparar: si se mirara fila por fila, la
   * primera cara de cada venta (ML descontó, TN todavía no) daría siempre desincronizado.
   */
  protected readonly events = computed<TimelineEvent[]>(() => {
    const groups = this.groupStockRows(this.stockRows());

    for (const row of this.priceRows()) {
      const at = row.createdAt;
      groups.push({
        id: `price-${row.id}`,
        kind: 'price',
        at,
        startedAt: new Date(at).getTime(),
        label: row.source === 'manual' ? 'Manual' : 'Precios',
        source: row.source,
        packId: null,
        reverted: false,
        stockRows: [],
        priceRow: row,
        mlAfter: null,
        tnAfter: null,
        desync: false,
      });
    }

    groups.sort((a, b) => a.startedAt - b.startedAt);

    let lastMl: number | null = null;
    let lastTn: number | null = null;
    for (const ev of groups) {
      for (const row of ev.stockRows) {
        if (row.updatedChannel === 'mercadolibre') lastMl = row.stockAfter;
        else lastTn = row.stockAfter;
      }
      ev.mlAfter = lastMl;
      ev.tnAfter = lastTn;
      ev.desync = ev.kind === 'stock' && lastMl !== null && lastTn !== null && lastMl !== lastTn;
    }

    return groups.reverse();
  });

  /**
   * Junta las filas que son el mismo hecho visto desde los dos canales. Dos filas van juntas si
   * cubren canales distintos y comparten la venta; las que no cuelgan de una orden (un cambio
   * manual, uno hecho desde el panel del canal) se agrupan por cercanía en el tiempo.
   */
  private groupStockRows(rows: SyncAuditRow[]): TimelineEvent[] {
    const chronological = [...rows].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    const groups: TimelineEvent[] = [];

    for (const row of chronological) {
      const at = new Date(row.createdAt).getTime();
      const orderKey = row.packId || row.orderId || null;
      const last = groups[groups.length - 1];
      const fits =
        last &&
        last.kind === 'stock' &&
        !last.stockRows.some((r) => r.updatedChannel === row.updatedChannel) &&
        (orderKey
          ? orderKey === (last.stockRows[0].packId || last.stockRows[0].orderId || null)
          : !last.packId && last.source === row.source && at - last.startedAt <= GROUP_WINDOW_MS);

      if (fits) {
        last.stockRows.push(row);
        last.at = row.createdAt;
        last.reverted = last.reverted || !!row.revertedAt;
        // El nombre del hecho lo pone la cara que viene de la venta ("Venta ML"), no la del espejo.
        if (row.source !== 'externo') last.label = this.stockLabel(row);
        continue;
      }

      groups.push({
        id: `stock-${row.id}`,
        kind: 'stock',
        at: row.createdAt,
        startedAt: at,
        label: this.stockLabel(row),
        source: row.source,
        packId: orderKey,
        reverted: !!row.revertedAt,
        stockRows: [row],
        priceRow: null,
        mlAfter: null,
        tnAfter: null,
        desync: false,
      });
    }

    return groups;
  }

  /** Nombre del hecho: lo que dice la fila (productLabel) o, si no vino, el origen. */
  private stockLabel(row: SyncAuditRow): string {
    if (row.productLabel) return row.productLabel;
    if (row.source === 'manual') return 'Cambio manual';
    if (row.source === 'externo') return row.updatedChannel === 'mercadolibre' ? 'Cambio en ML' : 'Cambio en TN';
    if (row.source === 'devolucion') return 'Devolución';
    return 'Venta';
  }

  /**
   * Canal que no aparece en un evento que venía de una venta: la sincronización tendría que haber
   * escrito ahí y no quedó registro. Es el caso más común de desincronización, y por eso se muestra
   * como un lado más del evento en vez de dejar un hueco.
   */
  protected missingChannel(ev: TimelineEvent): Channel | null {
    if (ev.kind !== 'stock' || !ev.packId || ev.stockRows.length !== 1) return null;
    return ev.stockRows[0].updatedChannel === 'mercadolibre' ? 'tiendanube' : 'mercadolibre';
  }

  /** Estado de los dos canales según lo último que sabemos, para el resumen de arriba. */
  protected readonly latestState = computed<{ ml: number; tn: number; desync: boolean } | null>(() => {
    const newest = this.events()[0];
    if (!newest || newest.mlAfter === null || newest.tnAfter === null) return null;
    return { ml: newest.mlAfter, tn: newest.tnAfter, desync: newest.mlAfter !== newest.tnAfter };
  });

  protected readonly rowCount = computed(() => this.stockRows().length + this.priceRows().length);

  protected readonly total = computed(
    () => (this.historyQuery.data()?.total ?? 0) + (this.priceHistoryQuery.data()?.total ?? 0),
  );
  protected readonly hasMore = computed(() => this.total() > this.rowCount());

  protected isPriceDown(row: PriceAuditRow): boolean {
    return row.priceBefore !== null && row.priceAfter < row.priceBefore;
  }

  protected isPriceUp(row: PriceAuditRow): boolean {
    return row.priceBefore !== null && row.priceAfter > row.priceBefore;
  }
}
