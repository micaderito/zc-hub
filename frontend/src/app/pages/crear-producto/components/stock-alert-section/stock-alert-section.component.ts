import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { injectQuery } from '@tanstack/angular-query-experimental';
import { PACKS_QUERY_KEY, PacksService } from '../../../../core/services/packs.service';
import { DraftStockAlert } from '../../product-draft.model';
import { ProductDraftStore } from '../../product-draft.store';

/**
 * Alerta de stock bajo para el producto que se está creando: umbral + cómo se le compra al
 * proveedor (suelto / pack existente / pack nuevo). Se da de alta sola cuando la publicación
 * termina con algo creado (ver publishAlert.js); después se edita desde Alertas → Reglas.
 */
@Component({
  selector: 'zc-stock-alert-section',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './stock-alert-section.component.html',
  styleUrls: ['../section-shared.scss', './stock-alert-section.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class StockAlertSectionComponent {
  protected readonly store = inject(ProductDraftStore);
  private readonly packsSvc = inject(PacksService);

  protected readonly alert = computed(() => this.store.draft().alert);

  /** La lista de packs solo hace falta para elegir uno existente. */
  protected readonly packsQuery = injectQuery(() => ({
    queryKey: PACKS_QUERY_KEY,
    queryFn: () => this.packsSvc.getPacksPromise(),
    enabled: this.alert().enabled && this.alert().packMode === 'existing'
  }));
  protected readonly packs = computed(() => this.packsQuery.data()?.packs ?? []);
  protected readonly selectedPack = computed(() => this.packs().find((p) => p.id === this.alert().packId) ?? null);

  setPackMode(mode: DraftStockAlert['packMode']): void {
    this.alert().packMode = mode;
    this.store.touch();
  }

  toggle(enabled: boolean): void {
    this.alert().enabled = enabled;
    this.store.touch();
  }
}
