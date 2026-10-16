import { Component, computed, inject, signal } from '@angular/core';
import { CurrencyPipe, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { injectQuery } from '@tanstack/angular-query-experimental';
import {
  OrdersService, ORDERS_LIST_QUERY_KEY, ORDERS_SUPPLIERS_QUERY_KEY, OrderStatus, OrderSupplier, SupplierOrder, orderStatusLabel,
} from '../../core/services/orders.service';
import { matchSearchByTokens } from '../../core/services/conflicts.service';
import { SearchBarComponent } from '../../shared/components/search-bar/search-bar.component';
import { FactorySheetDialogComponent } from './factory-sheet-dialog.component';
import { CanWriteDirective } from '../../shared/directives/can-write.directive';

/**
 * Pedidos al proveedor: la lista (borradores, pendientes y recibidos). Cada fila abre el pedido en
 * el editor (`/pedidos/:id`). Repetir = pedido nuevo idéntico; Duplicar = borrador para editar.
 */
@Component({
  selector: 'app-pedidos-list',
  standalone: true,
  imports: [CanWriteDirective, CurrencyPipe, DatePipe, FormsModule, SearchBarComponent, FactorySheetDialogComponent],
  templateUrl: './pedidos-list.component.html',
  styleUrl: './pedidos-list.component.scss',
})
export class PedidosListComponent {
  private readonly orders = inject(OrdersService);
  private readonly router = inject(Router);

  protected readonly statusLabel = orderStatusLabel;

  readonly statusFilter = signal<'' | OrderStatus>('');
  /** '' = todos los proveedores. */
  readonly supplierFilter = signal('');
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

  // ── Proveedores ──
  readonly suppliersQuery = injectQuery(() => ({
    queryKey: ORDERS_SUPPLIERS_QUERY_KEY,
    queryFn: () => this.orders.suppliers(),
    staleTime: 5 * 60_000,
  }));
  readonly suppliers = computed<OrderSupplier[]>(() => this.suppliersQuery.data()?.suppliers ?? []);

  supplierName(key: string | null): string {
    if (!key) return '';
    return this.suppliers().find((s) => s.key === key)?.name ?? key;
  }

  /** Pedidos del proveedor elegido (los chips de estado cuentan sobre esto). */
  private readonly supplierOrders = computed(() => {
    const sup = this.supplierFilter();
    return sup ? this.allOrders().filter((o) => o.supplierKey === sup) : this.allOrders();
  });

  readonly counts = computed(() => {
    const c: Record<string, number> = { '': 0, borrador: 0, pendiente: 0, recibido: 0 };
    for (const o of this.supplierOrders()) { c['']++; c[o.status]++; }
    return c;
  });

  /** Se busca por nombre del pedido y por código/descripción de cualquiera de sus líneas. */
  readonly visibleOrders = computed(() => {
    const status = this.statusFilter();
    const q = this.search();
    return this.supplierOrders().filter((o) =>
      (!status || o.status === status) &&
      matchSearchByTokens(q, `${o.name} #${o.id} ${o.lines.map((l) => `${l.code} ${l.description} ${l.detail}`).join(' ')}`)
    );
  });

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

  /** Modal de "Nuevo pedido": a qué proveedor (los descuentos salen de su config default). */
  readonly choosingSupplier = signal(false);
  newSupplierKey = '';

  newOrder(): void {
    const list = this.suppliers();
    // Con un solo proveedor no hay nada que elegir.
    if (list.length === 1) { void this.createFor(list[0].key); return; }
    const filtered = this.supplierFilter();
    this.newSupplierKey = filtered || list.find((s) => s.key === 'punto_cero')?.key || list[0]?.key || '';
    this.choosingSupplier.set(true);
  }

  async createFor(supplierKey: string): Promise<void> {
    this.choosingSupplier.set(false);
    await this.run(async () => {
      const created = await this.orders.create(supplierKey ? { supplierKey } : {});
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
