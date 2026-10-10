import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTanStackQuery, QueryClient } from '@tanstack/angular-query-experimental';
import { DispatchList, DispatchPackage, DispatchService } from '../../core/services/dispatch.service';
import { DespachosComponent, countdown } from './despachos.component';

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function pkg(over: Partial<DispatchPackage> = {}): DispatchPackage {
  return {
    channel: 'ml',
    saleId: '2000012345',
    orderIds: ['2000012345'],
    buyer: 'COMPRADORA',
    city: 'Córdoba',
    createdAt: '2026-10-08T15:00:00.000Z',
    logisticType: 'drop_off',
    shipStatus: 'ready_to_ship',
    substatus: 'ready_to_print',
    shippingMethod: null,
    deadline: '2026-10-09T16:00:00.000Z',
    deadlineHasTime: true,
    deadlineDay: '2026-10-09',
    slaStatus: 'on_time',
    bufferedUntil: null,
    bufferedDay: null,
    cancelled: false,
    bucket: 'today',
    state: { label: 'Imprimir etiqueta', tone: 'warn' },
    preparedAt: null,
    preparedBy: null,
    items: [{ sku: 'AGE27', title: 'Agenda 2027 semanal', variation: 'Verde agua', qty: 2, thumb: 'https://x/a-I.jpg', pictures: ['https://x/a-O.jpg', 'https://x/b-O.jpg'] }],
    ...over,
  };
}

function list(packages: DispatchPackage[]): DispatchList {
  return { generatedAt: new Date().toISOString(), today: '2026-10-09', packages, errors: {} };
}

class DispatchMock {
  data = list([]);
  getList = jasmine.createSpy('getList').and.callFake(() => Promise.resolve(this.data));
  setPrepared = jasmine.createSpy('setPrepared').and.resolveTo({ ok: true });
  markCancelSeen = jasmine.createSpy('markCancelSeen').and.resolveTo({ ok: true });
}

describe('DespachosComponent', () => {
  let fixture: ComponentFixture<DespachosComponent>;
  let component: DespachosComponent;
  let svc: DispatchMock;

  async function load(packages: DispatchPackage[]) {
    svc.data = list(packages);
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  }

  beforeEach(async () => {
    svc = new DispatchMock();
    await TestBed.configureTestingModule({
      imports: [DespachosComponent],
      providers: [
        provideTanStackQuery(new QueryClient({ defaultOptions: { queries: { gcTime: 0, retry: false } } })),
        { provide: DispatchService, useValue: svc },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(DespachosComponent);
    component = fixture.componentInstance;
  });

  it('Hoy: atrasados primero, después ML por horario de corte y TN al final', async () => {
    await load([
      pkg({ saleId: 'a' }),
      pkg({ saleId: 'b', bucket: 'overdue', deadline: '2026-10-08T16:00:00.000Z', deadlineDay: '2026-10-08' }),
      pkg({ saleId: 'c', channel: 'tn', orderNumber: '1543', bucket: 'today', deadline: null, deadlineHasTime: false, deadlineDay: null }),
      pkg({ saleId: 'd', bucket: 'upcoming', deadline: '2026-10-10T16:00:00.000Z', deadlineDay: '2026-10-10' }),
    ]);
    const sections = component.sections();
    expect(sections.map((s) => s.key)).toEqual(['overdue', 'ml-13:00', 'tn']);
    expect(sections[1].title).toBe('Llevar al correo antes de las 13:00');
    expect(component.counts().today).toBe(3);
    expect(component.counts().upcoming).toBe(1);
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Venta #a');
    expect(text).toContain('Orden #1543');
    expect(text).not.toContain('Venta #d');
    expect(text).toContain('Venció ayer 13:00');
  });

  it('Próximos días agrupa por día, con los envíos en espera', async () => {
    await load([
      pkg({ saleId: 'd', bucket: 'upcoming', substatus: 'buffered', bufferedUntil: '2026-10-12T03:00:00.000Z', bufferedDay: '2026-10-12', state: { label: 'En espera hasta el 12/10', tone: 'neutral' } }),
    ]);
    component.tab.set('upcoming');
    fixture.detectChanges();
    const s = component.sections();
    expect(s.length).toBe(1);
    expect(s[0].title).toContain('12/10');
    expect(s[0].hint).toBe('La etiqueta se habilita ese día');
  });

  it('filtra por canal', async () => {
    await load([pkg({ saleId: 'a' }), pkg({ saleId: 'c', channel: 'tn', deadline: null, deadlineDay: null })]);
    component.channel.set('tn');
    expect(component.sections().flatMap((s) => s.packages).map((p) => p.saleId)).toEqual(['c']);
  });

  it('cancelados arriba; "Entendido" lo saca y lo guarda', async () => {
    await load([pkg({ saleId: 'x', cancelled: true, bucket: 'cancelled', preparedAt: '2026-10-09T12:00:00Z', state: { label: 'Cancelado', tone: 'err' } })]);
    expect(fixture.nativeElement.textContent).toContain('Cancelado, no despachar');
    expect(fixture.nativeElement.textContent).toContain('desarmalo');
    await component.dismissCancelled(component.cancelled()[0]);
    fixture.detectChanges();
    expect(svc.markCancelSeen).toHaveBeenCalledWith(jasmine.objectContaining({ saleId: 'x' }));
    expect(component.cancelled().length).toBe(0);
  });

  it('tildar preparado llama al servicio y "ocultar preparados" lo esconde', async () => {
    await load([pkg({ saleId: 'a' })]);
    const p = component.sections()[0].packages[0];
    svc.data = list([pkg({ saleId: 'a', preparedAt: '2026-10-09T13:00:00Z' })]);
    await component.togglePrepared(p);
    expect(svc.setPrepared).toHaveBeenCalledWith(jasmine.objectContaining({ saleId: 'a' }), true);
    expect(component.counts().prepared).toBe(1);
    component.hidePrepared.set(true);
    expect(component.sections().length).toBe(0);
  });

  it('click en la foto abre el lightbox con todas las fotos del producto', async () => {
    await load([pkg()]);
    (fixture.nativeElement.querySelector('.thumb-btn') as HTMLButtonElement).click();
    fixture.detectChanges();
    const lb = fixture.nativeElement.querySelector('zc-photo-lightbox');
    expect(lb).toBeTruthy();
    expect(lb.querySelectorAll('.lb-mini').length).toBe(2);
    expect(lb.textContent).toContain('Agenda 2027 semanal');
  });

  it('avisa si un canal no se pudo leer', async () => {
    svc.data = { ...list([]), errors: { ml: 'La API no contestó' } };
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('No se pudo leer Mercado Libre');
  });

  it('countdown', () => {
    const now = new Date('2026-10-09T13:20:00.000Z').getTime();
    expect(countdown('2026-10-09T16:00:00.000Z', now)).toBe('faltan 2 h 40 min');
    expect(countdown('2026-10-09T13:45:00.000Z', now)).toBe('faltan 25 min');
    expect(countdown('2026-10-09T13:00:00.000Z', now)).toBeNull();
  });
});
