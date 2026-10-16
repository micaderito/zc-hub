import { of } from 'rxjs';
import { QueryClient, provideTanStackQuery } from '@tanstack/angular-query-experimental';
import { provideRouter } from '@angular/router';
import {
  SyncService,
  SyncConfig,
  SyncAuditRow,
  SyncAuditResponse,
  PendingReturnRow,
  SyncReturnsResponse,
  PendingMlTask,
  PendingMlTasksResponse
} from '../../core/services/sync.service';

/** Fixtures y armado de TestBed que comparten los specs de "Historial y cola". */

/**
 * `pendingTasksQuery` tiene un `refetchInterval` que se reprograma solo tras cada fetch
 * exitoso, así que la zona de Angular nunca queda "estable" mientras el componente esté vivo
 * (siempre hay un timer de 4s/20s pendiente). Por eso NO se puede usar `fixture.whenStable()`
 * en estos specs — esperaría ese timer real y haría que Jasmine mate el test por timeout.
 * En su lugar, esperamos un macrotask propio (ajeno a la estabilidad de la zona) para darle
 * tiempo a la promesa del queryFn (mockeada con `of(...)`) a resolver y propagarse a los signals.
 */
export async function flushQuery(): Promise<void> {
  // Varias vueltas de macrotask/microtask: TanStack Query notifica sus cambios de estado
  // de forma asíncrona (batching interno), así que un solo tick no alcanza siempre.
  for (let i = 0; i < 3; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
    await Promise.resolve();
  }
}

export const configConDb: SyncConfig = { enabled: true, hasDatabase: true };
export const configSinDb: SyncConfig = { enabled: false, hasDatabase: false };

export const auditVacio: SyncAuditResponse = { rows: [], total: 0 };
export const returnsVacio: SyncReturnsResponse = { rows: [], total: 0 };
export const tasksVacio: PendingMlTasksResponse = { tasks: [], total: 0, activeCount: 0, failedCount: 0 };
export const fetchVacio = { ok: true, claimsChecked: 0, created: 0, skipped: 0 };

export const auditRow: SyncAuditRow = {
  id: 1,
  source: 'venta',
  channelSale: 'mercadolibre',
  orderId: 'ORD-1',
  packId: 'PACK-1',
  saleItemId: 'MLA123',
  sku: 'SKU-1',
  productLabel: 'Venta ML',
  productDisplay: 'Cuaderno A4 - Tapa dura',
  quantity: 2,
  updatedChannel: 'tiendanube',
  stockBefore: 10,
  stockAfter: 8,
  createdAt: '2026-01-01T10:00:00Z',
  revertedAt: null
};

/** Cambio hecho a mano: sin venta detrás, por eso channelSale/orderId/quantity van en null. */
export const auditRowManual: SyncAuditRow = {
  id: 2,
  source: 'manual',
  channelSale: null,
  orderId: null,
  packId: null,
  saleItemId: null,
  sku: 'SKU-2',
  productLabel: 'Cambio manual',
  productDisplay: null,
  quantity: null,
  updatedChannel: 'mercadolibre',
  stockBefore: 5,
  stockAfter: 2,
  createdAt: '2026-01-02T10:00:00Z',
  revertedAt: null
};

export const returnRow: PendingReturnRow = {
  id: 5,
  orderId: 'ORD-99',
  saleOrderId: null,
  itemId: 'MLA456',
  variationId: null,
  sku: 'SKU-2',
  quantity: 1,
  productLabel: 'Cuaderno tapa dura',
  reason: 'Producto dañado',
  buyerNickname: 'comprador1',
  claimDate: '2026-01-02T12:00:00Z',
  status: 'pending',
  createdAt: '2026-01-02T12:00:00Z'
};

export const failedTask: PendingMlTask = {
  id: 7,
  kind: 'stock_ml',
  itemId: 'MLA456',
  variationId: null,
  targetQty: -3,
  targetSku: null,
  targetPrice: null,
  status: 'failed',
  stuck: false,
  attempts: 2,
  lastError: 'timeout',
  createdAt: '2026-01-03T10:00:00Z',
  updatedAt: '2026-01-03T10:05:00Z',
  nextRunAt: '2026-01-03T10:10:00Z'
};

/** SyncService mockeado con valores por defecto "seguros": cada test pisa solo lo que le importa. */
export function createSyncServiceSpy(): jasmine.SpyObj<SyncService> {
  const spy = jasmine.createSpyObj<SyncService>('SyncService', [
    'getConfig',
    'setSyncEnabled',
    'getAudit',
    'revertAudit',
    'reprocessOrder',
    'getReturns',
    'fetchReturnsFromMl',
    'addReturnsFromOrder',
    'approveReturn',
    'dismissReturn',
    'getPendingTasks',
    'retryTask',
    'registerWebhooks'
  ]);
  spy.getConfig.and.returnValue(of(configSinDb));
  spy.getAudit.and.returnValue(of(auditVacio));
  spy.getReturns.and.returnValue(of(returnsVacio));
  spy.fetchReturnsFromMl.and.returnValue(of(fetchVacio));
  spy.getPendingTasks.and.returnValue(of(tasksVacio));
  spy.setSyncEnabled.and.returnValue(of({ enabled: true }));
  spy.revertAudit.and.returnValue(of({ ok: true }));
  spy.reprocessOrder.and.returnValue(of({ ok: true, orderId: 'ORD-1', itemsSynced: 1 }));
  spy.addReturnsFromOrder.and.returnValue(of({ created: 0, rows: [] }));
  spy.approveReturn.and.returnValue(of({ ok: true, mlRestored: true, tnRestored: true }));
  spy.dismissReturn.and.returnValue(of({ ok: true }));
  spy.retryTask.and.returnValue(of({ ok: true }));
  spy.registerWebhooks.and.returnValue(of({ ok: true, registered: 0, created: [] }));
  return spy;
}

/** Providers comunes: router, TanStack Query sin reintentos y el SyncService mockeado. */
export function syncTestProviders(spy: jasmine.SpyObj<SyncService>) {
  return [
    provideRouter([]),
    provideTanStackQuery(new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })),
    { provide: SyncService, useValue: spy }
  ];
}
