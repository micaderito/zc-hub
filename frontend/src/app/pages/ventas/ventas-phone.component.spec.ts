import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SalesReport } from '../../core/services/sales.service';
import { VentasPhoneComponent } from './ventas-phone.component';
import { MonthOption } from './ventas.utils';

const REPORT: SalesReport = {
  kpis: {
    facturadoTotal: 5000, facturadoDeltaPct: 12, ventas: 4, ventasDeltaPct: -4,
    unidades: 6, unidadesDeltaPct: 0, ticketPromedio: 1250, ticketPromedioDeltaPct: 3,
  },
  provinces: [
    { name: 'Buenos Aires', ventas: 3, unidades: 4, facturado: 4000, pctOfTotal: 80, deltaPct: 10 },
    { name: 'Córdoba', ventas: 1, unidades: 2, facturado: 1000, pctOfTotal: 20, deltaPct: -6 },
  ],
  excluded: { total: 6, facturadas: 4, canceladas: 1, devueltas: 1 },
  topProducts: [{ sku: 'A1', title: 'Cuaderno A5', units: 3, amount: 3000 }],
  daily: [
    { day: '2026-10-01T00:00:00.000Z', amount: 1000 },
    { day: '2026-10-02T00:00:00.000Z', amount: 4000 },
  ],
};

const MONTHS: MonthOption[] = [
  { value: '2026-11', label: 'noviembre 2026', from: '2026-11-01', to: '2026-11-30' },
  { value: '2026-10', label: 'octubre 2026', from: '2026-10-01', to: '2026-10-31' },
  { value: '2026-09', label: 'septiembre 2026', from: '2026-09-01', to: '2026-09-30' },
];

describe('VentasPhoneComponent', () => {
  let fixture: ComponentFixture<VentasPhoneComponent>;
  let el: HTMLElement;

  beforeEach(() => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(2026, 10, 19));
    TestBed.configureTestingModule({ imports: [VentasPhoneComponent] });
    fixture = TestBed.createComponent(VentasPhoneComponent);
    fixture.componentRef.setInput('report', REPORT);
    fixture.componentRef.setInput('months', MONTHS);
    fixture.componentRef.setInput('selectedMonth', '2026-10');
    fixture.componentRef.setInput('from', '2026-10-01');
    fixture.componentRef.setInput('to', '2026-10-31');
    fixture.detectChanges();
    el = fixture.nativeElement;
  });

  afterEach(() => jasmine.clock().uninstall());

  it('muestra lo facturado en grande contra el mes anterior', () => {
    expect(el.querySelector('.vp-hero')?.textContent).toContain('Facturado en octubre');
    expect(el.querySelector('.vp-big')?.textContent).toContain('$5.000');
    expect(el.querySelector('.vp-delta')?.textContent).toContain('+12% vs. septiembre');
  });

  it('los meses van en chips cortos y tocar uno avisa el cambio', () => {
    const chips = Array.from(el.querySelectorAll<HTMLButtonElement>('.vp-months .vp-chip'));
    expect(chips.map((c) => c.textContent?.trim())).toEqual(['nov.', 'octubre', 'sept.', 'Otro…']);
    let picked = '';
    fixture.componentInstance.monthChange.subscribe((v) => (picked = v));
    chips[2].click();
    expect(picked).toBe('2026-09');
  });

  it('las provincias abren su detalle en una hoja', () => {
    const rows = el.querySelectorAll<HTMLButtonElement>('.vp-row');
    expect(rows.length).toBe(2);
    rows[1].click();
    fixture.detectChanges();
    const sheet = el.querySelector('zc-bottom-sheet')!;
    expect(sheet.textContent).toContain('Córdoba');
    expect(sheet.textContent).toContain('6% menos que en septiembre');
  });

  it('Productos y Por día se muestran de a uno', () => {
    const tabs = el.querySelectorAll<HTMLButtonElement>('.vp-seg button');
    tabs[1].click();
    fixture.detectChanges();
    expect(el.textContent).toContain('Cuaderno A5');
    tabs[2].click();
    fixture.detectChanges();
    const cols = el.querySelectorAll<HTMLButtonElement>('.vp-col');
    expect(cols.length).toBe(2);
    expect(el.querySelector('.vp-axis')?.textContent).toContain('1/10');
    cols[1].click();
    fixture.detectChanges();
    expect(el.querySelector('.vp-pick')?.textContent).toContain('$4.000');
  });

  it('Exportar avisa al contenedor', () => {
    let exported = false;
    fixture.componentInstance.exportCsv.subscribe(() => (exported = true));
    (el.querySelector('.vp-cta') as HTMLButtonElement).click();
    expect(exported).toBeTrue();
  });

  it('un rango a mano dice las fechas y compara contra el período anterior', () => {
    fixture.componentRef.setInput('selectedMonth', 'custom');
    fixture.componentRef.setInput('from', '2026-10-05');
    fixture.componentRef.setInput('to', '2026-10-20');
    fixture.detectChanges();
    expect(el.querySelector('.vp-hero')?.textContent).toContain('del 5/10 al 20/10');
    expect(el.querySelector('.vp-delta')?.textContent).toContain('el período anterior');
    expect(Array.from(el.querySelectorAll('.vp-chip.on')).map((c) => c.textContent?.trim())).toEqual(['5/10 – 20/10']);
  });
});
