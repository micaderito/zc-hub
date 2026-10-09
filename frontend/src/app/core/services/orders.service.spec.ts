import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideTanStackQuery, QueryClient } from '@tanstack/angular-query-experimental';

import { ApiService } from './api.service';
import { CatalogUnit, OrdersService, computeOrderTotals, lineFromCatalogUnit, lineKey, orderStatusLabel } from './orders.service';

const unit = (over: Partial<CatalogUnit> = {}): CatalogUnit => ({
  key: 'pack:1', kind: 'pack', packId: 1, sku: null, name: 'Cuadernos', code: '4410', description: 'CUADERNO X8',
  unitsPerPack: 8, mode: 'assorted', price: 96000, members: [], alerted: true, suggestedQty: 2, depositoStock: null,
  lastOrder: null, pendingOrder: null, ...over,
});

describe('OrdersService', () => {
  let service: OrdersService;
  let httpMock: HttpTestingController;
  let base: string;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [OrdersService, provideHttpClient(), provideHttpClientTesting(), provideTanStackQuery(new QueryClient())],
    });
    service = TestBed.inject(OrdersService);
    httpMock = TestBed.inject(HttpTestingController);
    base = `${TestBed.inject(ApiService).baseUrl}/orders`;
  });

  afterEach(() => httpMock.verify());

  it('list() filtra por estado con ?status=', () => {
    service.list('pendiente');
    const req = httpMock.expectOne(`${base}?status=pendiente`);
    expect(req.request.method).toBe('GET');
    req.flush({ orders: [] });
  });

  it('saveDraft() manda el borrador entero por PUT', async () => {
    const p = service.saveDraft(5, { name: 'X', note: '', discount1: 25, discount2: 5, lines: [] });
    const req = httpMock.expectOne(`${base}/5`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body.discount1).toBe(25);
    req.flush({ order: { id: 5 } });
    expect((await p).id).toBe(5);
  });

  it('receive() manda lo anotado y si se cierra', () => {
    service.receive(3, { 10: 2, 11: null }, true);
    const req = httpMock.expectOne(`${base}/3/receive`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ received: { 10: 2, 11: null }, close: true });
    req.flush({ order: { id: 3 } });
  });

  it('duplicate() pasa modo y estado', () => {
    service.duplicate(3, { mode: 'missing' });
    const req = httpMock.expectOne(`${base}/3/duplicate`);
    expect(req.request.body).toEqual({ mode: 'missing' });
    req.flush({ order: { id: 4 } });
  });
});

describe('helpers de pedidos', () => {
  it('computeOrderTotals: 25% sobre los productos y 5% sobre el total; sin precio no suma', () => {
    const t = computeOrderTotals({
      discount1: 25, discount2: 5,
      lines: [
        lineFromCatalogUnit(unit(), 2),
        { ...lineFromCatalogUnit(unit({ key: 'pack:2', packId: 2, price: 42000 }), 1) },
        { ...lineFromCatalogUnit(unit({ key: 'pack:3', packId: 3, price: null }), 3) },
      ],
    });
    expect(t.subtotal).toBe(234000);
    expect(t.discount1Amount).toBe(58500);
    expect(t.discount2Amount).toBe(8775);
    expect(t.total).toBe(166725);
    expect(t.missingPrices).toBe(1);
    expect(t.packs).toBe(6);
  });

  it('lineFromCatalogUnit: copia código/descr./precio y marca el origen según la alerta', () => {
    const l = lineFromCatalogUnit(unit(), 2);
    expect(l).toEqual(jasmine.objectContaining({ kind: 'pack', packId: 1, code: '4410', description: 'CUADERNO X8', unitPrice: 96000, priceSource: 'precios', origin: 'alerta', qty: 2 }));
    expect(lineFromCatalogUnit(unit({ alerted: false, code: null }), 1)).toEqual(jasmine.objectContaining({ origin: 'manual', code: '' }));
  });

  it('lineKey / orderStatusLabel', () => {
    expect(lineKey({ kind: 'pack', packId: 7, sku: null })).toBe('pack:7');
    expect(lineKey({ kind: 'sku', packId: null, sku: 'LG' })).toBe('sku:LG');
    expect(lineKey({ kind: 'free', packId: null, sku: null })).toBeNull();
    expect(orderStatusLabel({ status: 'recibido', partial: true })).toBe('Recibido incompleto');
    expect(orderStatusLabel({ status: 'pendiente', partial: false })).toBe('Pendiente');
  });
});
