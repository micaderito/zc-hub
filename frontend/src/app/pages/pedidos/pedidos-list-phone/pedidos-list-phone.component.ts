import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { CurrencyPipe, DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { OrderStatus, OrderSupplier, SupplierOrder } from '../../../core/services/orders.service';

/** Sección de la lista del celu. "En camino" va primero: es lo que se mira cuando llega el correo. */
export const ORDER_SECTIONS: { key: OrderStatus; title: string; tile: string; icon: string }[] = [
  { key: 'pendiente', title: 'En camino', tile: 'En camino', icon: 'ti-truck' },
  { key: 'borrador', title: 'Borradores', tile: 'Borradores', icon: 'ti-pencil' },
  { key: 'recibido', title: 'Recibidos', tile: 'Recibidos', icon: 'ti-check' },
];

/** Números de arriba en el orden en que se arma un pedido (borrador → en camino → recibido). */
const TILE_ORDER: OrderStatus[] = ['borrador', 'pendiente', 'recibido'];

/** Recibidos que se muestran antes de "Ver más" (los viejos casi no se miran). */
export const RECEIVED_PREVIEW = 8;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Lista de pedidos en el celular: tres números arriba que filtran por estado y la lista separada en
 * secciones (En camino / Borradores / Recibidos). Recibe los pedidos ya filtrados por proveedor y
 * búsqueda (`PedidosListComponent`); cada tarjeta abre el pedido.
 */
@Component({
  selector: 'zc-pedidos-list-phone',
  standalone: true,
  imports: [CurrencyPipe, DatePipe, RouterLink],
  templateUrl: './pedidos-list-phone.component.html',
  styleUrl: './pedidos-list-phone.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PedidosListPhoneComponent {
  readonly orders = input.required<SupplierOrder[]>();
  readonly suppliers = input<OrderSupplier[]>([]);
  /** Hay pedidos aunque el filtro no deje ver ninguno (para el texto del vacío). */
  readonly hasAny = input(true);

  readonly tiles = TILE_ORDER.map((k) => ORDER_SECTIONS.find((s) => s.key === k)!);
  readonly statusFilter = signal<OrderStatus | null>(null);
  readonly showAllReceived = signal(false);

  readonly counts = computed(() => {
    const c: Record<OrderStatus, number> = { borrador: 0, pendiente: 0, recibido: 0 };
    for (const o of this.orders()) c[o.status]++;
    return c;
  });

  readonly sections = computed(() => {
    const only = this.statusFilter();
    return ORDER_SECTIONS
      .filter((s) => !only || s.key === only)
      .map((s) => {
        const all = this.orders().filter((o) => o.status === s.key);
        const capped = s.key === 'recibido' && !this.showAllReceived() && all.length > RECEIVED_PREVIEW;
        return { ...s, total: all.length, orders: capped ? all.slice(0, RECEIVED_PREVIEW) : all, hidden: capped ? all.length - RECEIVED_PREVIEW : 0 };
      })
      .filter((s) => s.total);
  });

  toggle(status: OrderStatus): void {
    this.statusFilter.update((cur) => (cur === status ? null : status));
  }

  supplierName(key: string | null): string {
    if (!key) return '';
    return this.suppliers().find((s) => s.key === key)?.name ?? key;
  }

  /** "hace N días" desde que se pidió (solo para lo que está en camino). */
  daysAgo(o: SupplierOrder, now = Date.now()): string | null {
    if (!o.orderedAt) return null;
    const days = Math.floor((now - new Date(o.orderedAt).getTime()) / DAY_MS);
    if (days <= 0) return 'hoy';
    return days === 1 ? 'ayer' : `hace ${days} días`;
  }

  /** Cuántas líneas ya tienen algo anotado como recibido (recepción guardada sin cerrar). */
  partlyReceived(o: SupplierOrder): boolean {
    return o.status === 'pendiente' && o.lines.some((l) => l.receivedQty != null);
  }

  tone(o: SupplierOrder): string {
    if (o.status === 'pendiente') return 'busy';
    if (o.status === 'recibido') return o.partial ? 'warn' : 'ok';
    return 'draft';
  }
}
