import { Component, inject, input, output, computed, signal } from '@angular/core';
import { DatePipe, CurrencyPipe } from '@angular/common';
import { injectQuery } from '@tanstack/angular-query-experimental';
import { firstValueFrom } from 'rxjs';
import { SyncService, SyncAuditRow, SyncAuditResponse, AuditSource } from '../../../../core/services/sync.service';
import { PricingService, PriceAuditRow, PriceHistoryResponse } from '../../../../core/services/pricing.service';
import { TabsComponent, TabDef } from '../../../../shared/components/tabs/tabs.component';

/** Canal al que corresponde una línea de stock. */
type Channel = 'mercadolibre' | 'tiendanube';

/** Pestaña del diálogo. */
export type HistoryTab = 'stock' | 'price';

/**
 * Un evento de stock. Agrupa las DOS caras del mismo hecho: lo que pasó en el canal donde se vendió
 * y lo que escribió el hub en el otro.
 */
interface TimelineEvent {
  id: string;
  at: string;
  /** Timestamp de la línea más vieja del evento; se usa para agrupar por cercanía. */
  startedAt: number;
  label: string;
  source: AuditSource;
  /** Nro de venta, si el evento viene de una orden. */
  packId: string | null;
  reverted: boolean;
  stockRows: SyncAuditRow[];
  /** Stock conocido de cada canal DESPUÉS de este evento (null = todavía no vimos ese canal). */
  mlAfter: number | null;
  tnAfter: number | null;
  /** Los dos canales quedaron en números distintos. */
  desync: boolean;
}

/**
 * Un evento de precio. Un mismo "aplicar" (lista de Precios, cambio manual) suele escribir ML y TN
 * casi al mismo tiempo: se muestran juntos, una fila por canal.
 */
interface PriceEvent {
  id: string;
  at: string;
  startedAt: number;
  label: string;
  source: PriceAuditRow['source'];
  rows: PriceAuditRow[];
}

/** Ventana para agrupar cambios que no cuelgan de una orden (ej. el "sincronizar stock" manual). */
const GROUP_WINDOW_MS = 60_000;

/**
 * Historial de un producto puntual. El SKU es la unidad que une ML ↔ TN, así que trae los cambios
 * de los dos canales juntos y ordenados: es la respuesta a "¿qué le pasó a ESTE producto?".
 *
 * Dos pestañas, una por fuente: STOCK (sync_audit: ventas, devoluciones, cambios a mano y lo que
 * se movió en el panel de cada canal) y PRECIO (price_audit: Precios, cambios a mano, "Sincronizar
 * precios" y lo que se cambió en el panel de cada canal). Antes iban mezcladas en una sola línea de
 * tiempo, pero las ventas tapaban los cambios de precio, que son pocos y son lo que se busca cuando
 * se pregunta "¿cuándo cambió el precio?".
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
  imports: [DatePipe, CurrencyPipe, TabsComponent],
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

        <zc-tabs class="hist-tabs" [tabs]="tabs()" [activeKey]="activeTab()" (tabChange)="selectTab($event)" />

        <div class="hist-body">
          @if (activeTab() === 'stock') {
            @if (historyQuery.isLoading()) {
              <p class="hist-msg">Cargando historial…</p>
            } @else if (historyQuery.isError()) {
              <p class="hist-msg err">No se pudo cargar el historial de stock.</p>
            } @else if (events().length === 0) {
              <div class="hist-empty">
                <i class="ti ti-package" aria-hidden="true"></i>
                <p>Este producto todavía no tiene cambios de stock registrados.</p>
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
                  </li>
                }
              </ul>
              @if (stockTotal() > stockRows().length) {
                <p class="hist-more">Se muestran los {{ stockRows().length }} cambios más recientes de {{ stockTotal() }}.</p>
              }
            }
          } @else {
            @if (priceHistoryQuery.isLoading()) {
              <p class="hist-msg">Cargando historial…</p>
            } @else if (priceHistoryQuery.isError()) {
              <p class="hist-msg err">No se pudo cargar el historial de precios.</p>
            } @else if (priceEvents().length === 0) {
              <div class="hist-empty">
                <i class="ti ti-tag" aria-hidden="true"></i>
                <p>Este producto todavía no tiene cambios de precio registrados.</p>
                <p class="hint">Se registran desde que la función existe: los cambios anteriores no quedaron guardados.</p>
              </div>
            } @else {
              <ul class="hist-list">
                @for (ev of priceEvents(); track ev.id) {
                  <li class="hist-row">
                    <div class="hist-row-main">
                      <span class="hist-source" [class.manual]="ev.source === 'manual'"
                            [class.externo]="ev.source === 'externo'">{{ ev.label }}</span>
                      <span class="hist-date">{{ ev.at | date: 'dd/MM/yy HH:mm' }}</span>
                    </div>
                    <div class="hist-sides">
                      @for (row of ev.rows; track row.id) {
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
                      }
                    </div>
                  </li>
                }
              </ul>
              @if (priceTotal() > priceRows().length) {
                <p class="hist-more">Se muestran los {{ priceRows().length }} cambios más recientes de {{ priceTotal() }}.</p>
              }
            }
          }
        </div>
      </div>
    </div>
  `,
})
export class ProductHistoryDialogComponent {
  readonly sku = input.required<string>();
  /**
   * Stock ACTUAL de cada canal, si quien abre el diálogo ya lo tiene a mano (viene del catálogo,
   * no del historial). El chip de arriba responde "¿cómo están los canales HOY?", y esa pregunta
   * se contesta mejor con el dato real que arrastrándolo del historial: un movimiento que no quedó
   * registrado (una carrera de webhook, una tarea que sigue en cola) haría que el chip mintiera
   * aunque los canales ya estén iguales. Si no vienen, se cae al valor derivado del historial.
   */
  readonly mlStock = input<number | null>(null);
  readonly tnStock = input<number | null>(null);
  /** Pestaña con la que abre: desde Precios conviene abrir directo en la de precio. */
  readonly initialTab = input<HistoryTab>('stock');
  readonly closed = output<void>();

  /** La que eligió la usuaria; mientras no toque nada manda `initialTab`. */
  private readonly chosenTab = signal<HistoryTab | null>(null);
  protected readonly activeTab = computed<HistoryTab>(() => this.chosenTab() ?? this.initialTab());

  protected selectTab(key: string): void {
    this.chosenTab.set(key === 'price' ? 'price' : 'stock');
  }

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

  protected readonly stockRows = computed<SyncAuditRow[]>(() => this.historyQuery.data()?.rows ?? []);
  protected readonly priceRows = computed<PriceAuditRow[]>(() => this.priceHistoryQuery.data()?.rows ?? []);
  protected readonly stockTotal = computed(() => this.historyQuery.data()?.total ?? 0);
  protected readonly priceTotal = computed(() => this.priceHistoryQuery.data()?.total ?? 0);

  /** El contador de cada pestaña aparece recién cuando cargó: un "0" mientras carga mentiría. */
  protected readonly tabs = computed<TabDef[]>(() => [
    { key: 'stock', label: 'Stock', count: this.historyQuery.data() ? this.stockTotal() : undefined },
    { key: 'price', label: 'Precio', count: this.priceHistoryQuery.data() ? this.priceTotal() : undefined },
  ]);

  /**
   * La línea de tiempo de stock, más reciente primero, con las dos caras de cada movimiento de stock juntas
   * y el estado en que quedaron los dos canales después de cada evento.
   *
   * El estado se calcula recorriendo de lo más VIEJO a lo más nuevo y arrastrando el último stock
   * conocido de cada canal. Por eso se agrupa antes de comparar: si se mirara fila por fila, la
   * primera cara de cada venta (ML descontó, TN todavía no) daría siempre desincronizado.
   */
  protected readonly events = computed<TimelineEvent[]>(() => {
    const groups = this.groupStockRows(this.stockRows());

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
      ev.desync = lastMl !== null && lastTn !== null && lastMl !== lastTn;
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
        at: row.createdAt,
        startedAt: at,
        label: this.stockLabel(row),
        source: row.source,
        packId: orderKey,
        reverted: !!row.revertedAt,
        stockRows: [row],
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
   * Canal que no aparece con una cara propia en el evento: la sincronización tendría que haber
   * escrito ahí. Puede ser porque de verdad no quedó registro (la escritura falló, el SKU no está
   * vinculado) o porque ese canal ya estaba en el número pedido y "no es un cambio" no genera fila
   * (ver mlTaskQueue.js / routes/conflicts.js).
   *
   * Solo aplica a eventos que POR DISEÑO escriben los dos canales — una venta (`packId`) o un
   * "sincronizar stock" manual (`source === 'manual'`) — nunca a un cambio externo suelto
   * (`source === 'externo'`, alguien editó un solo canal desde su panel): ahí no hay espejo que
   * esperar, y mostrar "sin cambio" del otro lado insinuaría un problema que no existe. Antes esto
   * solo cubría el caso de venta; un cambio manual de una sola cara quedaba con un hueco sin
   * explicar (incidente 2026-09-05: la cara de ML se descartaba en silencio por una carrera con el
   * webhook, y el modal no daba ninguna pista).
   */
  protected missingChannel(ev: TimelineEvent): Channel | null {
    if (ev.stockRows.length !== 1) return null;
    if (!ev.packId && ev.source !== 'manual') return null;
    return ev.stockRows[0].updatedChannel === 'mercadolibre' ? 'tiendanube' : 'mercadolibre';
  }

  /**
   * Estado de los dos canales para el resumen de arriba. Preferimos el stock real (input), que es
   * el dato de catálogo del momento; si no vino, caemos al último valor que arrastra el historial
   * (ver el comentario de `mlStock`/`tnStock`).
   */
  protected readonly latestState = computed<{ ml: number; tn: number; desync: boolean } | null>(() => {
    const ml = this.mlStock();
    const tn = this.tnStock();
    if (ml !== null && tn !== null) return { ml, tn, desync: ml !== tn };

    const newest = this.events()[0];
    if (!newest || newest.mlAfter === null || newest.tnAfter === null) return null;
    return { ml: newest.mlAfter, tn: newest.tnAfter, desync: newest.mlAfter !== newest.tnAfter };
  });

  /**
   * La línea de tiempo de precios, más reciente primero. Las filas de ML y TN de un mismo "aplicar"
   * (mismo origen, canales distintos, dentro de la misma ventana) van juntas. Los cambios externos
   * no se agrupan: cada uno es una edición suelta en el panel de un canal.
   */
  protected readonly priceEvents = computed<PriceEvent[]>(() => {
    const chronological = [...this.priceRows()].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    const events: PriceEvent[] = [];
    for (const row of chronological) {
      const at = new Date(row.createdAt).getTime();
      const last = events[events.length - 1];
      const fits =
        last &&
        row.source !== 'externo' &&
        last.source === row.source &&
        !last.rows.some((r) => r.channel === row.channel) &&
        at - last.startedAt <= GROUP_WINDOW_MS;
      if (fits) {
        last.rows.push(row);
        last.at = row.createdAt;
        continue;
      }
      events.push({
        id: `price-${row.id}`,
        at: row.createdAt,
        startedAt: at,
        label: this.priceLabel(row),
        source: row.source,
        rows: [row],
      });
    }
    return events.reverse();
  });

  private priceLabel(row: PriceAuditRow): string {
    switch (row.source) {
      // El editor de publicaciones manda su propio rótulo ("Edición de publicación").
      case 'manual': return row.productLabel || 'Cambio manual';
      case 'sync': return 'Sincronizar precios';
      case 'externo': return row.channel === 'mercadolibre' ? 'Cambio en ML' : 'Cambio en TN';
      default: return 'Precios';
    }
  }

  protected isPriceDown(row: PriceAuditRow): boolean {
    return row.priceBefore !== null && row.priceAfter < row.priceBefore;
  }

  protected isPriceUp(row: PriceAuditRow): boolean {
    return row.priceBefore !== null && row.priceAfter > row.priceBefore;
  }
}
