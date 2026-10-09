import { Component, computed, inject, signal } from '@angular/core';
import { CurrencyPipe, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { injectQuery } from '@tanstack/angular-query-experimental';
import {
  OrdersService, ORDERS_LIST_QUERY_KEY, ORDERS_SETTINGS_QUERY_KEY, OrderStatus, SupplierOrder, orderStatusLabel,
} from '../../core/services/orders.service';
import { matchSearchByTokens } from '../../core/services/conflicts.service';
import { SearchBarComponent } from '../../shared/components/search-bar/search-bar.component';
import { FactorySheetDialogComponent } from './factory-sheet-dialog.component';

/**
 * Pedidos al proveedor: la lista (borradores, pendientes y recibidos). Cada fila abre el pedido en
 * el editor (`/pedidos/:id`). Repetir = pedido nuevo idéntico; Duplicar = borrador para editar.
 */
@Component({
  selector: 'app-pedidos-list',
  standalone: true,
  imports: [CurrencyPipe, DatePipe, FormsModule, SearchBarComponent, FactorySheetDialogComponent],
  templateUrl: './pedidos-list.component.html',
  styleUrl: './pedidos-list.component.scss',
})
export class PedidosListComponent {
  private readonly orders = inject(OrdersService);
  private readonly router = inject(Router);

  protected readonly statusLabel = orderStatusLabel;

  readonly statusFilter = signal<'' | OrderStatus>('');
  readonly search = signal('');
  readonly statusOptions: { key: '' | OrderStatus; label: string }[] = [
    { key: '', label: 'Todos' },
    { key: 'borrador', label: 'Borradores' },
    { key: 'pendiente', label: 'Pendientes' },
    { key: 'recibido', label: 'Recibidos' },
  ];

  readonly listQuery = injectQuery(() => ({
    queryKey: ORDERS_LIST_QUERY_KEY,
    queryFn: () => this.orders.list(),
    staleTime: 15_000,
  }));

  readonly loading = computed(() => this.listQuery.isLoading());
  readonly loadError = computed(() => this.listQuery.isError());
  readonly allOrders = computed<SupplierOrder[]>(() => this.listQuery.data()?.orders ?? []);

  readonly counts = computed(() => {
    const c: Record<string, number> = { '': 0, borrador: 0, pendiente: 0, recibido: 0 };
    for (const o of this.allOrders()) { c['']++; c[o.status]++; }
    return c;
  });

  /** Se busca por nombre del pedido y por código/descripción de cualquiera de sus líneas. */
  readonly visibleOrders = computed(() => {
    const status = this.statusFilter();
    const q = this.search();
    return this.allOrders().filter((o) =>
      (!status || o.status === status) &&
      matchSearchByTokens(q, `${o.name} #${o.id} ${o.lines.map((l) => `${l.code} ${l.description} ${l.detail}`).join(' ')}`)
    );
  });

  // ── Descuentos por defecto ──
  readonly settingsQuery = injectQuery(() => ({
    queryKey: ORDERS_SETTINGS_QUERY_KEY,
    queryFn: () => this.orders.getSettings(),
    staleTime: 60_000,
  }));
  readonly editingDefaults = signal(false);
  defaultsDraft = { discount1: 25, discount2: 5 };

  startEditDefaults(): void {
    const s = this.settingsQuery.data();
    this.defaultsDraft = { discount1: s?.discount1 ?? 25, discount2: s?.discount2 ?? 5 };
    this.editingDefaults.set(true);
  }

  async saveDefaults(): Promise<void> {
    await this.run(async () => {
      await this.orders.saveSettings({ discount1: Number(this.defaultsDraft.discount1), discount2: Number(this.defaultsDraft.discount2) });
      this.editingDefaults.set(false);
    });
  }

  // ── Acciones ──
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly repeating = signal<SupplierOrder | null>(null);
  /** Pedido recién repetido como pendiente: se abre la vista para la fábrica para mandarlo. */
  readonly sheetOrder = signal<SupplierOrder | null>(null);

  private async run(fn: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await fn();
    } catch (e: unknown) {
      const err = e as { error?: { error?: string }; message?: string };
      this.error.set(err?.error?.error || err?.message || 'No se pudo completar la acción.');
    } finally {
      this.busy.set(false);
    }
  }

  open(order: SupplierOrder): void {
    this.router.navigate(['/pedidos', order.id]);
  }

  async newOrder(): Promise<void> {
    await this.run(async () => {
      const created = await this.orders.create();
      this.router.navigate(['/pedidos', created.id]);
    });
  }

  async duplicate(order: SupplierOrder, event?: Event): Promise<void> {
    event?.stopPropagation();
    await this.run(async () => {
      const created = await this.orders.duplicate(order.id);
      this.router.navigate(['/pedidos', created.id]);
    });
  }

  askRepeat(order: SupplierOrder, event: Event): void {
    event.stopPropagation();
    this.repeating.set(order);
  }

  async repeatAsDraft(): Promise<void> {
    const src = this.repeating();
    if (!src) return;
    this.repeating.set(null);
    await this.duplicate(src);
  }

  async repeatAndPlace(): Promise<void> {
    const src = this.repeating();
    if (!src) return;
    this.repeating.set(null);
    await this.run(async () => {
      this.sheetOrder.set(await this.orders.duplicate(src.id, { status: 'pendiente' }));
    });
  }
}
