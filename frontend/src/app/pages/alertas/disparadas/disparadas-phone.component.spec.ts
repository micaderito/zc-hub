import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { QueryClient } from '@tanstack/angular-query-experimental';
import { AlertsService } from '../../../core/services/alerts.service';
import { CatalogMember, CatalogUnit } from '../../../core/services/orders.service';
import { SessionService } from '../../../core/services/session.service';
import { DisparadasPhoneComponent, bucketOf, unitPhotos, unitThumb } from './disparadas-phone.component';

const member = (over: Partial<CatalogMember> = {}): CatalogMember => ({
  sku: 'A', label: 'Cuaderno A5', stockMl: 1, stockTn: 2, stockEffective: 1, depositoStock: null, threshold: 3, alertState: 'still-low', ...over,
});

const unit = (over: Partial<CatalogUnit> = {}): CatalogUnit => ({
  key: 'sku:A', kind: 'sku', packId: null, sku: 'A', name: 'Cuaderno A5', code: 'C-1', description: 'CUADERNO',
  unitsPerPack: 1, mode: 'bulk', price: null, members: [member()], alerted: true, suggestedQty: 2,
  depositoStock: null, lastOrder: null, pendingOrder: null, suppliers: ['pc'], priceSupplier: 'pc', ...over,
});

const out = unit({ key: 'sku:B', sku: 'B', name: 'Repuesto', members: [member({ sku: 'B', label: 'Repuesto', stockMl: 0, stockTn: 0, stockEffective: 0, alertState: 'out' })] });
const ordered = unit({ key: 'sku:C', sku: 'C', name: 'Carpeta', pendingOrder: { orderId: 41, orderName: 'Nov' }, members: [member({ sku: 'C', label: 'Carpeta' })] });
const pack = unit({
  key: 'pack:1', kind: 'pack', packId: 1, sku: null, name: 'Agenda 2027', mode: 'assorted', unitsPerPack: 8, depositoStock: 12,
  members: [
    member({ sku: 'L', label: 'Lavanda' }),
    member({ sku: 'V', label: 'Verde', stockEffective: 8, alertState: 'watching' }),
    member({ sku: 'R', label: 'Rosa', stockEffective: 9, alertState: 'watching' }),
  ],
});

describe('DisparadasPhoneComponent', () => {
  let fixture: ComponentFixture<DisparadasPhoneComponent>;
  let component: DisparadasPhoneComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [DisparadasPhoneComponent],
      providers: [
        provideRouter([]),
        { provide: AlertsService, useValue: {} },
        { provide: QueryClient, useValue: { invalidateQueries: () => undefined } },
        { provide: SessionService, useValue: { isAdmin: signal(true), isReadOnly: () => false } },
      ],
    });
    fixture = TestBed.createComponent(DisparadasPhoneComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('units', [out, pack, unit(), ordered]);
    fixture.componentRef.setInput('suppliers', [{ key: 'pc', name: 'Punto Cero', profileName: null, discount1: null, discount2: null }]);
    fixture.detectChanges();
  });

  const text = () => fixture.nativeElement.textContent as string;

  it('separa por urgencia: lo pedido va aparte aunque esté bajo', () => {
    expect(bucketOf(out)).toBe('out');
    expect(bucketOf(unit())).toBe('low');
    expect(bucketOf(ordered)).toBe('ordered');
    expect(component.counts()).toEqual({ out: 1, low: 2, ordered: 1 });
    expect(component.sections().map((s) => s.key)).toEqual(['out', 'low', 'ordered']);
    expect(text()).toContain('Sin stock');
    expect(text()).toContain('pedido #41');
    expect(text()).toContain('1 de 3 modelos');
  });

  it('tocar un número filtra esa sección y volver a tocarlo lo saca', () => {
    const tiles = fixture.nativeElement.querySelectorAll('.dp-tile') as NodeListOf<HTMLButtonElement>;
    tiles[0].click();
    fixture.detectChanges();
    expect(component.sections().map((s) => s.key)).toEqual(['out']);
    expect(text()).not.toContain('Cuaderno A5');
    tiles[0].click();
    fixture.detectChanges();
    expect(component.bucketFilter()).toBeNull();
  });

  it('tocar un pack abre la hoja con los modelos con alerta primero', () => {
    component.open(pack);
    fixture.detectChanges();
    const sheet = fixture.nativeElement.querySelector('zc-bottom-sheet') as HTMLElement;
    expect(sheet.textContent).toContain('Agenda 2027');
    expect(sheet.textContent).toContain('12 u.');
    expect(sheet.textContent).toContain('Punto Cero');
    expect(sheet.textContent).toContain('Lavanda');
    expect(sheet.textContent).toContain('2 más sin alerta');
    expect(sheet.textContent).not.toContain('Verde');
    component.showAllMembers.set(true);
    fixture.detectChanges();
    expect(sheet.textContent).toContain('Verde');
  });

  it('tocar un modelo abre la hoja de umbral con su regla', () => {
    fixture.componentRef.setInput('rules', [{ sku: 'L', threshold: 3, productLabel: 'Lavanda', state: 'triggered', mutedUntil: '2099-01-01', stockMl: 1, stockTn: 2, stockEffective: 1, pack: null }]);
    component.editThreshold(pack.members[0]);
    fixture.detectChanges();
    expect(component.thresholdTarget()).toEqual(jasmine.objectContaining({ sku: 'L', threshold: 3, mutedUntil: '2099-01-01' }));
    expect(fixture.nativeElement.querySelector('zc-threshold-sheet')).not.toBeNull();
  });

  it('muestra la foto real del producto (con zoom), no un ícono', () => {
    const withPhoto = unit({ members: [member({ thumbnail: 'https://ml/a-I.jpg' })] });
    fixture.componentRef.setInput('units', [withPhoto]);
    fixture.detectChanges();
    const img = fixture.nativeElement.querySelector('.dp-card img') as HTMLImageElement;
    expect(img?.getAttribute('src')).toBe('https://ml/a-I.jpg');
    expect(fixture.nativeElement.querySelector('.dp-card [role="button"]')).not.toBeNull();
  });

  it('la foto de un pack es la del modelo con alerta, y el zoom recorre todas', () => {
    const p = unit({
      key: 'pack:2', members: [
        member({ sku: 'V', alertState: 'watching', thumbnail: 'v.jpg' }),
        member({ sku: 'L', alertState: 'out', thumbnail: 'l.jpg' }),
        member({ sku: 'R', alertState: 'watching', thumbnail: null }),
      ],
    });
    expect(unitThumb(p)).toBe('l.jpg');
    expect(unitPhotos(p)).toEqual(['l.jpg', 'v.jpg']);
    expect(unitThumb(unit({ members: [member({ thumbnail: null })] }))).toBeNull();
  });
});
