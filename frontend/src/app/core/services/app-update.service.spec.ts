import { TestBed } from '@angular/core/testing';
import { SwUpdate, VersionEvent } from '@angular/service-worker';
import { Subject } from 'rxjs';
import { AppUpdateService, UPDATE_AWAY_RELOAD_MS } from './app-update.service';

describe('AppUpdateService', () => {
  let versionUpdates: Subject<VersionEvent>;
  let unrecoverable: Subject<unknown>;
  let sw: jasmine.SpyObj<SwUpdate> & { isEnabled: boolean };
  let service: AppUpdateService;
  let reload: jasmine.Spy;
  let visibility: DocumentVisibilityState;

  const ready = () =>
    versionUpdates.next({
      type: 'VERSION_READY',
      currentVersion: { hash: 'a' },
      latestVersion: { hash: 'b' }
    });
  const setVisibility = (v: DocumentVisibilityState) => {
    visibility = v;
    document.dispatchEvent(new Event('visibilitychange'));
  };

  beforeEach(() => {
    versionUpdates = new Subject();
    unrecoverable = new Subject();
    sw = Object.assign(jasmine.createSpyObj<SwUpdate>('SwUpdate', ['checkForUpdate', 'activateUpdate']), {
      isEnabled: true,
      versionUpdates: versionUpdates.asObservable(),
      unrecoverable: unrecoverable.asObservable()
    }) as jasmine.SpyObj<SwUpdate> & { isEnabled: boolean };
    sw.checkForUpdate.and.resolveTo(false);
    sw.activateUpdate.and.resolveTo(true);
    visibility = 'visible';
    spyOnProperty(document, 'visibilityState', 'get').and.callFake(() => visibility);

    TestBed.configureTestingModule({ providers: [{ provide: SwUpdate, useValue: sw }] });
    service = TestBed.inject(AppUpdateService);
    reload = spyOn(service, 'reload');
  });

  it('sin service worker no hace nada', () => {
    sw.isEnabled = false;
    service.start();
    expect(sw.checkForUpdate).not.toHaveBeenCalled();
  });

  it('al arrancar busca una versión nueva', () => {
    service.start();
    expect(sw.checkForUpdate).toHaveBeenCalled();
  });

  it('si la app recién abre (sin tocar nada), recarga sola con la versión nueva', () => {
    service.start();
    ready();
    expect(reload).toHaveBeenCalled();
    expect(service.updateReady()).toBeFalse();
  });

  it('si la usuaria la está usando, avisa en vez de recargar', () => {
    service.start();
    window.dispatchEvent(new Event('pointerdown'));
    ready();
    expect(reload).not.toHaveBeenCalled();
    expect(service.updateReady()).toBeTrue();
  });

  it('con el aviso pendiente, volver después de un rato largo recarga sola', () => {
    service.start();
    window.dispatchEvent(new Event('pointerdown'));
    ready();
    const now = Date.now();
    const clock = spyOn(Date, 'now').and.returnValue(now);
    setVisibility('hidden');
    clock.and.returnValue(now + UPDATE_AWAY_RELOAD_MS + 1);
    setVisibility('visible');
    expect(reload).toHaveBeenCalled();
  });

  it('con el aviso pendiente, salir y volver enseguida NO recarga (no pierde lo que se estaba cargando)', () => {
    service.start();
    window.dispatchEvent(new Event('pointerdown'));
    ready();
    setVisibility('hidden');
    setVisibility('visible');
    expect(reload).not.toHaveBeenCalled();
    expect(service.updateReady()).toBeTrue();
  });

  it('volver a la app vuelve a buscar una versión nueva', () => {
    service.start();
    sw.checkForUpdate.calls.reset();
    setVisibility('hidden');
    setVisibility('visible');
    expect(sw.checkForUpdate).toHaveBeenCalled();
  });

  it('"Actualizar" activa la versión y recarga', async () => {
    await service.apply();
    expect(sw.activateUpdate).toHaveBeenCalled();
    expect(reload).toHaveBeenCalled();
  });

  it('una versión irrecuperable recarga', () => {
    service.start();
    unrecoverable.next({ type: 'UNRECOVERABLE_STATE', reason: 'x' });
    expect(reload).toHaveBeenCalled();
  });
});
