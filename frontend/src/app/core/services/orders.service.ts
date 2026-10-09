import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { lastValueFrom } from 'rxjs';
import { QueryClient } from '@tanstack/angular-query-experimental';
import { ApiService } from './api.service';

/** Query keys de Pedidos; invalidar tras cualquier cambio de estado. */
export const ORDERS_LIST_QUERY_KEY = ['orders', 'list'] as const;
export const ORDERS_CATALOG_QUERY_KEY = ['orders', 'catalog'] as const;
export const ORDERS_SETTINGS_QUERY_KEY = ['orders', 'settings'] as const;

export type OrderStatus = 'borrador' | 'pendiente' | 'recibido';
export type OrderLineKind = 'pack' | 'sku' | 'free';
export type OrderLineOrigin = 'alerta' | 'manual' | 'copia' | 'libre';
/** 'precios' sigue al precio de Precios (se refresca mientras es borrador); 'manual' lo pisó la usuaria. */
export type PriceSource = 'precios' | 'manual';

export interface OrderLine {
  id?: number;
  kind: OrderLineKind;
  packId: number | null;
  sku: string | null;
  code: string;
  description: string;
  /** Texto libre para la fábrica: diseños, colores, etc. */
  detail: string;
  /** Siempre en packs (o bultos, para un SKU sin pack). */
  qty: number;
  /** Precio de lista por pack, antes de descuentos. */
  unitPrice: number | null;
  priceSource: PriceSource;
  unitsPerPack: number | null;
  origin: OrderLineOrigin;
  receivedQty: number | null;
}

export interface OrderTotals {
  lineCount: number;
  packs: number;
  subtotal: number;
  discount1Amount: number;
  discount2Amount: number;
  total: number;
  missingPrices: number;
}

export interface SupplierOrder {
  id: number;
  name: string;
  status: OrderStatus;
  /** Recibido pero no llegó todo. */
  partial: boolean;
  /** % sobre el subtotal de lista. */
  discount1: number;
  /** % sobre el total que queda después del primer descuento. */
  discount2: number;
  note: string;
  basedOnId: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  orderedAt: string | null;
  receivedAt: string | null;
  lines: OrderLine[];
  totals: OrderTotals;
}

/** Estado de un modelo según "Para reponer" desde el último pedido; 'watching' = tiene regla pero no avisó. */
export type MemberAlertState = 'still-low' | 'out' | 'restocked' | 'unknown' | 'watching' | null;

export interface CatalogMember {
  sku: string;
  label: string;
  stockMl: number | null;
  stockTn: number | null;
  stockEffective: number | null;
  depositoStock: number | null;
  threshold: number | null;
  alertState: MemberAlertState;
}

/** Una unidad de compra: un pack del hub, o el bulto de Precios de un SKU sin pack. */
export interface CatalogUnit {
  key: string;
  kind: 'pack' | 'sku';
  packId: number | null;
  sku: string | null;
  name: string;
  code: string | null;
  description: string;
  unitsPerPack: number;
  mode: 'assorted' | 'single' | 'bulk';
  price: number | null;
  members: CatalogMember[];
  alerted: boolean;
  suggestedQty: number | null;
  depositoStock: number | null;
  lastOrder: { orderId: number; orderName: string; date: string | null; qty: number } | null;
  pendingOrder: { orderId: number; orderName: string } | null;
}

export interface OrderDefaults {
  discount1: number;
  discount2: number;
}

export type DraftInput = Pick<SupplierOrder, 'name' | 'note' | 'discount1' | 'discount2'> & { lines: OrderLine[] };

@Injectable({ providedIn: 'root' })
export class OrdersService {
  private readonly http = inject(HttpClient);
  private readonly api = inject(ApiService);
  private readonly queryClient = inject(QueryClient);

  private get base(): string {
    return `${this.api.baseUrl}/orders`;
  }

  /** Lista y catálogo cambian juntos: el catálogo muestra "último pedido" y "en camino". */
  invalidate(): void {
    this.queryClient.invalidateQueries({ queryKey: ORDERS_LIST_QUERY_KEY });
    this.queryClient.invalidateQueries({ queryKey: ORDERS_CATALOG_QUERY_KEY });
  }

  list(status?: OrderStatus): Promise<{ orders: SupplierOrder[] }> {
    let params = new HttpParams();
    if (status) params = params.set('status', status);
    return lastValueFrom(this.http.get<{ orders: SupplierOrder[] }>(this.base, { params }));
  }

  catalog(): Promise<{ units: CatalogUnit[] }> {
    return lastValueFrom(this.http.get<{ units: CatalogUnit[] }>(`${this.base}/catalog`));
  }

  getSettings(): Promise<OrderDefaults> {
    return lastValueFrom(this.http.get<OrderDefaults>(`${this.base}/settings`));
  }

  async saveSettings(value: OrderDefaults): Promise<OrderDefaults> {
    const r = await lastValueFrom(this.http.put<OrderDefaults>(`${this.base}/settings`, value));
    this.queryClient.invalidateQueries({ queryKey: ORDERS_SETTINGS_QUERY_KEY });
    return r;
  }

  async get(id: number): Promise<SupplierOrder> {
    return (await lastValueFrom(this.http.get<{ order: SupplierOrder }>(`${this.base}/${id}`))).order;
  }

  async create(name?: string): Promise<SupplierOrder> {
    const r = await lastValueFrom(this.http.post<{ order: SupplierOrder }>(this.base, { name }));
    this.invalidate();
    return r.order;
  }

  /** Guarda el borrador entero (autoguardado del editor). No invalida el catálogo: no cambia nada que se vea ahí. */
  async saveDraft(id: number, input: DraftInput): Promise<SupplierOrder> {
    const r = await lastValueFrom(this.http.put<{ order: SupplierOrder }>(`${this.base}/${id}`, input));
    this.queryClient.invalidateQueries({ queryKey: ORDERS_LIST_QUERY_KEY });
    return r.order;
  }

  async place(id: number): Promise<SupplierOrder> {
    const r = await lastValueFrom(this.http.post<{ order: SupplierOrder }>(`${this.base}/${id}/place`, {}));
    this.invalidate();
    return r.order;
  }

  /** `received`: lineId → packs que llegaron (null = sin anotar). Con `close` cierra la recepción. */
  async receive(id: number, received: Record<number, number | null>, close = false): Promise<SupplierOrder> {
    const r = await lastValueFrom(this.http.put<{ order: SupplierOrder }>(`${this.base}/${id}/receive`, { received, close }));
    this.invalidate();
    return r.order;
  }

  async duplicate(id: number, opts: { mode?: 'all' | 'missing'; status?: 'borrador' | 'pendiente' } = {}): Promise<SupplierOrder> {
    const r = await lastValueFrom(this.http.post<{ order: SupplierOrder }>(`${this.base}/${id}/duplicate`, opts));
    this.invalidate();
    return r.order;
  }

  async delete(id: number): Promise<void> {
    await lastValueFrom(this.http.delete<{ ok: boolean }>(`${this.base}/${id}`));
    this.invalidate();
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Mismo cálculo que computeOrderTotals del backend, para ver el total al instante mientras se edita. */
export function computeOrderTotals(order: Pick<SupplierOrder, 'discount1' | 'discount2'> & { lines: OrderLine[] }): OrderTotals {
  const priced = order.lines.filter((l) => l.unitPrice != null);
  const subtotal = round2(priced.reduce((a, l) => a + l.qty * (l.unitPrice as number), 0));
  const afterDiscount1 = round2(subtotal * (1 - (order.discount1 || 0) / 100));
  const total = round2(afterDiscount1 * (1 - (order.discount2 || 0) / 100));
  return {
    lineCount: order.lines.length,
    packs: order.lines.reduce((a, l) => a + l.qty, 0),
    subtotal,
    discount1Amount: round2(subtotal - afterDiscount1),
    discount2Amount: round2(afterDiscount1 - total),
    total,
    missingPrices: order.lines.length - priced.length,
  };
}

/** Línea nueva a partir de una unidad del catálogo. */
export function lineFromCatalogUnit(unit: CatalogUnit, qty: number): OrderLine {
  return {
    kind: unit.kind,
    packId: unit.packId,
    sku: unit.sku,
    code: unit.code ?? '',
    description: unit.description,
    detail: '',
    qty,
    unitPrice: unit.price,
    priceSource: 'precios',
    unitsPerPack: unit.unitsPerPack,
    origin: unit.alerted ? 'alerta' : 'manual',
    receivedQty: null,
  };
}

/** Clave de catálogo (`pack:N` / `sku:X`) de una línea; `null` para un ítem libre. */
export function lineKey(line: Pick<OrderLine, 'kind' | 'packId' | 'sku'>): string | null {
  if (line.kind === 'pack') return `pack:${line.packId}`;
  if (line.kind === 'sku') return `sku:${line.sku}`;
  return null;
}

export function orderStatusLabel(order: Pick<SupplierOrder, 'status' | 'partial'>): string {
  if (order.status === 'borrador') return 'Borrador';
  if (order.status === 'pendiente') return 'Pendiente';
  return order.partial ? 'Recibido incompleto' : 'Recibido';
}
