import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApiService } from './api.service';
import { HubProductsService } from './hub-products.service';

describe('HubProductsService', () => {
  let service: HubProductsService;
  let http: HttpTestingController;
  let base: string;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(HubProductsService);
    http = TestBed.inject(HttpTestingController);
    base = TestBed.inject(ApiService).baseUrl;
  });

  afterEach(() => http.verify());

  it('list() manda búsqueda, estado, paginación y refresh', async () => {
    const p = service.list({ search: 'rivadavia', status: 'orphan', limit: 30, offset: 60, refresh: true });
    const req = http.expectOne((r) => r.url === `${base}/hub-products`);
    expect(req.request.params.get('search')).toBe('rivadavia');
    expect(req.request.params.get('status')).toBe('orphan');
    expect(req.request.params.get('offset')).toBe('60');
    expect(req.request.params.get('refresh')).toBe('1');
    req.flush({ rows: [], total: 0, counts: {}, mlConnected: true, tnConnected: true, at: null });
    expect((await p).total).toBe(0);
  });

  it('get() codifica el id del grupo (lleva ":")', async () => {
    const p = service.get('ml:MLA1');
    http.expectOne(`${base}/hub-products/ml%3AMLA1`).flush({ key: 'ml:MLA1' });
    expect((await p).key).toBe('ml:MLA1');
  });

  it('linkCandidates() y link() pegan a sus endpoints', async () => {
    const c = service.linkCandidates('tn', 'monob');
    const req = http.expectOne((r) => r.url === `${base}/hub-products/link-candidates`);
    expect(req.request.params.get('channel')).toBe('tn');
    expect(req.request.params.get('search')).toBe('monob');
    req.flush([]);
    await c;

    const body = { sku: 'X', ml: { itemId: 'MLA1', variationId: '2' }, tn: { productId: 7, variantId: 71 } };
    const l = service.link(body);
    const post = http.expectOne(`${base}/hub-products/link`);
    expect(post.request.method).toBe('POST');
    expect(post.request.body).toEqual(body);
    post.flush({ ok: true, sku: 'X', pendingMl: false });
    expect((await l).ok).toBeTrue();
  });
});
