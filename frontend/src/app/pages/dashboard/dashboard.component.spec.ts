import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, NavigationEnd } from '@angular/router';
import { of, throwError, Subject } from 'rxjs';
import { DashboardComponent } from './dashboard.component';
import { AuthService, AuthStatus } from '../../core/services/auth.service';
import { SyncService } from '../../core/services/sync.service';

/** Fake mínimo de Router: expone solo lo que el componente usa (events, url, parseUrl, navigate). */
function makeRouterSpy(initialUrl: string) {
  const events = new Subject<unknown>();
  return {
    url: initialUrl,
    events,
    parseUrl: (url: string) => {
      const qIndex = url.indexOf('?');
      const query = qIndex >= 0 ? url.substring(qIndex + 1) : '';
      const search = new URLSearchParams(query);
      const queryParams: Record<string, string> = {};
      search.forEach((v, k) => (queryParams[k] = v));
      return { queryParams };
    },
    navigate: jasmine.createSpy('navigate'),
  };
}

describe('DashboardComponent', () => {
  let fixture: ComponentFixture<DashboardComponent>;
  let component: DashboardComponent;
  let authSpy: jasmine.SpyObj<AuthService>;
  let syncSpy: jasmine.SpyObj<SyncService>;
  let routerSpy: ReturnType<typeof makeRouterSpy>;

  const okStatus: AuthStatus = { mercadolibre: true, tiendanube: true };

  // Nota: `connectML()`/`connectTN()` (y por extensión `reconnectML()`/`reconnectTN()` cuando
  // la desconexión previa funciona) terminan asignando `window.location.href = r.url`. En este
  // Chrome Headless esa propiedad no es configurable (ni la instancia ni el prototipo de
  // Location), así que no se puede espiar, y ni siquiera asignar un fragmento (#...) evita que
  // Karma detecte una "navegación"/recarga y aborte el run. Por eso estos tests solo cubren los
  // casos de error de esos métodos (que no llegan a esa línea); la línea de redirección exitosa
  // queda sin cobertura de test unitario en este entorno.

  function setup(url = '/', status: AuthStatus = okStatus) {
    authSpy = jasmine.createSpyObj<AuthService>('AuthService', [
      'getStatus',
      'getMercadoLibreAuthUrl',
      'disconnectMercadoLibre',
      'getTiendaNubeAuthUrl',
      'disconnectTiendaNube',
    ]);
    authSpy.getStatus.and.returnValue(of(status));

    syncSpy = jasmine.createSpyObj<SyncService>('SyncService', ['syncAllPrices']);

    routerSpy = makeRouterSpy(url);

    TestBed.configureTestingModule({
      imports: [DashboardComponent],
      providers: [
        { provide: AuthService, useValue: authSpy },
        { provide: SyncService, useValue: syncSpy },
        { provide: Router, useValue: routerSpy },
      ],
    });

    fixture = TestBed.createComponent(DashboardComponent);
    component = fixture.componentInstance;
  }

  describe('carga inicial', () => {
    it('carga el estado exitosamente y apaga el loading', () => {
      setup('/', okStatus);
      fixture.detectChanges();

      expect(component.loading).toBeFalse();
      expect(component.status).toEqual(okStatus);
      expect(component.error).toBeNull();
      expect(authSpy.getStatus).toHaveBeenCalled();
    });

    it('si falla la carga del estado, muestra un error y apaga el loading', () => {
      setup();
      authSpy.getStatus.and.returnValue(throwError(() => new Error('network down')));
      fixture.detectChanges();

      expect(component.loading).toBeFalse();
      expect(component.status).toBeNull();
      expect(component.error).toContain('No se pudo conectar con el backend');
    });
  });

  describe('query params en ngOnInit', () => {
    it('setea error de ML cuando la URL trae ml_error', () => {
      setup('/?ml_error=access_denied');
      fixture.detectChanges();

      expect(component.error).toBe('Mercado Libre: access_denied');
    });

    it('setea error de TN cuando la URL trae tn_error', () => {
      setup('/?tn_error=invalid_scope');
      fixture.detectChanges();

      expect(component.error).toBe('Tienda Nube: invalid_scope');
    });

    it('actualiza el error de ML en cualquier evento de router posterior si la URL trae ml_error', () => {
      setup('/');
      routerSpy.url = '/?ml_error=access_denied';
      fixture.detectChanges();

      routerSpy.events.next({});

      expect(component.error).toBe('ML: access_denied');
    });

    it('actualiza el error de TN en cualquier evento de router posterior si la URL trae tn_error', () => {
      setup('/');
      routerSpy.url = '/?tn_error=invalid_scope';
      fixture.detectChanges();

      routerSpy.events.next({});

      expect(component.error).toBe('TN: invalid_scope');
    });

    it('cuando la URL trae ml_connected, limpia los query params y recarga el estado', () => {
      setup('/?ml_connected=1');
      fixture.detectChanges();

      expect(routerSpy.navigate).toHaveBeenCalledWith([], { queryParams: {}, replaceUrl: true });
      // loadStatus() se llama una vez desde checkQueryParams() y otra desde ngOnInit()
      expect(authSpy.getStatus).toHaveBeenCalledTimes(2);
    });

    it('cuando la URL trae tn_connected, limpia los query params y recarga el estado', () => {
      setup('/?tn_connected=1');
      fixture.detectChanges();

      expect(routerSpy.navigate).toHaveBeenCalledWith([], { queryParams: {}, replaceUrl: true });
      expect(authSpy.getStatus).toHaveBeenCalledTimes(2);
    });

    it('recarga el estado cuando llega una NavigationEnd hacia "/"', () => {
      setup('/');
      fixture.detectChanges();
      expect(authSpy.getStatus).toHaveBeenCalledTimes(1);

      routerSpy.events.next(new NavigationEnd(1, '/', '/'));

      expect(authSpy.getStatus).toHaveBeenCalledTimes(2);
    });

    it('no recarga el estado ante una NavigationEnd hacia otra ruta', () => {
      setup('/otra-ruta');
      routerSpy.url = '/otra-ruta';
      fixture.detectChanges();
      expect(authSpy.getStatus).toHaveBeenCalledTimes(1);

      routerSpy.events.next(new NavigationEnd(1, '/otra-ruta', '/otra-ruta'));

      expect(authSpy.getStatus).toHaveBeenCalledTimes(1);
    });
  });

  describe('ngOnDestroy', () => {
    it('deja de escuchar router.events tras destruir el componente', () => {
      setup('/');
      fixture.detectChanges();
      expect(authSpy.getStatus).toHaveBeenCalledTimes(1);

      fixture.destroy();
      routerSpy.events.next(new NavigationEnd(1, '/', '/'));

      expect(authSpy.getStatus).toHaveBeenCalledTimes(1);
    });
  });

  describe('conectar Mercado Libre', () => {
    it('setea error cuando conectML() falla', () => {
      setup();
      fixture.detectChanges();
      authSpy.getMercadoLibreAuthUrl.and.returnValue(throwError(() => ({ error: { error: 'boom' } })));

      component.connectML();

      expect(component.error).toBe('boom');
    });

    it('usa el mensaje genérico cuando el error no trae error.error', () => {
      setup();
      fixture.detectChanges();
      authSpy.getMercadoLibreAuthUrl.and.returnValue(throwError(() => ({ message: 'falló la red' })));

      component.connectML();

      expect(component.error).toBe('falló la red');
    });
  });

  describe('reconectar Mercado Libre', () => {
    it('setea error y no intenta reconectar si falla la desconexión', () => {
      setup();
      fixture.detectChanges();
      authSpy.disconnectMercadoLibre.and.returnValue(throwError(() => ({ error: { error: 'no se pudo desconectar' } })));

      component.reconnectML();

      expect(component.error).toBe('no se pudo desconectar');
      expect(authSpy.getMercadoLibreAuthUrl).not.toHaveBeenCalled();
    });
  });

  describe('conectar y reconectar Tienda Nube', () => {
    it('setea error cuando conectTN() falla', () => {
      setup();
      fixture.detectChanges();
      authSpy.getTiendaNubeAuthUrl.and.returnValue(throwError(() => ({ error: { error: 'tn error' } })));

      component.connectTN();

      expect(component.error).toBe('tn error');
    });

    it('setea error y no intenta reconectar si falla la desconexión de TN', () => {
      setup();
      fixture.detectChanges();
      authSpy.disconnectTiendaNube.and.returnValue(throwError(() => ({ message: 'sin conexión' })));

      component.reconnectTN();

      expect(component.error).toBe('sin conexión');
      expect(authSpy.getTiendaNubeAuthUrl).not.toHaveBeenCalled();
    });
  });

  describe('desconectar canales', () => {
    it('disconnectML() recarga el estado al terminar con éxito', () => {
      setup();
      fixture.detectChanges();
      authSpy.disconnectMercadoLibre.and.returnValue(of({ ok: true }));
      authSpy.getStatus.and.returnValue(of({ mercadolibre: false, tiendanube: true }));

      component.disconnectML();

      expect(component.disconnectingML).toBeFalse();
      expect(component.status).toEqual({ mercadolibre: false, tiendanube: true });
    });

    it('disconnectML() setea error y apaga el flag si falla', () => {
      setup();
      fixture.detectChanges();
      authSpy.disconnectMercadoLibre.and.returnValue(throwError(() => ({ error: { error: 'no se pudo' } })));

      component.disconnectML();

      expect(component.disconnectingML).toBeFalse();
      expect(component.error).toBe('no se pudo');
    });

    it('disconnectTN() recarga el estado al terminar con éxito', () => {
      setup();
      fixture.detectChanges();
      authSpy.disconnectTiendaNube.and.returnValue(of({ ok: true }));
      authSpy.getStatus.and.returnValue(of({ mercadolibre: true, tiendanube: false }));

      component.disconnectTN();

      expect(component.disconnectingTN).toBeFalse();
      expect(component.status).toEqual({ mercadolibre: true, tiendanube: false });
    });

    it('disconnectTN() setea error y apaga el flag si falla', () => {
      setup();
      fixture.detectChanges();
      authSpy.disconnectTiendaNube.and.returnValue(throwError(() => ({ error: { error: 'error tn' } })));

      component.disconnectTN();

      expect(component.disconnectingTN).toBeFalse();
      expect(component.error).toBe('error tn');
    });
  });

  describe('syncAllPrices', () => {
    it('bloquea la sincronización si falta conectar algún canal', () => {
      setup('/', { mercadolibre: true, tiendanube: false });
      fixture.detectChanges();

      component.syncAllPrices();

      expect(component.error).toBe('Conecta ambos canales antes de sincronizar precios.');
      expect(syncSpy.syncAllPrices).not.toHaveBeenCalled();
    });

    it('sincroniza los precios de todos los SKU cuando ambos canales están conectados', () => {
      setup('/', okStatus);
      fixture.detectChanges();
      const result = { 'SKU-1': { ml: true, tn: true }, 'SKU-2': { ml: true, tn: false } };
      syncSpy.syncAllPrices.and.returnValue(of(result));

      component.syncAllPrices();

      expect(component.syncing).toBeFalse();
      expect(component.syncResult).toEqual(result as never);
    });

    it('setea error y apaga syncing si falla la sincronización', () => {
      setup('/', okStatus);
      fixture.detectChanges();
      syncSpy.syncAllPrices.and.returnValue(throwError(() => ({ error: { error: 'fallo de sync' } })));

      component.syncAllPrices();

      expect(component.syncing).toBeFalse();
      expect(component.error).toBe('fallo de sync');
    });
  });
});
