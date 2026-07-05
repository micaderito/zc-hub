import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ConfirmDialogComponent } from './confirm-dialog.component';

describe('ConfirmDialogComponent', () => {
  let fixture: ComponentFixture<ConfirmDialogComponent>;
  let component: ConfirmDialogComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ConfirmDialogComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(ConfirmDialogComponent);
    component = fixture.componentInstance;
  });

  function setRequiredInputs() {
    fixture.componentRef.setInput('title', '¿Confirmar acción?');
  }

  it('debería crearse con los valores por defecto', () => {
    setRequiredInputs();
    fixture.detectChanges();

    expect(component).toBeTruthy();
    expect(component.message()).toBe('');
    expect(component.confirmLabel()).toBe('Confirmar');
    expect(component.cancelLabel()).toBe('Cancelar');
    expect(component.variant()).toBe('warn');
    expect(component.icon()).toBe('ti-alert-triangle');
  });

  it('debería mostrar el título y las etiquetas de los botones', () => {
    setRequiredInputs();
    fixture.componentRef.setInput('confirmLabel', 'Eliminar');
    fixture.componentRef.setInput('cancelLabel', 'Volver');
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('h2')?.textContent).toContain('¿Confirmar acción?');
    const buttons = el.querySelectorAll('.zc-btn');
    expect(buttons[0].textContent).toContain('Volver');
    expect(buttons[1].textContent).toContain('Eliminar');
  });

  it('debería mostrar el mensaje simple cuando se provee', () => {
    setRequiredInputs();
    fixture.componentRef.setInput('message', 'Esta acción no se puede deshacer.');
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.zc-confirm-body p')?.textContent).toContain(
      'Esta acción no se puede deshacer.'
    );
  });

  it('debería proyectar contenido cuando no hay mensaje', () => {
    setRequiredInputs();
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.zc-confirm-body p')).toBeNull();
  });

  it('debería aplicar la clase danger cuando variant es danger', () => {
    setRequiredInputs();
    fixture.componentRef.setInput('variant', 'danger');
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.zc-confirm-head')?.classList.contains('danger')).toBeTrue();
    expect(el.querySelector('.zc-btn.primary')?.classList.contains('danger')).toBeTrue();
  });

  it('no debería aplicar la clase danger cuando variant es warn', () => {
    setRequiredInputs();
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.zc-confirm-head')?.classList.contains('danger')).toBeFalse();
  });

  it('debería emitir confirmed al hacer click en el botón de confirmar', () => {
    setRequiredInputs();
    fixture.detectChanges();

    let confirmed = false;
    component.confirmed.subscribe(() => (confirmed = true));

    const el: HTMLElement = fixture.nativeElement;
    const confirmBtn = el.querySelector('.zc-btn.primary') as HTMLButtonElement;
    confirmBtn.click();

    expect(confirmed).toBeTrue();
  });

  it('debería emitir cancelled al hacer click en el botón de cancelar', () => {
    setRequiredInputs();
    fixture.detectChanges();

    let cancelled = false;
    component.cancelled.subscribe(() => (cancelled = true));

    const el: HTMLElement = fixture.nativeElement;
    const cancelBtn = el.querySelector('.zc-btn:not(.primary)') as HTMLButtonElement;
    cancelBtn.click();

    expect(cancelled).toBeTrue();
  });

  it('debería emitir cancelled al hacer click en el backdrop', () => {
    setRequiredInputs();
    fixture.detectChanges();

    let cancelled = false;
    component.cancelled.subscribe(() => (cancelled = true));

    const backdrop: HTMLElement = fixture.nativeElement.querySelector('.zc-confirm-backdrop');
    backdrop.click();

    expect(cancelled).toBeTrue();
  });

  it('no debería emitir cancelled al hacer click dentro de la card (stopPropagation)', () => {
    setRequiredInputs();
    fixture.detectChanges();

    let cancelled = false;
    component.cancelled.subscribe(() => (cancelled = true));

    const card: HTMLElement = fixture.nativeElement.querySelector('.zc-confirm-card');
    card.click();

    expect(cancelled).toBeFalse();
  });
});
