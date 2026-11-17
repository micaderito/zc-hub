import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { QueryClient } from '@tanstack/angular-query-experimental';
import { AlertsService } from '../../../core/services/alerts.service';
import { SessionService } from '../../../core/services/session.service';
import { ThresholdSheetComponent, ThresholdTarget } from './threshold-sheet.component';

describe('ThresholdSheetComponent', () => {
  let fixture: ComponentFixture<ThresholdSheetComponent>;
  let component: ThresholdSheetComponent;
  let alerts: jasmine.SpyObj<AlertsService>;
  let queryClient: { invalidateQueries: jasmine.Spy };
  let closed: number;
  const admin = signal(true);

  const target = (over: Partial<ThresholdTarget> = {}): ThresholdTarget => ({
    sku: 'A', label: 'Cuaderno A5', stockMl: 1, stockTn: 2, threshold: 3, mutedUntil: null, ...over,
  });

  function create(t: ThresholdTarget): void {
    alerts = jasmine.createSpyObj<AlertsService>('AlertsService', ['saveRule', 'muteRule', 'deleteRule']);
    alerts.saveRule.and.resolveTo();
    alerts.muteRule.and.resolveTo();
    alerts.deleteRule.and.resolveTo();
    queryClient = { invalidateQueries: jasmine.createSpy('invalidateQueries') };
    TestBed.configureTestingModule({
      imports: [ThresholdSheetComponent],
      providers: [
        { provide: AlertsService, useValue: alerts },
        { provide: QueryClient, useValue: queryClient },
        { provide: SessionService, useValue: { isAdmin: admin, isReadOnly: () => !admin() } },
      ],
    });
    fixture = TestBed.createComponent(ThresholdSheetComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('target', t);
    closed = 0;
    component.closed.subscribe(() => closed++);
    fixture.detectChanges();
  }

  beforeEach(() => admin.set(true));

  it('arranca con el umbral de la regla y guarda el nuevo', async () => {
    create(target());
    expect(component.value()).toBe(3);
    component.step(1);
    component.step(1);
    await component.save();
    expect(alerts.saveRule).toHaveBeenCalledWith('A', 5, 'Cuaderno A5');
    expect(queryClient.invalidateQueries).toHaveBeenCalled();
    expect(closed).toBe(1);
  });

  it('sin regla crea una con 3 por defecto y no ofrece quitar ni silenciar', async () => {
    create(target({ threshold: null }));
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Crear alerta');
    expect(text).not.toContain('Quitar');
    expect(text).not.toContain('Silenciar');
    await component.save();
    expect(alerts.saveRule).toHaveBeenCalledWith('A', 3, 'Cuaderno A5');
  });

  it('no baja de 0 y un valor tipeado inválido queda en 0', () => {
    create(target({ threshold: 0 }));
    component.step(-1);
    expect(component.value()).toBe(0);
    component.setValue('abc');
    expect(component.value()).toBe(0);
    component.setValue('7');
    expect(component.value()).toBe(7);
  });

  it('quitar pide un segundo toque', async () => {
    create(target());
    await component.remove();
    expect(alerts.deleteRule).not.toHaveBeenCalled();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('¿Quitar la alerta?');
    await component.remove();
    expect(alerts.deleteRule).toHaveBeenCalledWith('A');
    expect(closed).toBe(1);
  });

  it('silencia 7 días; si ya está silenciada no lo ofrece', async () => {
    create(target());
    await component.mute();
    expect(alerts.muteRule).toHaveBeenCalledWith('A', 7);

    TestBed.resetTestingModule();
    create(target({ mutedUntil: new Date(Date.now() + 86_400_000).toISOString() }));
    expect(fixture.nativeElement.textContent).toContain('Silenciada por unos días');
  });

  it('si falla muestra el error y no se cierra', async () => {
    create(target());
    alerts.saveRule.and.rejectWith({ error: { error: 'Umbral inválido' } });
    await component.save();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Umbral inválido');
    expect(closed).toBe(0);
  });

  it('un usuario de lectura solo ve el umbral', () => {
    admin.set(false);
    create(target());
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Avisa cuando queden 3 o menos');
    expect(fixture.nativeElement.querySelector('.ts-btn')).toBeNull();
  });
});
