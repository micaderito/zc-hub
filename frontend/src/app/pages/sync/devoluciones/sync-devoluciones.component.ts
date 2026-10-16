import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { injectMutation } from '@tanstack/angular-query-experimental';
import { PendingReturnRow, SyncService } from '../../../core/services/sync.service';
import { PaginationComponent } from '../../../shared/components/pagination/pagination.component';
import { CanWriteDirective } from '../../../shared/directives/can-write.directive';
import { SyncStore } from '../sync.store';
import { errorMessage, formatDate } from '../sync.utils';

/**
 * Pestaña Devoluciones: lo pendiente de confirmar (restaurar stock o descartar) y agregar una
 * orden a mano. Se monta solo mientras la pestaña está abierta y solo con base de datos.
 */
@Component({
  selector: 'zc-sync-devoluciones',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tab-panel' },
  imports: [CanWriteDirective, FormsModule, PaginationComponent],
  templateUrl: './sync-devoluciones.component.html',
  styleUrl: './sync-devoluciones.component.scss'
})
export class SyncDevolucionesComponent implements OnInit {
  readonly store = inject(SyncStore);
  private readonly sync = inject(SyncService);

  readonly returnOrderId = signal('');
  readonly addingReturn = signal(false);
  readonly fetchResult = signal<string | null>(null);
  readonly approvingId = signal<number | null>(null);
  readonly dismissingId = signal<number | null>(null);

  readonly formatDate = formatDate;

  readonly fetchReturnsMutation = injectMutation(() => ({
    mutationKey: ['sync', 'fetchReturns'],
    mutationFn: () => firstValueFrom(this.sync.fetchReturnsFromMl()),
    onSuccess: () => this.store.invalidateReturns()
  }));

  readonly returnsRows = computed<PendingReturnRow[]>(() => this.store.returnsQuery.data()?.rows ?? []);
  readonly returnsLoading = computed(() => this.store.returnsQuery.isLoading());
  readonly returnsError = computed<string | null>(() => {
    const q = this.store.returnsQuery;
    if (!q.isError() || !q.error()) return null;
    return errorMessage(q.error(), 'Error al cargar devoluciones.');
  });
  readonly fetchingReturns = computed(() => this.fetchReturnsMutation.isPending());

  /**
   * Abrir la pestaña dispara el crawl a ML (una vez por apertura: el componente se monta al
   * entrar). Antes corría en cada montaje de la página sin importar la pestaña y alimentaba la
   * tormenta de 429. El backend ya se protege solo (cache 2 min, respeta el circuit breaker y abre
   * un cooldown tras un fallo), así que si ML está saturado responde sin pegarle. Ver /returns/fetch.
   */
  ngOnInit(): void {
    this.fetchReturnsMutation.mutate(undefined, {
      // El resultado llega por parámetro: en onSettled la señal `data()` de la mutación todavía no se actualizó.
      onSettled: (r) => {
        if (r &&(r.created > 0 || r.skipped > 0))
          this.fetchResult.set(`Se revisaron ${r.claimsChecked} reclamos. Se agregaron ${r.created} ítems${r.skipped > 0 ? ` (${r.skipped} ya estaban)` : ''}.`);
      }
    });
  }

  refreshReturns(): void {
    this.fetchResult.set(null);
    this.store.returnsCurrentPage.set(1);
    this.fetchReturnsMutation.mutate(undefined, {
      onSuccess: (r) => {
        this.fetchResult.set(r.mlBusy
          ? 'Mercado Libre está saturado en este momento. Probá de nuevo en un minuto.'
          : r.created > 0 || r.skipped > 0
            ? `Se revisaron ${r.claimsChecked} reclamos. Se agregaron ${r.created} ítems${r.skipped > 0 ? ` (${r.skipped} ya estaban)` : ''}.`
            : r.claimsChecked === 0
              ? 'No hay reclamos recientes con devolución en ML.'
              : 'Lista actualizada.');
      },
      onError: (e) => this.fetchResult.set(errorMessage(e, 'Error al actualizar.'))
    });
  }

  addReturnsByOrder(): void {
    const orderId = this.returnOrderId().trim();
    if (!orderId) return;
    this.addingReturn.set(true);
    this.fetchResult.set(null);
    this.sync.addReturnsFromOrder(orderId).subscribe({
      next: (r) => {
        this.returnOrderId.set('');
        this.addingReturn.set(false);
        this.store.returnsCurrentPage.set(1);
        this.store.invalidateReturns();
        this.fetchResult.set(r.created > 0 ? `Se agregaron ${r.created} ítems de la orden.` : null);
      },
      error: (e) => {
        this.fetchResult.set(errorMessage(e, 'Error al agregar devoluciones.'));
        this.addingReturn.set(false);
      }
    });
  }

  approveReturn(row: PendingReturnRow): void {
    this.approvingId.set(row.id);
    this.sync.approveReturn(row.id).subscribe({
      next: () => {
        this.approvingId.set(null);
        this.store.invalidateReturns();
        this.store.loadAudit();
      },
      error: (e) => {
        this.fetchResult.set(errorMessage(e, 'Error al restaurar stock.'));
        this.approvingId.set(null);
      }
    });
  }

  /** Descartar: la unidad no volvió ni va a volver (ej. cancelaste la venta por falta de stock). */
  dismissReturn(row: PendingReturnRow): void {
    this.dismissingId.set(row.id);
    this.sync.dismissReturn(row.id).subscribe({
      next: () => {
        this.dismissingId.set(null);
        this.store.invalidateReturns();
      },
      error: (e) => {
        this.fetchResult.set(errorMessage(e, 'Error al descartar la devolución.'));
        this.dismissingId.set(null);
      }
    });
  }
}
