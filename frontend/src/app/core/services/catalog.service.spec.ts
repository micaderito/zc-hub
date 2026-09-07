import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { CatalogService } from './catalog.service';
import { ApiService } from './api.service';

describe('CatalogService', () => {
  let service: CatalogService;
  let httpMock: HttpTestingController;
  let base: string;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [CatalogService, provideHttpClient(), provideHttpClientTesting()]
    });
    service = TestBed.inject(CatalogService);
    httpMock = TestBed.inject(HttpTestingController);
    base = TestBed.inject(ApiService).baseUrl;
  });

  afterEach(() => httpMock.verify());

  it('getTiendaNubeCategories() pega a /products/categories/tiendanube', () => {
    service.getTiendaNubeCategories().then((r) => expect(r).toEqual([]));
    const req = httpMock.expectOne(`${base}/products/categories/tiendanube`);
    expect(req.request.method).toBe('GET');
    req.flush([]);
  });

  it('getMlRootCategories() pega a /products/categories/mercadolibre/roots', () => {
    service.getMlRootCategories().then((r) => expect(r).toEqual([]));
    const req = httpMock.expectOne(`${base}/products/categories/mercadolibre/roots`);
    expect(req.request.method).toBe('GET');
    req.flush([]);
  });

  it('getMlCategory() codifica el id en la URL', () => {
    service.getMlCategory('MLA388307').then((r) => expect(r.id).toBe('MLA388307'));
    const req = httpMock.expectOne(`${base}/products/categories/mercadolibre/MLA388307`);
    req.flush({ id: 'MLA388307', name: 'Cuadernos', path_from_root: [], children_categories: [], leaf: true, listing_allowed: true });
  });

  it('getMlCategoryAttributes() pega al sub-recurso /attributes', () => {
    service.getMlCategoryAttributes('MLA388307').then((r) => expect(r).toEqual([]));
    const req = httpMock.expectOne(`${base}/products/categories/mercadolibre/MLA388307/attributes`);
    req.flush([]);
  });

  it('predictMlCategory() manda el título en el query param q (codificado)', () => {
    service.predictMlCategory('cuaderno rayado').then((r) => expect(r).toEqual([]));
    const req = httpMock.expectOne(`${base}/products/categories/mercadolibre/predict?q=cuaderno%20rayado`);
    expect(req.request.method).toBe('GET');
    req.flush([]);
  });

  /* ---------- Borradores + publicación en background ---------- */

  it('listDrafts() GET /products/drafts', () => {
    service.listDrafts().then((r) => expect(r).toEqual([]));
    const req = httpMock.expectOne(`${base}/products/drafts`);
    expect(req.request.method).toBe('GET');
    req.flush([]);
  });

  it('createDraft() POST /products/drafts con { name, sku, draft }', () => {
    service.createDraft({ name: 'Cuaderno', sku: 'CUA-1', draft: { a: 1 } }).then((r) => expect(r.id).toBe('d1'));
    const req = httpMock.expectOne(`${base}/products/drafts`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ name: 'Cuaderno', sku: 'CUA-1', draft: { a: 1 } });
    req.flush({ id: 'd1' });
  });

  it('getDraft() GET /products/drafts/:id', () => {
    service.getDraft('d1').then((r) => expect(r.id).toBe('d1'));
    const req = httpMock.expectOne(`${base}/products/drafts/d1`);
    expect(req.request.method).toBe('GET');
    req.flush({ id: 'd1', draft: {}, jobs: [] });
  });

  it('updateDraft() PUT /products/drafts/:id', () => {
    service.updateDraft('d1', { draft: { a: 2 } }).then((r) => expect(r.ok).toBeTrue());
    const req = httpMock.expectOne(`${base}/products/drafts/d1`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ draft: { a: 2 } });
    req.flush({ ok: true });
  });

  it('deleteDraft() DELETE /products/drafts/:id', () => {
    service.deleteDraft('d1').then((r) => expect(r.ok).toBeTrue());
    const req = httpMock.expectOne(`${base}/products/drafts/d1`);
    expect(req.request.method).toBe('DELETE');
    req.flush({ ok: true });
  });

  it('publishDraft() POST /products/drafts/:id/publish con { payload, channels }', () => {
    service.publishDraft('d1', { ml: {}, tn: {} }, ['ml']).then((r) => expect(r.jobId).toBe('j1'));
    const req = httpMock.expectOne(`${base}/products/drafts/d1/publish`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ payload: { ml: {}, tn: {} }, channels: ['ml'] });
    req.flush({ jobId: 'j1' });
  });

  it('getPublishJob() GET /products/jobs/:id', () => {
    service.getPublishJob('j1').then((r) => expect(r.job.id).toBe('j1'));
    const req = httpMock.expectOne(`${base}/products/jobs/j1`);
    expect(req.request.method).toBe('GET');
    req.flush({ job: { id: 'j1' }, units: [] });
  });

  it('retryPublishJob() POST /products/jobs/:id/retry', () => {
    service.retryPublishJob('j1').then((r) => expect(r.ok).toBeTrue());
    const req = httpMock.expectOne(`${base}/products/jobs/j1/retry`);
    expect(req.request.method).toBe('POST');
    req.flush({ ok: true });
  });

  it('deletePublishJob() DELETE /products/jobs/:id', () => {
    service.deletePublishJob('j1').then((r) => expect(r.ok).toBeTrue());
    const req = httpMock.expectOne(`${base}/products/jobs/j1`);
    expect(req.request.method).toBe('DELETE');
    req.flush({ ok: true });
  });
});
