import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { QueryClient } from '@tanstack/angular-query-experimental';
import {
  ConflictsService,
  ConflictAnalysis,
  MlRow,
  TnRow,
  CONFLICTS_ANALYSIS_QUERY_KEY,
  getPairId,
  mlLabel,
  tnLabel,
  matchSearchByTokens
} from './conflicts.service';

function mlRow(overrides: Partial<MlRow> = {}): MlRow {
  return {
    type: 'ml',
    itemId: 'MLA1',
    variationId: null,
    title: 'Cuaderno A4',
    sku: 'SKU-1',
    hasSku: true,
    ...overrides
  };
}

function tnRow(overrides: Partial<TnRow> = {}): TnRow {
  return {
    type: 'tn',
    productId: 1,
    variantId: 10,
    productName: 'Cuaderno A4',
    sku: 'SKU-1',
    hasSku: true,
    ...overrides
  };
}

function analysisFixture(
  matched: ConflictAnalysis['matched'] = [],
  overrides: Partial<Pick<ConflictAnalysis, 'stockSummary' | 'stockTotal' | 'paging'>> = {}
): ConflictAnalysis {
  return {
    mlConnected: true,
    tnConnected: true,
    summary: {
      matched: matched.length,
      onlyML: 0,
      onlyTN: 0,
      noSkuML: 0,
      noSkuTN: 0,
      duplicateSkuML: 0,
      duplicateSkuTN: 0,
      resolved: 0
    },
    matched,
    onlyML: [],
    onlyTN: [],
    noSkuML: [],
    noSkuTN: [],
    duplicateSkuML: [],
    duplicateSkuTN: [],
    mappings: [],
    paging: overrides.paging ?? { page: 1, limit: 25, total: matched.length, pages: 1 },
    stockSummary: overrides.stockSummary,
    stockTotal: overrides.stockTotal
  };
}

describe('funciones puras de conflicts.service', () => {
  it('getPairId() combina itemId, variationId, productId y variantId', () => {
    const pair = { ml: mlRow({ itemId: 'MLA1', variationId: 'V1' }), tn: tnRow({ productId: 5, variantId: 9 }) };
    expect(getPairId(pair)).toBe('MLA1:V1:5:9');
  });

  it('getPairId() usa string vacío cuando no hay variationId', () => {
    const pair = { ml: mlRow({ itemId: 'MLA1', variationId: null }), tn: tnRow({ productId: 5, variantId: 9 }) };
    expect(getPairId(pair)).toBe('MLA1::5:9');
  });

  it('mlLabel() devuelve solo el título cuando no hay variación', () => {
    expect(mlLabel(mlRow({ title: 'Cuaderno A4', variationId: null }))).toBe('Cuaderno A4');
  });

  it('mlLabel() agrega el nombre de la variante entre paréntesis cuando existe', () => {
    expect(mlLabel(mlRow({ title: 'Cuaderno', variationId: 'V1', variationName: 'Negro · A4' })))
      .toBe('Cuaderno (Negro · A4)');
  });

  it('mlLabel() usa "var. <id>" cuando hay variación pero sin nombre legible', () => {
    expect(mlLabel(mlRow({ title: 'Cuaderno', variationId: 'V1', variationName: '  ' })))
      .toBe('Cuaderno (var. V1)');
  });

  it('tnLabel() usa el nombre de variante cuando existe', () => {
    expect(tnLabel(tnRow({ productName: 'Cuaderno', variantName: 'A4 · Raya' })))
      .toBe('Cuaderno (A4 · Raya)');
  });

  it('tnLabel() cae a "Var <id>" cuando no hay nombre de variante', () => {
    expect(tnLabel(tnRow({ productName: 'Cuaderno', variantId: 10, variantName: null })))
      .toBe('Cuaderno – Var 10');
  });

  it('matchSearchByTokens() devuelve true con query vacío', () => {
    expect(matchSearchByTokens('   ', 'cualquier cosa')).toBeTrue();
  });

  it('matchSearchByTokens() exige que todos los tokens estén presentes', () => {
    expect(matchSearchByTokens('rep a5 cuad', 'repuesto a5 removible cuadriculado')).toBeTrue();
    expect(matchSearchByTokens('rep a4', 'repuesto a5 removible cuadriculado')).toBeFalse();
  });

  it('matchSearchByTokens() es case-insensitive', () => {
    expect(matchSearchByTokens('CUADERNO', 'un cuaderno negro')).toBeTrue();
  });

  it('matchSearchByTokens() devuelve false con texto buscable vacío y query no vacío', () => {
    expect(matchSearchByTokens('cuaderno', '')).toBeFalse();
  });
});

describe('ConflictsService', () => {
  let service: ConflictsService;
  let httpMock: HttpTestingController;
  let queryClient: QueryClient;
  const baseUrl = 'http://localhost:4000/api';

  beforeEach(() => {
    queryClient = new QueryClient();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: QueryClient, useValue: queryClient }
      ]
    });
    service = TestBed.inject(ConflictsService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('getAnalysis() sin opciones pide la página 1 con headers de no-cache', () => {
    service.getAnalysis().subscribe(res => expect(res.summary.matched).toBe(0));
    const req = httpMock.expectOne(r => r.url === `${baseUrl}/conflicts`);
    expect(req.request.headers.get('Cache-Control')).toContain('no-cache');
    expect(req.request.params.has('page')).toBeFalse();
    req.flush(analysisFixture());
  });

  it('getAnalysis() traduce todas las opciones a query params', () => {
    service.getAnalysis({ page: 2, limit: 10, filter: 'mismatch', search: 'cuaderno', tab: 'matched' }).subscribe();
    const req = httpMock.expectOne(r =>
      r.url === `${baseUrl}/conflicts` &&
      r.params.get('page') === '2' &&
      r.params.get('limit') === '10' &&
      r.params.get('filter') === 'mismatch' &&
      r.params.get('search') === 'cuaderno' &&
      r.params.get('tab') === 'matched'
    );
    expect(req.request.method).toBe('GET');
    req.flush(analysisFixture());
  });

  it('getAnalysisPromise() resuelve con el mismo análisis que getAnalysis()', async () => {
    const promise = service.getAnalysisPromise();
    const req = httpMock.expectOne(r => r.url === `${baseUrl}/conflicts`);
    req.flush(analysisFixture());
    const result = await promise;
    expect(result.summary.matched).toBe(0);
  });

  it('updateSku() recorta el sku y arma el body con el canal y el payload', () => {
    service.updateSku('mercadolibre', '  SKU-1  ', { itemId: 'MLA1' }).subscribe(res => expect(res.ok).toBeTrue());
    const req = httpMock.expectOne(`${baseUrl}/conflicts/update-sku`);
    expect(req.request.body).toEqual({ channel: 'mercadolibre', sku: 'SKU-1', itemId: 'MLA1' });
    req.flush({ ok: true });
  });

  it('linkManually() manda el body completo al endpoint /conflicts/link', () => {
    const body = {
      sku: 'SKU-1',
      mercadolibre: { itemId: 'MLA1' },
      tiendanube: { productId: 1, variantId: 10 }
    };
    service.linkManually(body).subscribe(res => expect(res.sku).toBe('SKU-1'));
    const req = httpMock.expectOne(`${baseUrl}/conflicts/link`);
    expect(req.request.body).toEqual(body);
    req.flush({ ok: true, sku: 'SKU-1' });
  });

  it('updatePricesAndStock() omite variationId cuando es falsy', () => {
    service.updatePricesAndStock({
      itemId: 'MLA1',
      variationId: null,
      productId: 1,
      variantId: 10,
      priceML: 100,
      priceTN: 120
    }).subscribe();
    const req = httpMock.expectOne(`${baseUrl}/conflicts/update-prices`);
    expect(req.request.body.variationId).toBeUndefined();
    expect(req.request.body.priceML).toBe(100);
    req.flush({ ok: true, ml: true, tn: true });
  });

  it('getTaskStatus() hace GET a /conflicts/task/:id', () => {
    service.getTaskStatus(5).subscribe(res => expect(res.status).toBe('done'));
    const req = httpMock.expectOne(`${baseUrl}/conflicts/task/5`);
    expect(req.request.method).toBe('GET');
    req.flush({ id: 5, status: 'done' });
  });

  it('updatePairInCache() actualiza stock y precios del par que matchea por pairId', () => {
    const pair = { ml: mlRow(), tn: tnRow() };
    queryClient.setQueryData([...CONFLICTS_ANALYSIS_QUERY_KEY], analysisFixture([pair]));

    service.updatePairInCache(getPairId(pair), { stock: 5, priceML: 200, priceTN: 210 });

    const updated = queryClient.getQueryData<ConflictAnalysis>([...CONFLICTS_ANALYSIS_QUERY_KEY]);
    expect(updated?.matched[0].ml.stock).toBe(5);
    expect(updated?.matched[0].tn.stock).toBe(5);
    expect(updated?.matched[0].ml.price).toBe(200);
    expect(updated?.matched[0].tn.price).toBe(210);
  });

  it('updatePairInCache() solo actualiza precios y deja el stock intacto cuando no se pasa stock', () => {
    const pair = { ml: mlRow({ stock: 10 }), tn: tnRow({ stock: 8 }) };
    queryClient.setQueryData([...CONFLICTS_ANALYSIS_QUERY_KEY], analysisFixture([pair]));

    service.updatePairInCache(getPairId(pair), { priceML: 300 });

    const updated = queryClient.getQueryData<ConflictAnalysis>([...CONFLICTS_ANALYSIS_QUERY_KEY]);
    expect(updated?.matched[0].ml.stock).toBe(10);
    expect(updated?.matched[0].tn.stock).toBe(8);
    expect(updated?.matched[0].ml.price).toBe(300);
    expect(updated?.matched[0].tn.price).toBe(pair.tn.price);
  });

  it('updatePairInCache() no hace nada si no hay datos en caché para ese key', () => {
    expect(() => service.updatePairInCache('no-existe', { stock: 1 })).not.toThrow();
    expect(queryClient.getQueryData([...CONFLICTS_ANALYSIS_QUERY_KEY])).toBeUndefined();
  });

  it('updatePairInCache() con stock ajusta los chips (stockSummary) sin refetch', () => {
    // Antes de sincronizar: ml=10, tn=8 → mismatch. Después de "Sincronizar stock" ambos quedan en 10 → synced.
    const pair = { ml: mlRow({ stock: 10 }), tn: tnRow({ stock: 8 }) };
    queryClient.setQueryData(
      [...CONFLICTS_ANALYSIS_QUERY_KEY],
      analysisFixture([pair], { stockSummary: { total: 1, mismatch: 1, synced: 0, noStock: 0, withStock: 1 } })
    );

    service.updatePairInCache(getPairId(pair), { stock: 10 }, CONFLICTS_ANALYSIS_QUERY_KEY);

    const updated = queryClient.getQueryData<ConflictAnalysis>([...CONFLICTS_ANALYSIS_QUERY_KEY]);
    expect(updated?.stockSummary).toEqual({ total: 1, mismatch: 0, synced: 1, noStock: 0, withStock: 1 });
  });

  it('updatePairInCache() saca el par de la lista y ajusta paging cuando deja de pertenecer al filtro activo', () => {
    // Viendo la pestaña "Stock distinto" (filter: mismatch): al sincronizar, el par pasa a "synced"
    // y debe desaparecer de esta vista aunque siga siendo un match válido.
    const pair = { ml: mlRow({ stock: 10 }), tn: tnRow({ stock: 8 }) };
    const other = { ml: mlRow({ itemId: 'MLA2', stock: 3 }), tn: tnRow({ productId: 2, variantId: 20, stock: 1 }) };
    queryClient.setQueryData(
      [...CONFLICTS_ANALYSIS_QUERY_KEY],
      analysisFixture([pair, other], {
        stockSummary: { total: 2, mismatch: 2, synced: 0, noStock: 0, withStock: 1 },
        paging: { page: 1, limit: 25, total: 2, pages: 1 }
      })
    );

    service.updatePairInCache(getPairId(pair), { stock: 10 }, CONFLICTS_ANALYSIS_QUERY_KEY, 'mismatch');

    const updated = queryClient.getQueryData<ConflictAnalysis>([...CONFLICTS_ANALYSIS_QUERY_KEY]);
    expect(updated?.matched.length).toBe(1);
    expect(updated?.matched[0]).toEqual(other);
    expect(updated?.paging.total).toBe(1);
    expect(updated?.stockSummary?.mismatch).toBe(1);
    expect(updated?.stockSummary?.synced).toBe(1);
  });

  it('updatePairInCache() con stock ajusta el chip de stock total (stockTotal) sin refetch', () => {
    // ml=10, tn=8 (min vendible 8) → al sincronizar a 10/10, el par vendible pasa a aportar 10.
    const pair = { ml: mlRow({ stock: 10 }), tn: tnRow({ stock: 8 }) };
    queryClient.setQueryData(
      [...CONFLICTS_ANALYSIS_QUERY_KEY],
      analysisFixture([pair], { stockTotal: { units: 8, products: 1 } })
    );

    service.updatePairInCache(getPairId(pair), { stock: 10 }, CONFLICTS_ANALYSIS_QUERY_KEY);

    const updated = queryClient.getQueryData<ConflictAnalysis>([...CONFLICTS_ANALYSIS_QUERY_KEY]);
    expect(updated?.stockTotal).toEqual({ units: 10, products: 1 });
  });

  it('updatePairInCache() resta del stockTotal el par que deja de pertenecer al filtro activo', () => {
    // Mismo escenario que el test de stockSummary/paging de arriba, pero mirando el chip de unidades:
    // el par sincronizado (aportaba min(10,8)=8) sale de la vista "Stock distinto"; solo queda `other` (min(3,1)=1).
    const pair = { ml: mlRow({ stock: 10 }), tn: tnRow({ stock: 8 }) };
    const other = { ml: mlRow({ itemId: 'MLA2', stock: 3 }), tn: tnRow({ productId: 2, variantId: 20, stock: 1 }) };
    queryClient.setQueryData(
      [...CONFLICTS_ANALYSIS_QUERY_KEY],
      analysisFixture([pair, other], { stockTotal: { units: 9, products: 2 } })
    );

    service.updatePairInCache(getPairId(pair), { stock: 10 }, CONFLICTS_ANALYSIS_QUERY_KEY, 'mismatch');

    const updated = queryClient.getQueryData<ConflictAnalysis>([...CONFLICTS_ANALYSIS_QUERY_KEY]);
    expect(updated?.stockTotal).toEqual({ units: 1, products: 1 });
  });

  it('updatePairInCache() mantiene el par si sigue perteneciendo al filtro activo tras el update', () => {
    // ml=0, tn=5 → "Sin stock" (algún lado en 0). Al sincronizar a 0, sigue siendo "Sin stock":
    // no debería desaparecer de esa pestaña.
    const pair = { ml: mlRow({ stock: 0 }), tn: tnRow({ stock: 5 }) };
    queryClient.setQueryData(
      [...CONFLICTS_ANALYSIS_QUERY_KEY],
      analysisFixture([pair], {
        stockSummary: { total: 1, mismatch: 1, synced: 0, noStock: 1, withStock: 0 },
        paging: { page: 1, limit: 25, total: 1, pages: 1 }
      })
    );

    service.updatePairInCache(getPairId(pair), { stock: 0 }, CONFLICTS_ANALYSIS_QUERY_KEY, 'no-stock');

    const updated = queryClient.getQueryData<ConflictAnalysis>([...CONFLICTS_ANALYSIS_QUERY_KEY]);
    expect(updated?.matched.length).toBe(1);
    expect(updated?.paging.total).toBe(1);
  });

  it('updateItemVariationsPriceInCache() actualiza el precio ML de todas las filas del mismo itemId', () => {
    const pairA = { ml: mlRow({ itemId: 'MLA1', variationId: 'V1' }), tn: tnRow({ variantId: 1 }) };
    const pairB = { ml: mlRow({ itemId: 'MLA1', variationId: 'V2' }), tn: tnRow({ variantId: 2 }) };
    const pairOther = { ml: mlRow({ itemId: 'MLA2', variationId: 'V3' }), tn: tnRow({ variantId: 3 }) };
    queryClient.setQueryData([...CONFLICTS_ANALYSIS_QUERY_KEY], analysisFixture([pairA, pairB, pairOther]));

    service.updateItemVariationsPriceInCache('MLA1', 999);

    const updated = queryClient.getQueryData<ConflictAnalysis>([...CONFLICTS_ANALYSIS_QUERY_KEY]);
    expect(updated?.matched[0].ml.price).toBe(999);
    expect(updated?.matched[1].ml.price).toBe(999);
    expect(updated?.matched[2].ml.price).not.toBe(999);
  });

  it('invalidateAnalysis() invalida la query key tras el debounce, agrupando llamadas seguidas', fakeAsync(() => {
    spyOn(queryClient, 'invalidateQueries');

    service.invalidateAnalysis();
    tick(300);
    service.invalidateAnalysis();
    tick(300);
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();

    tick(300);
    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(1);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: CONFLICTS_ANALYSIS_QUERY_KEY });
  }));

  it('invalidateAnalysis() emite en analysisInvalidated$ de forma inmediata (sin esperar el debounce)', () => {
    const emitted: void[] = [];
    service.analysisInvalidated$.subscribe(v => emitted.push(v));
    service.invalidateAnalysis();
    expect(emitted.length).toBe(1);
  });
});
