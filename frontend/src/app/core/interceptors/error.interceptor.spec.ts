import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { errorInterceptor, NETWORK_RETRY_DELAYS_MS } from './error.interceptor';
import { GlobalErrorService } from '../services/global-error.service';

describe('errorInterceptor', () => {
  let http: HttpClient;
  let httpMock: HttpTestingController;
  let globalError: GlobalErrorService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting()
      ]
    });
    http = TestBed.inject(HttpClient);
    httpMock = TestBed.inject(HttpTestingController);
    globalError = TestBed.inject(GlobalErrorService);
  });

  afterEach(() => httpMock.verify());

  it('deja pasar las respuestas exitosas sin tocar el error global', () => {
    http.get('/ok').subscribe(res => expect(res).toEqual({ ok: true }));
    httpMock.expectOne('/ok').flush({ ok: true });
    expect(globalError.message()).toBeNull();
  });

  it('usa el string de error del body cuando err.error es un string', () => {
    http.get('/fail').subscribe({ error: () => {} });
    httpMock.expectOne('/fail').flush('mensaje plano', { status: 400, statusText: 'Bad Request' });
    expect(globalError.message()).toBe('mensaje plano');
  });

  it('usa body.error cuando el body es un objeto con esa propiedad', () => {
    http.get('/fail').subscribe({ error: () => {} });
    httpMock.expectOne('/fail').flush({ error: 'no encontrado' }, { status: 404, statusText: 'Not Found' });
    expect(globalError.message()).toBe('no encontrado');
  });

  it('usa body.message cuando el body no tiene "error" pero sí "message"', () => {
    http.get('/fail').subscribe({ error: () => {} });
    httpMock.expectOne('/fail').flush({ message: 'algo salió mal' }, { status: 500, statusText: 'Server Error' });
    expect(globalError.message()).toBe('algo salió mal');
  });

  describe('status 0 (falla de red)', () => {
    const networkError = (url: string) =>
      httpMock.expectOne(url).error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });

    it('en un GET reintenta 3 veces con espera creciente y recién ahí muestra el cartel', fakeAsync(() => {
      let caught: unknown = null;
      http.get('/fail').subscribe({ error: (e) => (caught = e) });

      networkError('/fail');
      expect(globalError.message()).toBeNull();
      tick(NETWORK_RETRY_DELAYS_MS[0]);
      networkError('/fail');
      tick(NETWORK_RETRY_DELAYS_MS[1]);
      networkError('/fail');
      tick(NETWORK_RETRY_DELAYS_MS[2]);
      expect(globalError.message()).toBeNull();
      expect(caught).toBeNull();

      networkError('/fail');
      expect(globalError.message()).toBe('No se pudo conectar con el servidor. Revisá tu conexión a internet.');
      expect(caught).toBeTruthy();
    }));

    it('en un GET no muestra nada si un reintento sale bien', fakeAsync(() => {
      let res: unknown = null;
      http.get('/flaky').subscribe(r => (res = r));

      networkError('/flaky');
      tick(NETWORK_RETRY_DELAYS_MS[0]);
      httpMock.expectOne('/flaky').flush({ ok: true });

      expect(res).toEqual({ ok: true });
      expect(globalError.message()).toBeNull();
    }));

    it('en un POST no reintenta (podría duplicar una escritura) y muestra el cartel enseguida', fakeAsync(() => {
      http.post('/write', {}).subscribe({ error: () => {} });
      networkError('/write');
      expect(globalError.message()).toBe('No se pudo conectar con el servidor. Revisá tu conexión a internet.');
      tick(10_000);
      httpMock.expectNone('/write');
    }));
  });

  it('no reintenta errores HTTP con status (un 500 no es un corte de red)', fakeAsync(() => {
    http.get('/fail').subscribe({ error: () => {} });
    httpMock.expectOne('/fail').flush({ error: 'boom' }, { status: 500, statusText: 'Server Error' });
    expect(globalError.message()).toBe('boom');
    tick(10_000);
    httpMock.expectNone('/fail');
  }));

  it('arma un mensaje genérico con status y statusText cuando no hay body ni message útil', () => {
    http.get('/fail').subscribe({ error: () => {} });
    httpMock.expectOne('/fail').flush(null, { status: 503, statusText: 'Service Unavailable' });
    expect(globalError.message()).toBe('Error 503: Service Unavailable');
  });

  it('re-lanza el error para que el caller original también pueda manejarlo', () => {
    let caught: unknown = null;
    http.get('/fail').subscribe({ error: (e) => (caught = e) });
    httpMock.expectOne('/fail').flush({ error: 'boom' }, { status: 400, statusText: 'Bad Request' });
    expect(caught).toBeTruthy();
  });
});
