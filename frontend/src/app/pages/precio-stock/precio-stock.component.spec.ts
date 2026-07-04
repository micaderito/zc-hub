import { ComponentFixture, TestBed, fakeAsync, tick, flush } from '@angular/core/testing';
import { of, throwError, Subject } from 'rxjs';
import { provideTanStackQuery, QueryClient } from '@tanstack/angular-query-experimental';
import { PrecioStockComponent } from './precio-stock.component';
import {
  ConflictsService,
  ConflictAnalysis,
  MlRow,
  TnRow,
  getPairId,
} from '../../core/services/conflicts.service';

type Pair = { ml: MlRow; tn: TnRow };

function makeMlRow(overrides: Partial<MlRow> = {}): MlRow {
  return {
    type: 'ml',
    itemId: 'MLA1',
    variationId: null,
    title: 'Cuaderno A4',
    sku: 'SKU1',
    hasSku: true,
    price: 100,
    stock: 10,
    ...overrides,
  };
}

function makeTnRow(overrides: Partial<TnRow> = {}): TnRow {
  return {
    type: 'tn',
    productId: 1,
    variantId: 11,
    productName: 'Cuaderno A4',
    sku: 'SKU1',
    hasSku: true,
    price: 100,
    stock: 10,
    ...overrides,
  };
}

/**
 * Fixture con 3 pares: uno sin variación (pair1) y dos variaciones del mismo ítem ML
 * (pair2a / pair2b), necesario para probar el bloqueo conjunto de precio por variación.
 */
function buildAnalysis(overrides: Partial<ConflictAnalysis> = {}): ConflictAnalysis {
  const pair1: Pair = { ml: makeMlRow(), tn: makeTnRow() };
  const pair2a: Pair = {
    ml: makeMlRow({ itemId: 'MLA2', variationId: 'V1', title: 'Repuesto', sku: 'SKU2', price: 50, stock: 5 }),
    tn: makeTnRow({ productId: 2, variantId: 22, productName: 'Repuesto', sku: 'SKU2', price: 50, stock: 3 }),
  };
  const pair2b: Pair = {
    ml: makeMlRow({ itemId: 'MLA2', variationId: 'V2', title: 'Repuesto', sku: 'SKU3', price: 50, stock: 4 }),
    tn: makeTnRow({ productId: 3, variantId: 33, productName: 'Repuesto', sku: 'SKU3', price: 50, stock: 4 }),
  };

  return {
    mlConnected: true,
    tnConnected: true,
    summary: {
      matched: 3,
      onlyML: 0,
      onlyTN: 0,
      noSkuML: 0,
      noSkuTN: 0,
      duplicateSkuML: 0,
      duplicateSkuTN: 0,
      resolved: 0,
    },
    matched: [pair1, pair2a, pair2b],
    onlyML: [],
    onlyTN: [],
    noSkuML: [],
    noSkuTN: [],
    duplicateSkuML: [],
    duplicateSkuTN: [],
    mappings: [],
    paging: { page: 1, limit: 25, total: 3, pages: 1 },
    stockSummary: { total: 3, mismatch: 1, synced: 2, noStock: 0, withStock: 3 },
    ...overrides,
  };
}

describe('PrecioStockComponent', () => {
  let fixture: ComponentFixture<PrecioStockComponent>;
  let component: PrecioStockComponent;
  let conflictsSpy: jasmine.SpyObj<ConflictsService>;

  beforeEach(() => {
    conflictsSpy = jasmine.createSpyObj<ConflictsService>('ConflictsService', [
      'getAnalysisPromise',
      'updatePricesAndStock',
      'updatePairInCache',
      'updateItemVariationsPriceInCache',
      'invalidateAnalysis',
      'getTaskStatus',
    ]);
    conflictsSpy.getAnalysisPromise.and.returnValue(Promise.resolve(buildAnalysis()));
    conflictsSpy.updatePricesAndStock.and.returnValue(of({ ok: true, ml: true, tn: true }));
    conflictsSpy.getTaskStatus.and.returnValue(of({ id: 0, status: 'done' }));

    TestBed.configureTestingModule({
      imports: [PrecioStockComponent],
      providers: [
        provideTanStackQuery(new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })),
        { provide: ConflictsService, useValue: conflictsSpy },
      ],
    });
  });

  /** Crea el componente y espera a que la query de TanStack resuelva. */
  async function createAndLoad(analysis: ConflictAnalysis = buildAnalysis()): Promise<void> {
    conflictsSpy.getAnalysisPromise.and.returnValue(Promise.resolve(analysis));
    fixture = TestBed.createComponent(PrecioStockComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  describe('carga del análisis', () => {
    it('carga el análisis correctamente y expone los pares matcheados', async () => {
      const analysis = buildAnalysis();
      await createAndLoad(analysis);

      expect(component.loading()).toBeFalse();
      expect(component.error()).toBeNull();
      expect(component.analysis()).toEqual(analysis);
      expect(component.analysis()!.matched.length).toBe(3);
      expect(component.analysis()!.stockSummary).toEqual(analysis.stockSummary);
    });

    it('expone un mensaje de error cuando falla la carga del análisis', async () => {
      conflictsSpy.getAnalysisPromise.and.returnValue(Promise.reject({ message: 'Network error' }));
      fixture = TestBed.createComponent(PrecioStockComponent);
      component = fixture.componentInstance;
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(component.error()).toBe('Network error');
      expect(component.analysis()).toBeNull();
    });

    it('usa el mensaje por defecto cuando el error no trae detalle', async () => {
      conflictsSpy.getAnalysisPromise.and.returnValue(Promise.reject({}));
      fixture = TestBed.createComponent(PrecioStockComponent);
      component = fixture.componentInstance;
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(component.error()).toBe('Error al cargar.');
    });
  });

  describe('paginación', () => {
    beforeEach(async () => {
      await createAndLoad(buildAnalysis({ paging: { page: 1, limit: 25, total: 75, pages: 3 } }));
    });

    it('goToPage avanza de página dentro de los límites', () => {
      expect(component.currentPage()).toBe(1);
      component.goToPage(2);
      expect(component.currentPage()).toBe(2);
    });

    it('goToPage ignora números de página menores a 1', () => {
      component.goToPage(2);
      component.goToPage(0);
      expect(component.currentPage()).toBe(2);
    });

    it('goToPage ignora números de página mayores al total', () => {
      component.goToPage(2);
      component.goToPage(10);
      expect(component.currentPage()).toBe(2);
    });
  });

  describe('colapsar y expandir pares', () => {
    beforeEach(async () => {
      await createAndLoad();
    });

    it('togglePair colapsa y luego expande un par individual', () => {
      const pair = component.analysis()!.matched[0];
      expect(component.isPairCollapsed(pair)).toBeFalse();

      component.togglePair(pair);
      expect(component.isPairCollapsed(pair)).toBeTrue();

      component.togglePair(pair);
      expect(component.isPairCollapsed(pair)).toBeFalse();
    });

    it('toggleAll colapsa todos los pares y, si ya estaban todos colapsados, los expande', () => {
      expect(component.allCollapsed()).toBeFalse();

      component.toggleAll();
      expect(component.allCollapsed()).toBeTrue();
      component.analysis()!.matched.forEach(p => expect(component.isPairCollapsed(p)).toBeTrue());

      component.toggleAll();
      expect(component.allCollapsed()).toBeFalse();
      component.analysis()!.matched.forEach(p => expect(component.isPairCollapsed(p)).toBeFalse());
    });

    it('allCollapsed() es false cuando no hay pares en la página actual', async () => {
      await createAndLoad(buildAnalysis({ matched: [] }));
      expect(component.allCollapsed()).toBeFalse();
    });
  });

  describe('refreshAnalysis', () => {
    it('limpia los overrides locales e invalida el análisis en caché', async () => {
      await createAndLoad();
      const pair = component.analysis()!.matched[0];
      component.syncStock(pair);
      expect(component.localOverrides().size).toBeGreaterThan(0);

      component.refreshAnalysis();

      expect(component.localOverrides().size).toBe(0);
      expect(conflictsSpy.invalidateAnalysis).toHaveBeenCalled();
    });
  });

  describe('updatePrices', () => {
    beforeEach(async () => {
      await createAndLoad();
    });

    it('rechaza la actualización si ambos precios son <= 0', () => {
      const pair = component.analysis()!.matched[0];
      component.pairPrices.set(getPairId(pair), { priceML: 0, priceTN: 0, syncStock: 0 });

      component.updatePrices(pair);

      expect(component.saveError).toBe('Ingresá al menos un precio mayor a 0.');
      expect(conflictsSpy.updatePricesAndStock).not.toHaveBeenCalled();
    });

    it('actualiza directamente cuando el par no tiene variación (sin pedir confirmación)', () => {
      const pair = component.analysis()!.matched[0]; // sin variationId
      component.pairPrices.set(getPairId(pair), { priceML: 150, priceTN: 120, syncStock: 5 });

      component.updatePrices(pair);

      expect(component.confirmPriceAll()).toBeNull();
      expect(conflictsSpy.updatePricesAndStock).toHaveBeenCalledWith(
        jasmine.objectContaining({ itemId: pair.ml.itemId, priceML: 150, priceTN: 120 })
      );
      expect(component.isPairPending(pair)).toBeFalse();
      expect(conflictsSpy.updatePairInCache).toHaveBeenCalled();
    });

    it('pide confirmación cuando cambia el precio ML de una variación (ítem legacy)', () => {
      const pair = component.analysis()!.matched.find(p => p.ml.variationId === 'V1')!;
      component.pairPrices.set(getPairId(pair), { priceML: 70, priceTN: 50, syncStock: 3 });

      component.updatePrices(pair);

      expect(component.confirmPriceAll()).toEqual({ pair, priceML: 70, priceTN: 50 });
      expect(conflictsSpy.updatePricesAndStock).not.toHaveBeenCalled();
    });

    it('cancelApplyPriceToAll descarta la confirmación sin llamar al backend', () => {
      const pair = component.analysis()!.matched.find(p => p.ml.variationId === 'V1')!;
      component.pairPrices.set(getPairId(pair), { priceML: 70, priceTN: 50, syncStock: 3 });
      component.updatePrices(pair);
      expect(component.confirmPriceAll()).not.toBeNull();

      component.cancelApplyPriceToAll();

      expect(component.confirmPriceAll()).toBeNull();
      expect(conflictsSpy.updatePricesAndStock).not.toHaveBeenCalled();
    });

    it('confirmApplyPriceToAll no hace nada si no hay una confirmación pendiente', () => {
      expect(component.confirmPriceAll()).toBeNull();

      component.confirmApplyPriceToAll();

      expect(conflictsSpy.updatePricesAndStock).not.toHaveBeenCalled();
    });

    it('getPairPrices calcula defaults (precios actuales y stock mínimo) para un par sin precargar', () => {
      const pair = component.analysis()!.matched.find(p => p.ml.variationId === 'V1')!;
      // Fuerza el camino "no precargado": initPairPrices ya lo pobló en el effect del
      // constructor, así que lo removemos explícitamente para ejercitar el branch `if (!p)`.
      component.pairPrices.delete(getPairId(pair));

      const prices = component.getPairPrices(pair);

      expect(prices).toEqual({ priceML: pair.ml.price!, priceTN: pair.tn.price!, syncStock: Math.min(pair.ml.stock!, pair.tn.stock!) });
      expect(component.pairPrices.get(getPairId(pair))).toEqual(prices);
    });

    it('confirmApplyPriceToAll aplica el precio a todas las variaciones del mismo ítem', () => {
      const pairs = component.analysis()!.matched;
      const pair2a = pairs.find(p => p.ml.variationId === 'V1')!;
      const pair2b = pairs.find(p => p.ml.variationId === 'V2')!;
      component.pairPrices.set(getPairId(pair2a), { priceML: 70, priceTN: 50, syncStock: 3 });
      component.updatePrices(pair2a);
      expect(component.confirmPriceAll()).not.toBeNull();

      const response$ = new Subject<{ ok: boolean; ml: boolean; tn: boolean; mlTaskId?: number }>();
      conflictsSpy.updatePricesAndStock.and.returnValue(response$.asObservable());

      component.confirmApplyPriceToAll();

      expect(component.confirmPriceAll()).toBeNull();
      // Ambas variaciones del mismo itemId quedan bloqueadas mientras se aplica el precio.
      expect(component.isPairPending(pair2a)).toBeTrue();
      expect(component.isPairPending(pair2b)).toBeTrue();

      response$.next({ ok: true, ml: true, tn: true });
      response$.complete();

      expect(component.isPairPending(pair2a)).toBeFalse();
      expect(component.isPairPending(pair2b)).toBeFalse();
      expect(conflictsSpy.updateItemVariationsPriceInCache).toHaveBeenCalledWith('MLA2', 70, jasmine.anything());
    });

    it('setea un error en el par cuando el backend rechaza la actualización de precios', () => {
      const pair = component.analysis()!.matched[0];
      component.pairPrices.set(getPairId(pair), { priceML: 200, priceTN: 150, syncStock: 5 });
      conflictsSpy.updatePricesAndStock.and.returnValue(throwError(() => ({ error: { error: 'ml rechazo' } })));

      component.updatePrices(pair);

      expect(component.getPairError(pair)).toBe('ml rechazo');
      expect(component.isPairPending(pair)).toBeFalse();
    });
  });

  describe('syncStock', () => {
    beforeEach(async () => {
      await createAndLoad();
    });

    it('sincroniza el stock y refleja el nuevo valor en el override local', () => {
      const pair = component.analysis()!.matched[0];
      const expectedStock = component.getPairPrices(pair).syncStock;

      component.syncStock(pair);

      expect(conflictsSpy.updatePricesAndStock).toHaveBeenCalledWith(
        jasmine.objectContaining({ stockML: expectedStock, stockTN: expectedStock })
      );
      expect(component.getDisplayStock(pair, 'ml')).toBe(expectedStock);
      expect(component.getDisplayStock(pair, 'tn')).toBe(expectedStock);
      expect(conflictsSpy.updatePairInCache).toHaveBeenCalled();
      expect(component.isPairPending(pair)).toBeFalse();
    });

    it('setea saveError cuando falla la sincronización de stock', () => {
      const pair = component.analysis()!.matched[0];
      conflictsSpy.updatePricesAndStock.and.returnValue(throwError(() => ({ message: 'fallo de red' })));

      component.syncStock(pair);

      expect(component.saveError).toBe('fallo de red');
      expect(component.isPairPending(pair)).toBeFalse();
    });
  });

  describe('pollMlTask (polling de actualización de precio en ML)', () => {
    it('cuando la tarea ML termina en done, aplica el precio y libera el pending', fakeAsync(() => {
      conflictsSpy.getAnalysisPromise.and.returnValue(Promise.resolve(buildAnalysis()));
      fixture = TestBed.createComponent(PrecioStockComponent);
      component = fixture.componentInstance;
      fixture.detectChanges();
      tick();
      fixture.detectChanges();

      const pair = component.analysis()!.matched[0];
      component.pairPrices.set(getPairId(pair), { priceML: 130, priceTN: 100, syncStock: 5 });
      conflictsSpy.updatePricesAndStock.and.returnValue(of({ ok: true, ml: true, tn: true, mlTaskId: 42 }));
      conflictsSpy.getTaskStatus.and.returnValues(
        of({ id: 42, status: 'pending' }),
        of({ id: 42, status: 'done' })
      );

      component.updatePrices(pair);
      expect(component.isPairPending(pair)).toBeTrue();

      tick(1500); // primer tick del timer -> todavía "pending"
      expect(component.isPairPending(pair)).toBeTrue();

      tick(2000); // segundo tick -> "done"
      expect(component.isPairPending(pair)).toBeFalse();
      expect(conflictsSpy.updatePairInCache).toHaveBeenCalled();

      flush();
    }));

    it('cuando la tarea ML falla, setea el error del par y libera el pending', fakeAsync(() => {
      conflictsSpy.getAnalysisPromise.and.returnValue(Promise.resolve(buildAnalysis()));
      fixture = TestBed.createComponent(PrecioStockComponent);
      component = fixture.componentInstance;
      fixture.detectChanges();
      tick();
      fixture.detectChanges();

      const pair = component.analysis()!.matched[0];
      component.pairPrices.set(getPairId(pair), { priceML: 130, priceTN: 100, syncStock: 5 });
      conflictsSpy.updatePricesAndStock.and.returnValue(of({ ok: true, ml: true, tn: true, mlTaskId: 99 }));
      conflictsSpy.getTaskStatus.and.returnValue(of({ id: 99, status: 'failed', lastError: 'ML devolvió 400' }));

      component.updatePrices(pair);
      tick(1500);

      expect(component.isPairPending(pair)).toBeFalse();
      expect(component.getPairError(pair)).toBe('ML devolvió 400');

      flush();
    }));

    it('cuando falla la consulta de estado de la tarea (error de red), libera el pending y setea un error genérico', fakeAsync(() => {
      conflictsSpy.getAnalysisPromise.and.returnValue(Promise.resolve(buildAnalysis()));
      fixture = TestBed.createComponent(PrecioStockComponent);
      component = fixture.componentInstance;
      fixture.detectChanges();
      tick();
      fixture.detectChanges();

      const pair = component.analysis()!.matched[0];
      component.pairPrices.set(getPairId(pair), { priceML: 130, priceTN: 100, syncStock: 5 });
      conflictsSpy.updatePricesAndStock.and.returnValue(of({ ok: true, ml: true, tn: true, mlTaskId: 77 }));
      conflictsSpy.getTaskStatus.and.returnValue(throwError(() => ({ message: 'network down' })));

      component.updatePrices(pair);
      tick(1500);

      expect(component.isPairPending(pair)).toBeFalse();
      expect(component.getPairError(pair)).toBe('No se pudo verificar el estado de la actualización en ML.');

      flush();
    }));
  });
});
