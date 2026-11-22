import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { QueryClient } from '@tanstack/angular-query-experimental';
import { AlertsService, UnwatchedProduct } from '../../../core/services/alerts.service';
import { SessionService } from '../../../core/services/session.service';
import { AlertasSinAlertaComponent } from './alertas-sin-alerta.component';

const product = (sku: string, over: Partial<UnwatchedProduct> = {}): UnwatchedProduct => ({
  sku, productLabel: `Producto ${sku}`, thumbnail: `https://ml/${sku}-I.jpg`, stockMl: 4, stockTn: 4, stockEffective: 4, pack: null, ...over,
});

describe('AlertasSinAlertaComponent', () => {
  let fixture: ComponentFixture<AlertasSinAlertaComponent>;
  let component: AlertasSinAlertaComponent;
  let alerts: jasmine.SpyObj<AlertsService>;
  const admin = signal(true);
  const products = [product('A'), product('B', { pack: { packId: 1, name: 'Agendas', sku: null, unitCount: 8, mode: 'assorted' } }), product('C', { productLabel: 'Repuesto' })];

  function create(phone = false): void {
    spyOn(window, 'matchMedia').and.returnValue({ matches: phone, addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as MediaQueryList);
    alerts = jasmine.createSpyObj<AlertsService>('AlertsService', ['saveRule']);
    alerts.saveRule.and.resolveTo();
    TestBed.configureTestingModule({
      imports: [AlertasSinAlertaComponent],
      providers: [
        { provide: AlertsService, useValue: alerts },
        { provide: QueryClient, useValue: { invalidateQueries: () => undefined } },
        { provide: SessionService, useValue: { isAdmin: admin, isReadOnly: () => !admin() } },
      ],
    });
    fixture = TestBed.createComponent(AlertasSinAlertaComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('products', products);
    fixture.detectChanges();
  }

  const el = () => fixture.nativeElement as HTMLElement;
  beforeEach(() => admin.set(true));

  it('en la compu: tabla con la foto de cada producto (con zoom)', () => {
    create();
    const imgs = el().querySelectorAll('.sa-table tbody img');
    expect(imgs.length).toBe(3);
    expect(imgs[0].getAttribute('src')).toBe('https://ml/A-I.jpg');
    expect(el().querySelector('.sa-table tbody [role="button"]')).not.toBeNull();
  });

  it('tildar varios y configurar crea la misma alerta para todos', async () => {
    create();
    const rows = el().querySelectorAll<HTMLTableRowElement>('.sa-table tbody tr');
    rows[0].click();
    rows[2].click();
    fixture.detectChanges();
    expect(el().querySelector('.sa-bar')?.textContent).toContain('2 tildados');

    component.configureSelected();
    fixture.detectChanges();
    expect(el().textContent).toContain('Alerta para 2 productos');
    expect(el().querySelector('zc-bottom-sheet')?.classList).toContain('as-dialog');

    (el().querySelector('.ts-btn.primary') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(alerts.saveRule.calls.allArgs()).toEqual([['A', 3, 'Producto A'], ['C', 3, 'Repuesto']]);
    expect(component.selectedCount()).toBe(0);
    expect(component.target()).toBeNull();
  });

  it('el tilde de arriba tilda lo que coincide con la búsqueda, y vuelve a destildarlo', () => {
    create();
    component.search.set('producto');
    fixture.detectChanges();
    component.toggleAllFiltered();
    expect([...component.selected()].sort()).toEqual(['A', 'B']);
    expect(component.allFilteredSelected()).toBeTrue();
    component.toggleAllFiltered();
    expect(component.selectedCount()).toBe(0);
  });

  it('el atajo de una fila configura solo ese producto y no limpia la selección', async () => {
    create();
    component.toggle(products[0]);
    component.toggle(products[1]);
    component.configureOne(products[1]);
    fixture.detectChanges();
    expect(el().textContent).toContain('Producto B');
    (el().querySelector('.ts-btn.primary') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(alerts.saveRule).toHaveBeenCalledOnceWith('B', 3, 'Producto B');
    expect([...component.selected()]).toEqual(['A']);
  });

  it('en el celu: lista que se toca para tildar, con barra fija', () => {
    create(true);
    expect(el().querySelector('table')).toBeNull();
    const rows = el().querySelectorAll<HTMLButtonElement>('.sa-row');
    expect(rows.length).toBe(3);
    expect(rows[0].querySelector('img')?.getAttribute('src')).toBe('https://ml/A-I.jpg');
    rows[1].click();
    fixture.detectChanges();
    expect(rows[1].classList).toContain('on');
    expect(el().querySelector('.sa-bar')?.textContent).toContain('1 tildado');
  });

  it('solo lectura: sin tildes ni barra', () => {
    admin.set(false);
    create();
    expect(el().querySelector('input[type="checkbox"]')).toBeNull();
    component.toggle(products[0]);
    fixture.detectChanges();
    expect(el().querySelector('.sa-bar')).toBeNull();
  });
});
