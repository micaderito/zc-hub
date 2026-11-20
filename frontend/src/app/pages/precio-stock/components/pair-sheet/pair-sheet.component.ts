import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MlRow, TnRow } from '../../../../core/services/conflicts.service';
import { SessionService } from '../../../../core/services/session.service';
import { CurrencyInputDirective } from '../../../../directives/currency-input.directive';
import { BottomSheetComponent } from '../../../../shared/components/bottom-sheet/bottom-sheet.component';
import { ProductThumbComponent } from '../../../../shared/components/product-thumb/product-thumb.component';
import { CanWriteDirective } from '../../../../shared/directives/can-write.directive';
import { PairPrices } from '../pair-card/pair-card.component';
import { pairTitle, pairVariant } from '../pair-row/pair-row.component';

/**
 * Hoja de un producto en el celular (opción A de docs/prototype/productos-mobile.html): stock de cada
 * canal, +/− grande para dejar los dos en el mismo número, los dos precios y los atajos a Historial,
 * Alerta y Proveedor. Escribe en el mismo `PairPrices` que la tarjeta de escritorio y emite la acción:
 * la página cierra la hoja y corre `syncStock` / `updatePrices` (así sus confirmaciones no quedan
 * debajo de la hoja).
 */
@Component({
  selector: 'zc-pair-sheet',
  standalone: true,
  imports: [FormsModule, RouterLink, CurrencyInputDirective, BottomSheetComponent, ProductThumbComponent, CanWriteDirective],
  styleUrl: './pair-sheet.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <zc-bottom-sheet [title]="title()" [subtitle]="subtitle()" (closed)="closed.emit()">
      <zc-product-thumb sheet-lead class="ps-thumb" [src]="pair().ml.thumbnail || pair().tn.thumbnail"
                        [photos]="[pair().ml.thumbnail, pair().tn.thumbnail]" [title]="title()" [subtitle]="subtitle()" />

      <div class="ps-stats">
        <div class="ps-stat"><small><span class="stock-dot ml"></span>Mercado Libre</small><b>{{ stockML() }}</b> <span>u.</span></div>
        <div class="ps-stat"><small><span class="stock-dot tn"></span>Tienda Nube</small><b [class.warn]="stockML() !== stockTN()">{{ stockTN() }}</b> <span>u.</span></div>
      </div>
      @if (stockQueued()) {
        <p class="ps-note"><i class="ti ti-clock" aria-hidden="true"></i> Hay un cambio de stock en la cola de ML: todavía no se aplicó.</p>
      }

      <ng-container *zcCanWrite>
        <div class="ps-lbl">Dejar los dos en</div>
        <div class="ps-step">
          <button type="button" (click)="bump(-1)" [disabled]="target() <= 0" aria-label="Uno menos"><i class="ti ti-minus" aria-hidden="true"></i></button>
          <input type="number" min="0" step="1" inputmode="numeric" [ngModel]="target()" (ngModelChange)="setTarget($event)" aria-label="Nuevo stock para los dos canales" />
          <button type="button" (click)="bump(1)" aria-label="Uno más"><i class="ti ti-plus" aria-hidden="true"></i></button>
        </div>
        <button type="button" class="ps-btn primary" (click)="doSync()" [disabled]="pending()">
          <i class="ti ti-refresh" aria-hidden="true"></i> {{ pending() ? 'Actualizando…' : 'Sincronizar stock' }}
        </button>
      </ng-container>

      <div class="ps-lbl">Precio</div>
      <div class="ps-fields">
        <label class="ps-field"><span><span class="stock-dot ml"></span>ML</span>
          <input type="text" inputmode="decimal" appCurrencyInput [(ngModel)]="prices().priceML" [readonly]="session.isReadOnly()" placeholder="0,00" aria-label="Precio Mercado Libre" />
        </label>
        <label class="ps-field"><span><span class="stock-dot tn"></span>TN</span>
          <input type="text" inputmode="decimal" appCurrencyInput [(ngModel)]="prices().priceTN" [readonly]="session.isReadOnly()" placeholder="0,00" aria-label="Precio Tienda Nube" />
        </label>
      </div>
      <button type="button" class="ps-btn" *zcCanWrite (click)="updatePrices.emit()" [disabled]="pending()">
        <i class="ti ti-currency-dollar" aria-hidden="true"></i> Actualizar precios
      </button>

      <div class="ps-links">
        <button type="button" (click)="showHistory.emit()"><i class="ti ti-history" aria-hidden="true"></i> Historial de stock y precio<i class="ti ti-chevron-right ps-chev" aria-hidden="true"></i></button>
        @if (sku()) {
          <a routerLink="/alertas" [queryParams]="{ tab: 'reglas', sku: sku() }" (click)="closed.emit()">
            <i class="ti ti-bell" [class.on]="hasAlert()" aria-hidden="true"></i> {{ hasAlert() ? 'Alerta de stock configurada' : 'Configurar alerta de stock' }}<i class="ti ti-chevron-right ps-chev" aria-hidden="true"></i>
          </a>
        }
        <button type="button" (click)="editSupplier.emit()" [disabled]="session.isReadOnly()">
          <i class="ti ti-building-store" aria-hidden="true"></i> Proveedor · {{ supplierLabel() || 'sin proveedor' }}<i class="ti ti-chevron-right ps-chev" aria-hidden="true"></i>
        </button>
      </div>
    </zc-bottom-sheet>
  `,
})
export class PairSheetComponent implements OnInit {
  readonly session = inject(SessionService);

  readonly pair = input.required<{ ml: MlRow; tn: TnRow; sku?: string }>();
  readonly prices = input.required<PairPrices>();
  readonly stockML = input.required<number>();
  readonly stockTN = input.required<number>();
  readonly pending = input(false);
  readonly stockQueued = input(false);
  readonly packName = input<string | null>(null);
  readonly supplierLabel = input<string | null>(null);
  readonly hasAlert = input(false);

  readonly closed = output<void>();
  readonly syncStock = output<void>();
  readonly updatePrices = output<void>();
  readonly showHistory = output<void>();
  readonly editSupplier = output<void>();

  readonly title = computed(() => pairTitle(this.pair()));
  readonly sku = computed(() => this.pair().sku || this.pair().ml.sku || this.pair().tn.sku || '');
  readonly subtitle = computed(() =>
    [pairVariant(this.pair()), this.sku() ? 'SKU ' + this.sku() : null, this.packName() ? 'pack ' + this.packName() : null]
      .filter(Boolean)
      .join(' · '),
  );

  /** Número al que se dejan los dos canales; arranca en el del ML (si difieren, el de TN suele ser el viejo). */
  readonly target = signal(0);

  ngOnInit(): void {
    this.target.set(Math.max(0, this.stockML()));
  }

  bump(delta: number): void {
    this.target.update((v) => Math.max(0, v + delta));
  }

  setTarget(v: number | string | null): void {
    const n = Math.floor(Number(v));
    this.target.set(Number.isFinite(n) && n > 0 ? n : 0);
  }

  doSync(): void {
    this.prices().syncStock = this.target();
    this.syncStock.emit();
  }
}
