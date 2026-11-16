import { TestBed, fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideTanStackQuery, QueryClient } from '@tanstack/angular-query-experimental';
import { SalesService } from './sales.service';
import { ApiService } from './api.service';

describe('SalesService.exportCsv', () => {
  let svc: SalesService;
  let http: HttpTestingController;
  let nav: { canShare?: unknown; share?: unknown };
  let saved: { canShare: PropertyDescriptor | undefined; share: PropertyDescriptor | undefined };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTanStackQuery(new QueryClient()),
        { provide: ApiService, useValue: { baseUrl: '/api' } },
      ],
    });
    svc = TestBed.inject(SalesService);
    http = TestBed.inject(HttpTestingController);
    nav = navigator as unknown as { canShare?: unknown; share?: unknown };
    saved = {
      canShare: Object.getOwnPropertyDescriptor(navigator, 'canShare'),
      share: Object.getOwnPropertyDescriptor(navigator, 'share'),
    };
  });

  afterEach(() => {
    for (const k of ['canShare', 'share'] as const) {
      const d = saved[k];
      if (d) Object.defineProperty(navigator, k, d);
      else delete (navigator as unknown as Record<string, unknown>)[k];
    }
    http.verify();
  });

  function setNav(k: 'canShare' | 'share', v: unknown) {
    Object.defineProperty(navigator, k, { value: v, configurable: true, writable: true });
  }

  function answer() {
    http.expectOne((r) => r.url === '/api/sales/export').flush(new Blob(['a;b'], { type: 'text/csv' }));
  }

  it('si el sistema puede compartir archivos, abre la hoja de compartir con el CSV', async () => {
    const share = jasmine.createSpy('share').and.resolveTo(undefined);
    setNav('canShare', () => true);
    setNav('share', share);
    const click = spyOn(HTMLAnchorElement.prototype, 'click');
    const p = svc.exportCsv('2026-10-01', '2026-10-31');
    answer();
    await p;
    expect(share).toHaveBeenCalledTimes(1);
    const file = share.calls.mostRecent().args[0].files[0] as File;
    expect(file.name).toBe('ventas_2026-10-01_2026-10-31.csv');
    expect(click).not.toHaveBeenCalled();
    expect(nav.share).toBe(share);
  });

  it('sin compartir, descarga por link y revoca la URL recién después de ~1 s', fakeAsync(() => {
    setNav('canShare', undefined);
    const click = spyOn(HTMLAnchorElement.prototype, 'click');
    const revoke = spyOn(URL, 'revokeObjectURL');
    spyOn(URL, 'createObjectURL').and.returnValue('blob:x');
    svc.exportCsv('2026-10-01', '2026-10-31');
    answer();
    flushMicrotasks();
    expect(click).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();
    tick(1000);
    expect(revoke).toHaveBeenCalledWith('blob:x');
  }));

  it('si compartir falla (no por cancelar), cae a la descarga por link', fakeAsync(() => {
    setNav('canShare', () => true);
    setNav('share', () => Promise.reject(new DOMException('x', 'NotAllowedError')));
    const click = spyOn(HTMLAnchorElement.prototype, 'click');
    spyOn(URL, 'createObjectURL').and.returnValue('blob:x');
    spyOn(URL, 'revokeObjectURL');
    svc.exportCsv('2026-10-01', '2026-10-31');
    answer();
    flushMicrotasks();
    tick(1000);
    expect(click).toHaveBeenCalledTimes(1);
  }));
});
