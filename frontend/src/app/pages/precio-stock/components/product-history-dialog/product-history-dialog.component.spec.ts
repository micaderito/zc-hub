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

  it('las dos caras de una venta se muestran como un solo evento con el estado de los dos canales', async () => {
    // Venta en ML: ML descontó lo suyo (fila del canal) y el hub descontó en TN (fila espejo).
    syncSpy.getStockHistoryBySku.and.returnValue(
      of({
        rows: [
          stockRow({ id: 1, updatedChannel: 'mercadolibre', actor: 'plataforma', productLabel: 'Venta ML',
                     stockBefore: 10, stockAfter: 9, createdAt: '2026-07-10T10:00:00.000Z' }),
          stockRow({ id: 2, updatedChannel: 'tiendanube', productLabel: 'Venta ML',
                     stockBefore: 10, stockAfter: 9, createdAt: '2026-07-10T10:00:02.000Z' }),
        ],
        total: 2,
      }) as never,
    );
    pricingSpy.getPriceHistoryBySku.and.returnValue(of({ rows: [], total: 0 }) as never);

    await createAndLoad();

    const rows = fixture.nativeElement.querySelectorAll('.hist-row');
    expect(rows.length).toBe(1);
    expect(rows[0].querySelectorAll('.hist-side').length).toBe(2);
    expect(rows[0].querySelector('.hist-state.desync')).toBeNull();
    expect(fixture.nativeElement.querySelector('.hist-summary')?.textContent).toContain('Sincronizado');
  });

  it('si falta la cara del espejo, el evento queda marcado como desincronizado', async () => {
    // El descuento en TN nunca se registró: ML quedó en 9 y TN en 10.
    syncSpy.getStockHistoryBySku.and.returnValue(
      of({
        rows: [
          stockRow({ id: 1, updatedChannel: 'tiendanube', productLabel: 'Venta ML', packId: '100',
                     orderId: '100', stockBefore: 11, stockAfter: 10, createdAt: '2026-07-09T10:00:00.000Z' }),
          stockRow({ id: 2, updatedChannel: 'mercadolibre', actor: 'plataforma', productLabel: 'Venta ML',
                     packId: '101', orderId: '101', stockBefore: 10, stockAfter: 9,
                     createdAt: '2026-07-10T10:00:00.000Z' }),
        ],
        total: 2,
      }) as never,
    );
    pricingSpy.getPriceHistoryBySku.and.returnValue(of({ rows: [], total: 0 }) as never);

    await createAndLoad();

    const rows = fixture.nativeElement.querySelectorAll('.hist-row');
    expect(rows.length).toBe(2);
    // El más reciente (la venta 101, que solo movió ML) es el desincronizado.
    expect(rows[0].querySelector('.hist-state.desync')).not.toBeNull();
    expect(rows[0].querySelector('.hist-side.missing')).not.toBeNull();
    const summary = fixture.nativeElement.querySelector('.hist-summary');
    expect(summary.classList).toContain('desync');
    expect(summary.textContent).toContain('Desincronizado');
  });

  it('un cambio hecho en el panel del canal se muestra como externo', async () => {
    syncSpy.getStockHistoryBySku.and.returnValue(
      of({
        rows: [
          stockRow({ id: 1, source: 'externo', actor: 'plataforma', channelSale: null, orderId: null,
                     packId: null, quantity: null, updatedChannel: 'mercadolibre',
                     productLabel: 'Cambio en ML', stockBefore: 9, stockAfter: 20 }),
        ],
        total: 1,
      }) as never,
    );
    pricingSpy.getPriceHistoryBySku.and.returnValue(of({ rows: [], total: 0 }) as never);

    await createAndLoad();

    const row = fixture.nativeElement.querySelector('.hist-row');
    expect(row.querySelector('.hist-source.externo')).not.toBeNull();
    expect(row.textContent).toContain('Cambio en ML');
    // Un cambio suelto no espera espejo: no se muestra el hueco del otro canal.
    expect(row.querySelector('.hist-side.missing')).toBeNull();
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
