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
  async function createAndLoad(initialTab: 'stock' | 'price' = 'stock'): Promise<void> {
    fixture = TestBed.createComponent(ProductHistoryDialogComponent);
    fixture.componentRef.setInput('sku', 'SKU1');
    fixture.componentRef.setInput('initialTab', initialTab);
    fixture.detectChanges();
    for (let i = 0; i < 3; i++) {
      await fixture.whenStable();
      await new Promise((resolve) => setTimeout(resolve, 0));
      fixture.detectChanges();
    }
  }

  /** Click en la pestaña con ese texto ("Stock" / "Precio"). */
  async function clickTab(label: string): Promise<void> {
    const btn = [...fixture.nativeElement.querySelectorAll('[role="tab"]')]
      .find((b: HTMLElement) => b.textContent?.trim().startsWith(label)) as HTMLElement;
    btn.click();
    fixture.detectChanges();
    await fixture.whenStable();
  }

  it('separa stock y precio en dos pestañas, con el total de cada una', async () => {
    syncSpy.getStockHistoryBySku.and.returnValue(
      of({ rows: [stockRow({ id: 1, createdAt: '2026-07-10T10:00:00.000Z' })], total: 1 }) as never,
    );
    pricingSpy.getPriceHistoryBySku.and.returnValue(
      of({
        rows: [
          priceRow({ id: 1, createdAt: '2026-07-11T10:00:00.000Z' }),
          priceRow({ id: 2, createdAt: '2026-07-12T10:00:00.000Z', source: 'externo', channel: 'tiendanube' }),
        ],
        total: 2,
      }) as never,
    );

    await createAndLoad();

    const tabs = [...fixture.nativeElement.querySelectorAll('[role="tab"]')] as HTMLElement[];
    expect(tabs.map((t) => t.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['Stock 1', 'Precio 2']);
    // Arranca en Stock: solo el movimiento de stock.
    expect(fixture.nativeElement.querySelectorAll('.hist-row').length).toBe(1);
    expect(fixture.nativeElement.textContent).toContain('Cuaderno');

    await clickTab('Precio');
    const rows = fixture.nativeElement.querySelectorAll('.hist-row');
    expect(rows.length).toBe(2);
    // más reciente primero: el externo de TN (12/07) antes que el de Precios (11/07)
    expect(rows[0].querySelector('.hist-source')?.textContent?.trim()).toBe('Cambio en TN');
    expect(rows[0].querySelector('.hist-source.externo')).not.toBeNull();
    expect(rows[1].querySelector('.hist-source')?.textContent?.trim()).toBe('Precios');
  });

  it('initialTab="price" abre directo en la pestaña de precio', async () => {
    syncSpy.getStockHistoryBySku.and.returnValue(of({ rows: [stockRow()], total: 1 }) as never);
    pricingSpy.getPriceHistoryBySku.and.returnValue(
      of({ rows: [priceRow({ source: 'sync', channel: 'tiendanube' })], total: 1 }) as never,
    );

    await createAndLoad('price');

    const active = fixture.nativeElement.querySelector('[role="tab"].active') as HTMLElement;
    expect(active.textContent).toContain('Precio');
    expect(fixture.nativeElement.querySelector('.hist-source')?.textContent?.trim()).toBe('Sincronizar precios');
  });

  it('el mismo "aplicar" en ML y TN se muestra como un solo evento de precio', async () => {
    syncSpy.getStockHistoryBySku.and.returnValue(of({ rows: [], total: 0 }) as never);
    pricingSpy.getPriceHistoryBySku.and.returnValue(
      of({
        rows: [
          priceRow({ id: 1, channel: 'mercadolibre', source: 'manual', productLabel: null, createdAt: '2026-07-11T10:00:00.000Z' }),
          priceRow({ id: 2, channel: 'tiendanube', source: 'manual', productLabel: null, createdAt: '2026-07-11T10:00:20.000Z' }),
        ],
        total: 2,
      }) as never,
    );

    await createAndLoad('price');

    const rows = fixture.nativeElement.querySelectorAll('.hist-row');
    expect(rows.length).toBe(1);
    expect(rows[0].querySelectorAll('.hist-side').length).toBe(2);
    expect(rows[0].querySelector('.hist-source.manual')?.textContent?.trim()).toBe('Cambio manual');
  });

  it('un cambio manual hecho desde el editor de publicaciones muestra su propio rótulo', async () => {
    syncSpy.getStockHistoryBySku.and.returnValue(of({ rows: [], total: 0 }) as never);
    pricingSpy.getPriceHistoryBySku.and.returnValue(
      of({ rows: [priceRow({ source: 'manual', productLabel: 'Edición de publicación' })], total: 1 }) as never,
    );

    await createAndLoad('price');

    expect(fixture.nativeElement.querySelector('.hist-source')?.textContent?.trim()).toBe('Edición de publicación');
  });

  it('muestra el historial de stock aunque el de precios falle (y el error queda en su pestaña)', async () => {
    syncSpy.getStockHistoryBySku.and.returnValue(of({ rows: [stockRow()], total: 1 }) as never);
    pricingSpy.getPriceHistoryBySku.and.returnValue(throwError(() => new Error('boom')) as never);

    await createAndLoad();

    expect(fixture.nativeElement.querySelectorAll('.hist-row').length).toBe(1);
    expect(fixture.nativeElement.querySelector('.hist-msg.err')).toBeNull();

    await clickTab('Precio');
    expect(fixture.nativeElement.querySelector('.hist-msg.err')?.textContent).toContain('precios');
  });

  it('sin cambios en ninguna fuente cada pestaña muestra su estado vacío', async () => {
    syncSpy.getStockHistoryBySku.and.returnValue(of({ rows: [], total: 0 }) as never);
    pricingSpy.getPriceHistoryBySku.and.returnValue(of({ rows: [], total: 0 }) as never);

    await createAndLoad();
    expect(fixture.nativeElement.querySelector('.hist-empty')?.textContent).toContain('stock');

    await clickTab('Precio');
    expect(fixture.nativeElement.querySelector('.hist-empty')?.textContent).toContain('precio');
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

    await createAndLoad('price');

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

  it('un cambio manual de una sola cara muestra "sin cambio" del otro canal, con el mismo valor en ambos', async () => {
    // El caso del incidente 2026-09-05: se sincronizó a mano y la cara de ML se perdió por una
    // carrera con el webhook. Antes del fix esto quedaba como un hueco sin explicar; ahora se
    // muestra como "TN sin cambio" (ya estaba en el valor pedido) y el chip dice sincronizado.
    syncSpy.getStockHistoryBySku.and.returnValue(
      of({
        rows: [
          stockRow({ id: 1, source: 'manual', channelSale: null, orderId: null, packId: null,
                     quantity: null, updatedChannel: 'mercadolibre', productLabel: 'Cambio manual',
                     stockBefore: 0, stockAfter: 2, createdAt: '2026-09-05T13:37:00.000Z' }),
        ],
        total: 1,
      }) as never,
    );
    pricingSpy.getPriceHistoryBySku.and.returnValue(of({ rows: [], total: 0 }) as never);

    await createAndLoad();

    const row = fixture.nativeElement.querySelector('.hist-row');
    const missing = row.querySelector('.hist-side.missing');
    expect(missing).not.toBeNull();
    expect(missing.textContent).toContain('TN');
    expect(missing.textContent).toContain('sin cambio');
  });

  it('el chip del header usa el stock real (input) en vez del arrastrado por el historial', async () => {
    // Mismo escenario que el anterior (cara de ML perdida, historial arrastra un ML viejo), pero
    // el llamador SÍ tiene el stock real de catálogo: el chip de arriba tiene que decir
    // "Sincronizado" con los números reales, no derivar del historial incompleto.
    syncSpy.getStockHistoryBySku.and.returnValue(
      of({
        rows: [
          stockRow({ id: 1, source: 'manual', channelSale: null, orderId: null, packId: null,
                     quantity: null, updatedChannel: 'tiendanube', productLabel: 'Cambio manual',
                     stockBefore: 0, stockAfter: 2, createdAt: '2026-09-05T13:37:00.000Z' }),
        ],
        total: 1,
      }) as never,
    );
    pricingSpy.getPriceHistoryBySku.and.returnValue(of({ rows: [], total: 0 }) as never);

    fixture = TestBed.createComponent(ProductHistoryDialogComponent);
    fixture.componentRef.setInput('sku', 'SKU1');
    fixture.componentRef.setInput('mlStock', 2);
    fixture.componentRef.setInput('tnStock', 2);
    fixture.detectChanges();
    for (let i = 0; i < 3; i++) {
      await fixture.whenStable();
      await new Promise((resolve) => setTimeout(resolve, 0));
      fixture.detectChanges();
    }

    const summary = fixture.nativeElement.querySelector('.hist-summary');
    expect(summary.classList).not.toContain('desync');
    expect(summary.textContent).toContain('Sincronizado');
  });

  it('sin stock real (input), el chip del header cae al valor derivado del historial', async () => {
    syncSpy.getStockHistoryBySku.and.returnValue(
      of({
        rows: [
          stockRow({ id: 1, updatedChannel: 'mercadolibre', packId: '100', orderId: '100',
                     productLabel: 'Venta ML', stockBefore: 10, stockAfter: 9 }),
        ],
        total: 1,
      }) as never,
    );
    pricingSpy.getPriceHistoryBySku.and.returnValue(of({ rows: [], total: 0 }) as never);

    await createAndLoad();

    // Sin mlStock/tnStock (default null), sigue derivando del historial: falta la cara TN → sin
    // estado conocido de los dos canales → no se muestra el resumen.
    expect(fixture.nativeElement.querySelector('.hist-summary')).toBeNull();
  });

  it('un precio sin valor previo no marca dirección ni muestra flecha', async () => {
    syncSpy.getStockHistoryBySku.and.returnValue(of({ rows: [], total: 0 }) as never);
    pricingSpy.getPriceHistoryBySku.and.returnValue(
      of({ rows: [priceRow({ priceBefore: null, priceAfter: 1200 })], total: 1 }) as never,
    );

    await createAndLoad('price');

    const row = fixture.nativeElement.querySelector('.hist-row');
    expect(row.querySelector('strong.up')).toBeNull();
    expect(row.querySelector('strong.down')).toBeNull();
    expect(row.querySelector('.ti-arrow-right')).toBeNull();
  });
});
