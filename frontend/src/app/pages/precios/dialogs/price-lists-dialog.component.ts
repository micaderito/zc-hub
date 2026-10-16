import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { QueryClient, injectQuery } from '@tanstack/angular-query-experimental';
import { firstValueFrom } from 'rxjs';
import { ImportedList, PricingService } from '../../../core/services/pricing.service';
import { PreciosStore } from '../precios.store';

/** Historial de listas importadas, con borrado (confirmación en línea). */
@Component({
  selector: 'zc-price-lists-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe],
  templateUrl: './price-lists-dialog.component.html',
  styleUrl: './price-lists-dialog.component.scss',
})
export class PriceListsDialogComponent {
  protected readonly store = inject(PreciosStore);
  private readonly pricing = inject(PricingService);
  private readonly queryClient = inject(QueryClient);

  readonly listsQuery = injectQuery(() => ({
    queryKey: ['pricing', 'lists'],
    queryFn: () => firstValueFrom(this.pricing.getLists()),
    staleTime: 30_000,
  }));

  readonly lists = computed<ImportedList[]>(() => this.listsQuery.data()?.lists ?? []);
  /** Lista con el "¿Borrar?" abierto. */
  readonly confirmDeleteId = signal<number | null>(null);
  readonly deleting = signal(false);
  readonly deleteError = signal<string | null>(null);

  /**
   * Borra una lista importada: sus ítems y los códigos que ya no estén en ninguna lista. Sirve para
   * sacar una importación mal leída antes de volver a importarla. Los costos ya cargados quedan.
   */
  async deleteList(list: ImportedList): Promise<void> {
    this.deleting.set(true);
    this.deleteError.set(null);
    try {
      await firstValueFrom(this.pricing.deleteList(list.id));
      this.confirmDeleteId.set(null);
      await Promise.all([
        this.listsQuery.refetch(),
        this.queryClient.invalidateQueries({ queryKey: ['pricing', 'mapping'] }),
      ]);
    } catch (e) {
      this.deleteError.set(`No se pudo borrar "${list.label}": ${(e as Error)?.message ?? e}`);
    } finally {
      this.deleting.set(false);
    }
  }
}
