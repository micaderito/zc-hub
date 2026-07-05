import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { errorInterceptor } from './error.interceptor';
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

  it('muestra un mensaje específico cuando el status es 0 (sin conexión)', () => {
    http.get('/fail').subscribe({ error: () => {} });
    httpMock.expectOne('/fail').error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });
    expect(globalError.message()).toBe('No se pudo conectar. ¿Está corriendo el backend?');
  });

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
