import { TestBed } from '@angular/core/testing';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { AuthService, AuthStatus } from './auth.service';
import { ApiService } from './api.service';

describe('AuthService', () => {
  let service: AuthService;
  let httpMock: HttpTestingController;
  const baseUrl = 'http://localhost:4000/api';

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()]
    });
    service = TestBed.inject(AuthService);
    httpMock = TestBed.inject(HttpTestingController);
    expect(TestBed.inject(ApiService).baseUrl).toBe(baseUrl);
  });

  afterEach(() => httpMock.verify());

  it('getStatus() hace GET a /auth/status y devuelve el estado de ambos canales', () => {
    const fixture: AuthStatus = { mercadolibre: true, tiendanube: false };
    service.getStatus().subscribe(res => expect(res).toEqual(fixture));

    const req = httpMock.expectOne(`${baseUrl}/auth/status`);
    expect(req.request.method).toBe('GET');
    req.flush(fixture);
  });

  it('getMercadoLibreAuthUrl() hace GET a /auth/mercadolibre/url', () => {
    service.getMercadoLibreAuthUrl().subscribe(res => expect(res.url).toBe('https://ml.example/auth'));

    const req = httpMock.expectOne(`${baseUrl}/auth/mercadolibre/url`);
    expect(req.request.method).toBe('GET');
    req.flush({ url: 'https://ml.example/auth' });
  });

  it('disconnectMercadoLibre() hace POST a /auth/mercadolibre/disconnect', () => {
    service.disconnectMercadoLibre().subscribe(res => expect(res.ok).toBeTrue());

    const req = httpMock.expectOne(`${baseUrl}/auth/mercadolibre/disconnect`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({});
    req.flush({ ok: true });
  });

  it('getTiendaNubeAuthUrl() hace GET a /auth/tiendanube/url', () => {
    service.getTiendaNubeAuthUrl().subscribe(res => expect(res.url).toBe('https://tn.example/auth'));

    const req = httpMock.expectOne(`${baseUrl}/auth/tiendanube/url`);
    expect(req.request.method).toBe('GET');
    req.flush({ url: 'https://tn.example/auth' });
  });

  it('disconnectTiendaNube() hace POST a /auth/tiendanube/disconnect', () => {
    service.disconnectTiendaNube().subscribe(res => expect(res.ok).toBeTrue());

    const req = httpMock.expectOne(`${baseUrl}/auth/tiendanube/disconnect`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({});
    req.flush({ ok: true });
  });
});
