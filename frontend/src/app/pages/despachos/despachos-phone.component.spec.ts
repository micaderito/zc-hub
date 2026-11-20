import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DispatchPackage } from '../../core/services/dispatch.service';
import { PhotoLightboxService } from '../../shared/components/photo-lightbox/photo-lightbox.service';
import type { DispatchSection } from './despachos.component';
import { DespachosPhoneComponent, PhoneCounts } from './despachos-phone.component';

const item = (over: Partial<DispatchPackage['items'][number]> = {}) => ({
  sku: 'AGE27', title: 'Agenda 2027 semanal', variation: 'Verde agua', qty: 1, thumb: 'https://x/a-I.jpg', pictures: ['https://x/a-O.jpg'], ...over,
});

function pkg(over: Partial<DispatchPackage> = {}): DispatchPackage {
  return {
    channel: 'ml', saleId: '2000012345', orderIds: ['2000012345'], buyer: 'Lucía G.', city: 'Rosario',
    createdAt: '2026-10-09T12:00:00.000Z', logisticType: 'drop_off', shipStatus: 'ready_to_ship', substatus: 'ready_to_print',
    shippingMethod: null, deadline: '2026-10-10T02:00:00.000Z', deadlineHasTime: true, deadlineDay: '2026-10-09',
    slaStatus: 'on_time', bufferedUntil: null, bufferedDay: null, cancelled: false, bucket: 'today',
    state: { label: 'Listo para despachar', tone: 'neutral' }, preparedAt: null, preparedBy: null,
    items: [item()], ...over,
  };
}

const section = (key: string, packages: DispatchPackage[], over: Partial<DispatchSection> = {}): DispatchSection =>
  ({ key, icon: 'ti-clock', title: `Sección ${key}`, hint: null, tone: 'neutral', packages, ...over });

const counts = (over: Partial<PhoneCounts> = {}): PhoneCounts => ({ overdue: 0, today: 2, upcoming: 0, toPrepare: 3, prepared: 1, ...over });

describe('DespachosPhoneComponent', () => {
  let fixture: ComponentFixture<DespachosPhoneComponent>;
  let component: DespachosPhoneComponent;
  let el: HTMLElement;

  function render(sections: DispatchSection[], extra: Record<string, unknown> = {}) {
    fixture = TestBed.createComponent(DespachosPhoneComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('sections', sections);
    fixture.componentRef.setInput('counts', extra['counts'] ?? counts());
    fixture.componentRef.setInput('tab', extra['tab'] ?? 'today');
    fixture.componentRef.setInput('channel', 'all');
    fixture.componentRef.setInput('today', '2026-10-09');
    for (const [k, v] of Object.entries(extra)) if (!['counts', 'tab'].includes(k)) fixture.componentRef.setInput(k, v);
    fixture.detectChanges();
    el = fixture.nativeElement;
  }

  beforeEach(() => TestBed.configureTestingModule({ imports: [DespachosPhoneComponent] }));
  afterEach(() => TestBed.inject(PhotoLightboxService).close());

  it('una fila por paquete: un producto muestra su nombre; varios, quién compró y cuántos con "+N" en la foto', () => {
    render([section('ml', [
      pkg({ saleId: 'a', items: [item({ qty: 3 })] }),
      pkg({ saleId: 'b', buyer: 'Martín P.', items: [item(), item({ title: 'Repuesto', qty: 2 }), item({ title: 'Separadores' })] }),
    ])]);
    const rows = el.querySelectorAll('.dp-row');
    expect(rows.length).toBe(2);
    expect(rows[0].querySelector('.dp-title')!.textContent).toContain('Agenda 2027 semanal');
    expect(rows[0].querySelector('.dp-title')!.textContent).toContain('×3');
    expect(rows[0].textContent).toContain('Lucía G.');
    expect(rows[1].querySelector('.dp-title')!.textContent).toContain('Martín P. · 4 productos');
    expect(rows[1].querySelector('.dp-more')!.textContent).toContain('+2');
  });

  it('avance del día y productos por armar', () => {
    render([section('ml', [pkg()])]);
    expect(el.querySelector('.dp-progress')!.textContent).toContain('1 de 2 preparados');
    expect(el.querySelector('.dp-progress')!.textContent).toContain('3 productos por armar');
  });

  it('el tilde emite sin abrir la hoja; un preparado se pinta de verde', () => {
    render([section('ml', [pkg({ saleId: 'a' }), pkg({ saleId: 'b', preparedAt: '2026-10-09T13:00:00Z' })])]);
    const emitted: DispatchPackage[] = [];
    component.togglePrepared.subscribe((p) => emitted.push(p));
    (el.querySelector('.dp-tick') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(emitted.map((p) => p.saleId)).toEqual(['a']);
    expect(el.querySelector('zc-bottom-sheet')).toBeNull();
    const rows = el.querySelectorAll('.dp-row');
    expect(rows[1].classList).toContain('prep');
    expect(rows[1].querySelector('.dp-tick')!.classList).toContain('on');
  });

  it('tocar la fila abre la hoja con notas, productos y "Marcar preparado", que tilda y cierra', () => {
    const p = pkg({ saleId: 'a', notes: [{ text: 'Papel de regalo', author: 'seller' }], items: [item(), item({ title: 'Repuesto', qty: 2 })] });
    render([section('ml', [p])]);
    const emitted: DispatchPackage[] = [];
    component.togglePrepared.subscribe((x) => emitted.push(x));
    (el.querySelector('.dp-row-main') as HTMLButtonElement).click();
    fixture.detectChanges();
    const sheet = el.querySelector('zc-bottom-sheet')!;
    expect(sheet.textContent).toContain('Papel de regalo');
    expect(sheet.textContent).toContain('3 productos');
    expect(sheet.querySelectorAll('.dp-items li').length).toBe(2);
    expect(sheet.querySelector('a.dp-btn')!.getAttribute('href')).toContain('/ventas/2000012345/detalle');
    (sheet.querySelector('button.dp-btn') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(emitted.map((x) => x.saleId)).toEqual(['a']);
    expect(el.querySelector('zc-bottom-sheet')).toBeNull();
  });

  it('Atrasados filtra a esa sección y tocarlo de nuevo vuelve a todo Hoy', () => {
    render([
      section('overdue', [pkg({ saleId: 'o', bucket: 'overdue', deadline: '2026-10-09T16:00:00.000Z' })], { tone: 'err' }),
      section('ml', [pkg({ saleId: 'a' })]),
    ], { counts: counts({ overdue: 1 }) });
    expect(el.querySelector('.dp-row.overdue')!.textContent).toContain('venció 13:00');
    const tile = el.querySelector('.dp-tile') as HTMLButtonElement;
    tile.click();
    fixture.detectChanges();
    expect(el.querySelectorAll('.dp-row').length).toBe(1);
    tile.click();
    fixture.detectChanges();
    expect(el.querySelectorAll('.dp-row').length).toBe(2);
  });

  it('Ya despachados arranca plegado, sin tilde, y se despliega', () => {
    const dispatched = section('dispatched', [pkg({ saleId: 'z', bucket: 'dispatched', state: { label: 'Despachado 11:00', tone: 'ok' } })], { collapsible: true, tone: 'ok' });
    render([dispatched]);
    expect(el.querySelector('.dp-row')).toBeNull();
    expect(el.textContent).toContain('No hay nada pendiente de despachar');
    let toggled: boolean | null = null;
    component.showDispatchedChange.subscribe((v) => (toggled = v));
    (el.querySelector('.dp-sec.toggle') as HTMLButtonElement).click();
    expect(toggled as boolean | null).toBe(true);
    fixture.componentRef.setInput('showDispatched', true);
    fixture.detectChanges();
    expect(el.querySelector('.dp-row')!.textContent).toContain('Despachado 11:00');
    expect(el.querySelector('.dp-tick')).toBeNull();
  });
});
