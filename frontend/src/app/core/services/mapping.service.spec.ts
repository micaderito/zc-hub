import { TestBed } from '@angular/core/testing';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { MappingService, MappingEntry, MlSourceItem, TnSourceProduct } from './mapping.service';

describe('MappingService', () => {
  let service: MappingService;
  let httpMock: HttpTestingController;
  const baseUrl = 'http://localhost:4000/api';

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()]
    });
    service = TestBed.inject(MappingService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('getAll() hace GET a /mapping', () => {
    const fixture: MappingEntry[] = [
      { sku: 'ABC-1', mercadolibre: null, tiendanube: null, priceML: 100, priceTN: 120 }
    ];
    service.getAll().subscribe(res => expect(res).toEqual(fixture));

    const req = httpMock.expectOne(`${baseUrl}/mapping`);
    expect(req.request.method).toBe('GET');
    req.flush(fixture);
  });

  it('create() hace POST a /mapping con el entry', () => {
    const entry: Partial<MappingEntry> = { sku: 'ABC-1', priceML: 100 };
    service.create(entry).subscribe(res => expect(res).toEqual({ ok: true, sku: 'ABC-1' }));

    const req = httpMock.expectOne(`${baseUrl}/mapping`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual(entry);
    req.flush({ ok: true, sku: 'ABC-1' });
  });

  it('update() hace PUT a /mapping/:sku codificando el SKU en la URL', () => {
    const entry: Partial<MappingEntry> = { priceML: 150 };
    service.update('ABC/1', entry).subscribe(res => expect(res.ok).toBeTrue());

    const req = httpMock.expectOne(`${baseUrl}/mapping/ABC%2F1`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual(entry);
    req.flush({ ok: true });
  });

  it('delete() hace DELETE a /mapping/:sku codificando el SKU en la URL', () => {
    service.delete('ABC 1').subscribe(res => expect(res.ok).toBeTrue());

    const req = httpMock.expectOne(`${baseUrl}/mapping/ABC%201`);
    expect(req.request.method).toBe('DELETE');
    req.flush({ ok: true });
  });

  it('getMercadoLibreSources() hace GET a /mapping/sources/mercadolibre', () => {
    const fixture: MlSourceItem[] = [{ id: 'MLA1', title: 'Cuaderno', sku: null, variations: [] }];
    service.getMercadoLibreSources().subscribe(res => expect(res).toEqual(fixture));

    const req = httpMock.expectOne(`${baseUrl}/mapping/sources/mercadolibre`);
    expect(req.request.method).toBe('GET');
    req.flush(fixture);
  });

  it('getTiendaNubeSources() hace GET a /mapping/sources/tiendanube', () => {
    const fixture: TnSourceProduct[] = [{ id: 1, name: 'Cuaderno', variants: [] }];
    service.getTiendaNubeSources().subscribe(res => expect(res).toEqual(fixture));

    const req = httpMock.expectOne(`${baseUrl}/mapping/sources/tiendanube`);
    expect(req.request.method).toBe('GET');
    req.flush(fixture);
  });
});
