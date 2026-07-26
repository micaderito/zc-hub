import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { provideTanStackQuery, QueryClient } from '@tanstack/angular-query-experimental';
import { ProductHistoryDialogComponent } from './product-history-dialog.component';
import { SyncService, SyncAuditRow } from '../../../../core/services/sync.service';
import { PricingService, PriceAuditRow } from '../../../../core/services/pricing.service';

function stockRow(overrides: Partial<SyncAuditRow> = {}): SyncAuditRow {
  return {
    id: 1,
    source: 'venta',
    channelSale: 'mercadolibre',
    orderId: '123',
    packId: '123',
    saleItemId: null,
    sku: 'SKU1',
    productLabel: 'Cuaderno',
    productDisplay: null,
    quantity: 1,
    updatedChannel: 'tiendanube',
    stockBefore: 10,
    stockAfter: 9,
    createdAt: '2026-07-10T10:00:00.000Z',
    revertedAt: null,
    ...overrides,
  } as SyncAuditRow;
}

function priceRow(overrides: Partial<PriceAuditRow> = {}): PriceAuditRow {
  return {
    id: 1,
    sku: 'SKU1',
    channel: 'mercadolibre',
    priceBefore: 1000,
    priceAfter: 1200,
    source: 'bulk',
    productLabel: 'Cuaderno',
    createdAt: '2026-07-11T10:00:00.000Z',
    ...overrides,
  };
}

describe('ProductHistoryDialogComponent', () => {
  let syncSpy: jasmine.SpyObj<SyncService>;
  let pricingSpy: jasmine.SpyObj<PricingService>;
  let fixture: ComponentFixture<ProductHistoryDialogComponent>;

  beforeEach(() => {
    syncSpy = jasmine.createSpyObj<SyncService>('SyncService', ['getStockHistoryBySku']);
    pricingSpy = jasmine.createSpyObj<PricingService>('PricingService', ['getPriceHistoryBySku']);

    TestBed.configureTestingModule({
      imports: [ProductHistoryDialogComponent],
      providers: [
        provideTanStackQuery(new QueryClient({ defaultOptions: { queries: { retry: false } } })),
        { provide: SyncService, useValue: syncSpy },
        { provide: PricingService, useValue: pricingSpy },
      ],
    });
  });

  /**
   * Crea el componente y espera a que resuelvan las DOS queries. TanStack necesita que corra un
   * macrotask además del whenStable para pasar de 'pending' a 'success'/'error'.
   */
  async function createAndLoad(): Promise<void> {
    fixture = TestBed.createComponent(ProductHistoryDialogComponent);
    fixture.componentRef.setInput('sku', 'SKU1');
    fixture.detectChanges();
    for (let i = 0; i < 3; i++) {
      await fixture.whenStable();
      await new Promise((resolve) => setTimeout(resolve, 0));
      fixture.detectChanges();
    }
  }

  it('fusiona stock y precios en una sola línea de tiempo, más reciente primero', async () => {
    syncSpy.getStockHistoryBySku.and.returnValue(
      of({ rows: [stockRow({ id: 1, createdAt: '2026-07-10T10:00:00.000Z' })], total: 1 }) as never,
    );
    pricingSpy.getPriceHistoryBySku.and.returnValue(
      of({ rows: [priceRow({ id: 1, createdAt: '2026-07-11T10:00:00.000Z' })], total: 1 }) as never,
    );

    await createAndLoad();

    const text = fixture.nativeElement.textContent as string;
    // ambas fuentes presentes
    expect(text).toContain('Historial del producto');
    const rows = fixture.nativeElement.querySelectorAll('.hist-row');
    expect(rows.length).toBe(2);
    // el de precio (11/07) es más reciente que el de stock (10/07): va primero
    expect(rows[0].querySelector('.hist-kind.price')).not.toBeNull();
    expect(rows[1].querySelector('.hist-kind.stock')).not.toBeNull();
  });

  it('muestra el historial de stock aunque el de precios falle', async () => {
    syncSpy.getStockHistoryBySku.and.returnValue(of({ rows: [stockRow()], total: 1 }) as never);
    pricingSpy.getPriceHistoryBySku.and.returnValue(throwError(() => new Error('boom')) as never);

    await createAndLoad();

    expect(fixture.nativeElement.querySelectorAll('.hist-row').length).toBe(1);
    expect(fixture.nativeElement.querySelector('.hist-msg.err')).toBeNull();
  });

  it('solo muestra error si fallan las dos fuentes', async () => {
    syncSpy.getStockHistoryBySku.and.returnValue(throwError(() => new Error('boom')) as never);
    pricingSpy.getPriceHistoryBySku.and.returnValue(throwError(() => new Error('boom')) as never);

    await createAndLoad();

    expect(fixture.nativeElement.querySelector('.hist-msg.err')).not.toBeNull();
  });

  it('sin cambios en ninguna fuente muestra el estado vacío', async () => {
    syncSpy.getStockHistoryBySku.and.returnValue(of({ rows: [], total: 0 }) as never);
    pricingSpy.getPriceHistoryBySku.and.returnValue(of({ rows: [], total: 0 }) as never);

    await createAndLoad();

    expect(fixture.nativeElement.querySelector('.hist-empty')).not.toBeNull();
  });

  it('una subida de precio se marca como up y una baja como down', async () => {
    syncSpy.getStockHistoryBySku.and.returnValue(of({ rows: [], total: 0 }) as never);
    pricingSpy.getPriceHistoryBySku.and.returnValue(
      of({
        rows: [
          priceRow({ id: 1, priceBefore: 1000, priceAfter: 1200, createdAt: '2026-07-11T10:00:00.000Z' }),
          priceRow({ id: 2, priceBefore: 1000, priceAfter: 800, createdAt: '2026-07-10T10:00:00.000Z' }),
        ],
        total: 2,
      }) as never,
    );

    await createAndLoad();

    const rows = fixture.nativeElement.querySelectorAll('.hist-row');
    expect(rows[0].querySelector('strong.up')).not.toBeNull();
    expect(rows[1].querySelector('strong.down')).not.toBeNull();
  });

  it('un precio sin valor previo no marca dirección ni muestra flecha', async () => {
    syncSpy.getStockHistoryBySku.and.returnValue(of({ rows: [], total: 0 }) as never);
    pricingSpy.getPriceHistoryBySku.and.returnValue(
      of({ rows: [priceRow({ priceBefore: null, priceAfter: 1200 })], total: 1 }) as never,
    );

    await createAndLoad();

    const row = fixture.nativeElement.querySelector('.hist-row');
    expect(row.querySelector('strong.up')).toBeNull();
    expect(row.querySelector('strong.down')).toBeNull();
    expect(row.querySelector('.ti-arrow-right')).toBeNull();
  });
});
