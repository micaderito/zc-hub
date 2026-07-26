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
});
