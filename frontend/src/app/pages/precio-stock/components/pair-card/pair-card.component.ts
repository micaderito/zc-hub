import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { CurrencyInputDirective } from '../../../../directives/currency-input.directive';
import { MlRow, TnRow, mlLabel, tnLabel } from '../../../../core/services/conflicts.service';
import { SessionService } from '../../../../core/services/session.service';
import { CanWriteDirective } from '../../../../shared/directives/can-write.directive';
import { PhotoLightboxComponent } from '../../../../shared/components/photo-lightbox/photo-lightbox.component';

/**
 * Versión grande de una foto de ML: la miniatura del catálogo suele ser `secure_thumbnail`
 * (`…-I.jpg`, chica); el sufijo `-O` es la original. Inverso de `mlThumbFromUrl` (dispatchService).
 */
export function mlLargePhoto(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.replace(/-[A-Z]\.(jpg|jpeg|png|webp)$/i, '-O.$1');
}

export interface PairPrices {
  priceML: number;
  priceTN: number;
  syncStock: number;
}

@Component({
  selector: 'zc-pair-card',
  standalone: true,
  imports: [CanWriteDirective, FormsModule, RouterLink, CurrencyInputDirective, PhotoLightboxComponent],
  templateUrl: './pair-card.component.html',
  styleUrl: './pair-card.component.scss',
})
export class PairCardComponent {
  readonly session = inject(SessionService);
  readonly pair = input.required<{ ml: MlRow; tn: TnRow; sku?: string }>();
  /** Nombre del pack al que pertenece el SKU del par, si alguno (ver Productos → Packs). */
  readonly packName = input<string | null>(null);
  readonly prices = input.required<PairPrices>();
  readonly displayStockML = input.required<number>();
  readonly displayStockTN = input.required<number>();
  readonly isPending = input(false);
  /**
   * Hay un cambio de stock esperando en la cola de ML: todavía no se aplicó, así que los canales
   * difieren por eso y no por un conflicto. Ver `isStockQueued` en el badge.
   */
  readonly isStockQueued = input(false);
  readonly isCollapsed = input(false);
  readonly syncError = input<string | null>(null);
  /** Ya existe una regla de alerta para este SKU (ver Alertas → Reglas): pinta la campanita. */
  readonly hasAlert = input(false);
  /** Proveedor vigente + config ("Punto Cero · General"); `null` = sin proveedor. */
  readonly supplierLabel = input<string | null>(null);
  /** Muestra el tilde para la selección masiva (asignar proveedor a varios). */
  readonly selectable = input(false);
  readonly selected = input(false);

  readonly toggleCollapse = output<void>();
  readonly updatePrices = output<void>();
  readonly syncStock = output<void>();
  readonly showHistory = output<void>();
  readonly editSupplier = output<void>();
  readonly selectToggle = output<void>();

  protected mlLabel = mlLabel;
  protected tnLabel = tnLabel;

  /** Fotos del zoom: la de ML (en grande) y la de TN. Con las flechas se pasa de un canal al otro. */
  readonly photos = computed(() => {
    const ml = mlLargePhoto(this.pair().ml.thumbnail);
    const tn = this.pair().tn.thumbnail || null;
    return [ml, tn].filter((p): p is string => !!p);
  });
  /** Zoom abierto, con la foto en la que arranca (`null` = cerrado). */
  readonly lightbox = signal<{ start: number } | null>(null);

  openPhoto(channel: 'ml' | 'tn'): void {
    const url = channel === 'ml' ? mlLargePhoto(this.pair().ml.thumbnail) : this.pair().tn.thumbnail;
    if (!url) return;
    this.lightbox.set({ start: Math.max(this.photos().indexOf(url), 0) });
  }

  /** El título ya trae la variante (`mlLabel`); abajo va el SKU. */
  get photoSubtitle(): string | null {
    const sku = this.alertSku;
    return sku ? 'SKU ' + sku : null;
  }

  get isStockSynced(): boolean {
    return this.displayStockML() === this.displayStockTN();
  }

  /** SKU efectivo del par, para el atajo "Configurar alerta" (ver Alertas → Reglas). */
  get alertSku(): string {
    return this.pair().sku || this.pair().ml.sku || this.pair().tn.sku || '';
  }

  /**
   * Estado del badge de stock. Una escritura en cola gana sobre la comparación de valores: mientras
   * el worker no la aplicó, los canales difieren por eso y llamarlo "Stock distinto" sería avisar
   * de un conflicto que no existe. Si la tarea falla sale de la cola, y ahí el conflicto sí es real.
   */
  get stockBadge(): { label: string; icon: string; variant: 'ok' | 'warn' | 'busy' } {
    if (this.isStockQueued()) return { label: 'Actualizándose…', icon: 'ti-clock', variant: 'busy' };
    return this.isStockSynced
      ? { label: 'Mismo stock', icon: 'ti-check', variant: 'ok' }
      : { label: 'Stock distinto', icon: 'ti-alert-triangle', variant: 'warn' };
  }
}
