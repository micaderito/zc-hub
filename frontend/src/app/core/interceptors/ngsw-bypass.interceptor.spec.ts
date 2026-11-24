import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ngswBypassInterceptor } from './ngsw-bypass.interceptor';
import { ApiService } from '../services/api.service';

describe('ngswBypassInterceptor', () => {
  let http: HttpClient;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([ngswBypassInterceptor])),
        provideHttpClientTesting(),
        { provide: ApiService, useValue: { baseUrl: 'https://api.test/api' } },
      ],
    });
    http = TestBed.inject(HttpClient);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('a los pedidos a la API les pone ngsw-bypass', () => {
    http.get('https://api.test/api/dispatch').subscribe();
    const req = httpMock.expectOne('https://api.test/api/dispatch');
    expect(req.request.headers.get('ngsw-bypass')).toBe('true');
    req.flush({});
  });

  it('a otras URLs no', () => {
    http.get('https://otro.test/archivo.json').subscribe();
    const req = httpMock.expectOne('https://otro.test/archivo.json');
    expect(req.request.headers.has('ngsw-bypass')).toBeFalse();
    req.flush({});
  });
});
