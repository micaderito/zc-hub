import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { QueryClient, provideTanStackQuery } from '@tanstack/angular-query-experimental';
import { AlertsService, StockNotification } from '../../../core/services/alerts.service';
import { SessionService } from '../../../core/services/session.service';
import { AlertasNotificacionesComponent, dayLabel, nowState } from './alertas-notificaciones.component';

const notif = (over: Partial<StockNotification> = {}): StockNotification => ({
  id: 1, sku: 'A', productLabel: 'Agenda 2027', threshold: 3, stockMl: 2, stockTn: 2, stockEffective: 2,
  readAt: null, createdAt: new Date().toISOString(), thumbnail: 'https://ml/a-I.jpg', stockNow: 2, stockNowMl: 2, stockNowTn: 2, ...over,
});

describe('AlertasNotificacionesComponent', () => {
  let fixture: ComponentFixture<AlertasNotificacionesComponent>;
  let alerts: jasmine.SpyObj<AlertsService>;

  async function create(list: StockNotification[]): Promise<void> {
    alerts = jasmine.createSpyObj<AlertsService>('AlertsService', ['getNotificationsPromise', 'markNotificationsRead', 'muteRule']);
    alerts.getNotificationsPromise.and.resolveTo({ notifications: list, total: list.length, unreadCount: list.filter((n) => !n.readAt).length });
    alerts.markNotificationsRead.and.resolveTo();
    alerts.muteRule.and.resolveTo();
    TestBed.configureTestingModule({
      imports: [AlertasNotificacionesComponent],
      providers: [
        provideTanStackQuery(new QueryClient()),
        { provide: AlertsService, useValue: alerts },
        { provide: SessionService, useValue: { isAdmin: signal(true), isReadOnly: () => false } },
      ],
    });
    fixture = TestBed.createComponent(AlertasNotificacionesComponent);
    // La query de TanStack resuelve en microtareas/timers propios: se espera a que llegue la data.
    for (let i = 0; i < 10 && !fixture.componentInstance.query.isSuccess(); i++) {
      fixture.detectChanges();
      await new Promise((r) => setTimeout(r));
    }
    fixture.detectChanges();
  }

  const el = () => fixture.nativeElement as HTMLElement;

  it('pide la bandeja con foto y stock de ahora (enrich)', async () => {
    await create([notif()]);
    expect(alerts.getNotificationsPromise).toHaveBeenCalledWith(jasmine.objectContaining({ enrich: true }));
  });

  it('cada aviso trae la foto del producto, cuánto quedaba y cómo está hoy', async () => {
    const ayer = new Date(Date.now() - 86_400_000).toISOString();
    await create([notif(), notif({ id: 2, sku: 'B', productLabel: 'Repuesto', stockEffective: 0, stockNow: 12, readAt: ayer, createdAt: ayer })]);
    const items = el().querySelectorAll('.nt-item');
    expect(items.length).toBe(2);
    expect(items[0].querySelector('img')?.getAttribute('src')).toBe('https://ml/a-I.jpg');
    expect(items[0].classList).toContain('unread');
    expect(items[0].textContent).toContain('Quedaban 2');
    expect(items[0].textContent).toContain('Hoy quedan 2');
    expect(items[1].textContent).toContain('Se quedó sin stock');
    expect(items[1].textContent).toContain('Repuesto · hoy 12');
    expect(Array.from(el().querySelectorAll('.nt-day')).map((d) => d.textContent?.trim())).toEqual(['Hoy', 'Ayer']);
  });

  it('marcar leída y silenciar llaman al servicio', async () => {
    await create([notif()]);
    const btns = el().querySelectorAll<HTMLButtonElement>('.nt-btn');
    btns[0].click();
    await fixture.whenStable();
    expect(alerts.markNotificationsRead).toHaveBeenCalledWith({ ids: [1] });
    btns[1].click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(alerts.muteRule).toHaveBeenCalledWith('A', 7);
    expect(el().textContent).toContain('Silenciada');
  });

  it('nowState y dayLabel', () => {
    expect(nowState(notif({ stockNow: 0 }))?.cls).toBe('err');
    expect(nowState(notif({ stockNow: 3 }))?.cls).toBe('warn');
    expect(nowState(notif({ stockNow: 4 }))?.cls).toBe('ok');
    expect(nowState(notif({ stockNow: null }))).toBeNull();
    const now = new Date(2026, 10, 22, 10);
    expect(dayLabel(new Date(2026, 10, 22, 1).toISOString(), now)).toBe('Hoy');
    expect(dayLabel(new Date(2026, 10, 21, 23).toISOString(), now)).toBe('Ayer');
    expect(dayLabel(new Date(2026, 10, 16, 9).toISOString(), now)).toMatch(/^Lunes/);
  });
});
