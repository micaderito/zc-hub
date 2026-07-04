import { TestBed } from '@angular/core/testing';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { SyncService } from './sync.service';

describe('SyncService', () => {
  let service: SyncService;
  let httpMock: HttpTestingController;
  const baseUrl = 'http://localhost:4000/api';

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()]
    });
    service = TestBed.inject(SyncService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('getConfig() hace GET a /sync/config', () => {
    service.getConfig().subscribe(res => expect(res).toEqual({ enabled: true, hasDatabase: true }));
    const req = httpMock.expectOne(`${baseUrl}/sync/config`);
    expect(req.request.method).toBe('GET');
    req.flush({ enabled: true, hasDatabase: true });
  });

  it('setSyncEnabled() hace PATCH a /sync/config con el flag', () => {
    service.setSyncEnabled(false).subscribe(res => expect(res.enabled).toBeFalse());
    const req = httpMock.expectOne(`${baseUrl}/sync/config`);
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ enabled: false });
    req.flush({ enabled: false });
  });

  it('getAudit() usa los defaults de paginación cuando no se pasan argumentos', () => {
    service.getAudit().subscribe(res => expect(res.total).toBe(0));
    const req = httpMock.expectOne(
      r => r.url === `${baseUrl}/sync/audit` && r.params.get('limit') === '100' && r.params.get('offset') === '0'
    );
    expect(req.request.params.has('orderId')).toBeFalse();
    req.flush({ rows: [], total: 0 });
  });

  it('getAudit() manda orderId recortado solo si no está vacío', () => {
    service.getAudit(50, 10, '  ORD-1  ').subscribe();
    const req = httpMock.expectOne(
      r => r.url === `${baseUrl}/sync/audit` && r.params.get('orderId') === 'ORD-1'
    );
    expect(req.request.params.get('limit')).toBe('50');
    expect(req.request.params.get('offset')).toBe('10');
    req.flush({ rows: [], total: 0 });
  });

  it('getAudit() no manda orderId cuando es solo espacios', () => {
    service.getAudit(10, 0, '   ').subscribe();
    const req = httpMock.expectOne(r => r.url === `${baseUrl}/sync/audit`);
    expect(req.request.params.has('orderId')).toBeFalse();
    req.flush({ rows: [], total: 0 });
  });

  it('revertAudit() hace POST a /sync/audit/:id/revert', () => {
    service.revertAudit(7).subscribe(res => expect(res.ok).toBeTrue());
    const req = httpMock.expectOne(`${baseUrl}/sync/audit/7/revert`);
    expect(req.request.method).toBe('POST');
    req.flush({ ok: true });
  });

  it('reprocessOrder() recorta el orderId antes de mandarlo', () => {
    service.reprocessOrder('  ORD-9  ').subscribe(res => expect(res.itemsSynced).toBe(2));
    const req = httpMock.expectOne(`${baseUrl}/sync/reprocess-order`);
    expect(req.request.body).toEqual({ orderId: 'ORD-9' });
    req.flush({ ok: true, orderId: 'ORD-9', itemsSynced: 2 });
  });

  it('syncAllPrices() hace POST a /sync/prices sin body', () => {
    service.syncAllPrices().subscribe(res => expect(res['SKU-1'].ml).toBeTrue());
    const req = httpMock.expectOne(`${baseUrl}/sync/prices`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({});
    req.flush({ 'SKU-1': { ml: true, tn: true } });
  });

  it('syncPricesForSku() codifica el sku en la URL', () => {
    service.syncPricesForSku('SKU/1').subscribe(res => expect(res.ml).toBeTrue());
    const req = httpMock.expectOne(`${baseUrl}/sync/prices/SKU%2F1`);
    expect(req.request.method).toBe('POST');
    req.flush({ ml: true, tn: true });
  });

  it('getReturns() usa los defaults de paginación', () => {
    service.getReturns().subscribe(res => expect(res.total).toBe(0));
    const req = httpMock.expectOne(
      r => r.url === `${baseUrl}/sync/returns` && r.params.get('limit') === '20' && r.params.get('offset') === '0'
    );
    req.flush({ rows: [], total: 0 });
  });

  it('fetchReturnsFromMl() hace POST a /sync/returns/fetch', () => {
    service.fetchReturnsFromMl().subscribe(res => expect(res.created).toBe(3));
    const req = httpMock.expectOne(`${baseUrl}/sync/returns/fetch`);
    expect(req.request.method).toBe('POST');
    req.flush({ ok: true, claimsChecked: 5, created: 3, skipped: 2 });
  });

  it('addReturnsFromOrder() manda el orderId en el body', () => {
    service.addReturnsFromOrder('ORD-5').subscribe(res => expect(res.created).toBe(1));
    const req = httpMock.expectOne(`${baseUrl}/sync/returns`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ orderId: 'ORD-5' });
    req.flush({ created: 1, rows: [] });
  });

  it('approveReturn() hace POST a /sync/returns/:id/approve', () => {
    service.approveReturn(3).subscribe(res => expect(res.mlRestored).toBeTrue());
    const req = httpMock.expectOne(`${baseUrl}/sync/returns/3/approve`);
    expect(req.request.method).toBe('POST');
    req.flush({ ok: true, mlRestored: true, tnRestored: false });
  });

  it('getPendingTasks() usa los defaults de paginación', () => {
    service.getPendingTasks().subscribe(res => expect(res.total).toBe(0));
    const req = httpMock.expectOne(
      r => r.url === `${baseUrl}/sync/pending-tasks` && r.params.get('limit') === '20' && r.params.get('offset') === '0'
    );
    req.flush({ tasks: [], total: 0, activeCount: 0, failedCount: 0 });
  });

  it('retryTask() hace POST a /sync/pending-tasks/:id/retry', () => {
    service.retryTask(9).subscribe(res => expect(res.ok).toBeTrue());
    const req = httpMock.expectOne(`${baseUrl}/sync/pending-tasks/9/retry`);
    expect(req.request.method).toBe('POST');
    req.flush({ ok: true });
  });

  it('registerWebhooks() hace POST a /sync/register-webhooks', () => {
    service.registerWebhooks().subscribe(res => expect(res.registered).toBe(4));
    const req = httpMock.expectOne(`${baseUrl}/sync/register-webhooks`);
    expect(req.request.method).toBe('POST');
    req.flush({ ok: true, registered: 4, created: [] });
  });
});
