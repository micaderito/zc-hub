import { TestBed } from '@angular/core/testing';
import { provideTanStackQuery, QueryClient } from '@tanstack/angular-query-experimental';
import { VentasComponent } from './ventas.component';
import { formatDay } from './ventas.utils';
import { SalesReport, SalesService } from '../../core/services/sales.service';

const REPORT: SalesReport = {
  kpis: {
    facturadoTotal: 3000, facturadoDeltaPct: 10, ventas: 3, ventasDeltaPct: 0,
    unidades: 4, unidadesDeltaPct: 0, ticketPromedio: 1000, ticketPromedioDeltaPct: 0,
  },
  provinces: [{ name: 'Córdoba', ventas: 3, unidades: 4, facturado: 3000, pctOfTotal: 100, deltaPct: 10 }],
  excluded: { total: 3, facturadas: 3, canceladas: 0, devueltas: 0 },
  topProducts: [],
  daily: [
    { day: '2026-10-01T12:00:00', amount: 1000 },
    { day: '2026-10-02T12:00:00', amount: 2000 },
  ],
};

describe('VentasComponent — gráfico diario', () => {
  /** Escritorio por defecto: el navegador de los tests es más angosto que 760px. */
  let phone = false;
  beforeEach(() => {
    phone = false;
    spyOn(window, 'matchMedia').and.callFake(
      () => ({ matches: phone, addEventListener: () => undefined, removeEventListener: () => undefined }) as unknown as MediaQueryList,
    );
  });

  async function setup() {
    TestBed.configureTestingModule({
      imports: [VentasComponent],
      providers: [
        provideTanStackQuery(new QueryClient({ defaultOptions: { queries: { retry: false } } })),
        {
          provide: SalesService,
          useValue: {
            getReportPromise: () => Promise.resolve(REPORT),
            getSyncStatePromise: () => Promise.resolve({ status: 'idle', lastSyncAt: '2026-10-31T00:00:00Z', processed: 0, total: 0, phase: null }),
            startSync: () => Promise.resolve(),
            exportCsv: () => Promise.resolve(),
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(VentasComponent);
    fixture.detectChanges();
    for (let i = 0; i < 5 && !fixture.nativeElement.querySelector('.chart-bar, .vp-hero'); i++) {
      await fixture.whenStable();
      await new Promise((r) => setTimeout(r));
      fixture.detectChanges();
    }
    return fixture;
  }

  it('tocar una barra muestra su día y monto abajo; tocarla de nuevo lo oculta', async () => {
    const fixture = await setup();
    const el: HTMLElement = fixture.nativeElement;
    const bars = el.querySelectorAll<HTMLElement>('.chart-bar');
    expect(bars.length).toBe(2);
    expect(el.querySelector('.chart-pick')).toBeNull();

    bars[1].click();
    fixture.detectChanges();
    expect(el.querySelector('.chart-pick')?.textContent).toContain('2/10');
    expect(el.querySelector('.chart-pick')?.textContent).toContain('$2.000');
    expect(bars[1].classList).toContain('on');

    bars[1].click();
    fixture.detectChanges();
    expect(el.querySelector('.chart-pick')).toBeNull();
  });

  it('en el celular muestra zc-ventas-phone en vez del encabezado y la tabla', async () => {
    phone = true;
    const fixture = await setup();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('zc-ventas-phone')).not.toBeNull();
    expect(el.querySelector('.page-header')).toBeNull();
    expect(el.querySelector('.prov-table')).toBeNull();
    expect(el.querySelector('.vp-big')?.textContent).toContain('$3.000');
  });

  it('formatDay no corre el día por la zona horaria', () => {
    expect(formatDay('2026-10-01T00:00:00.000Z')).toBe('1/10');
    expect(formatDay('2026-10-31')).toBe('31/10');
  });
});
