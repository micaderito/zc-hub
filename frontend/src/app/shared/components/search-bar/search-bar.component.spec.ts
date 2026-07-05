import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SearchBarComponent } from './search-bar.component';

describe('SearchBarComponent', () => {
  let fixture: ComponentFixture<SearchBarComponent>;
  let component: SearchBarComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SearchBarComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(SearchBarComponent);
    component = fixture.componentInstance;
  });

  it('debería iniciar con valor vacío y placeholders por defecto', () => {
    fixture.detectChanges();

    expect(component.value()).toBe('');
    expect(component.placeholder()).toBe('Buscar…');
    expect(component.ariaLabel()).toBe('Buscar');

    const input: HTMLInputElement = fixture.nativeElement.querySelector('input.search-input');
    expect(input.placeholder).toBe('Buscar…');
    expect(input.getAttribute('aria-label')).toBe('Buscar');
  });

  it('debería usar el placeholder y aria-label provistos', () => {
    fixture.componentRef.setInput('placeholder', 'Buscar producto…');
    fixture.componentRef.setInput('ariaLabel', 'Buscar producto');
    fixture.detectChanges();

    const input: HTMLInputElement = fixture.nativeElement.querySelector('input.search-input');
    expect(input.placeholder).toBe('Buscar producto…');
    expect(input.getAttribute('aria-label')).toBe('Buscar producto');
  });

  it('no debería mostrar el botón de limpiar cuando el valor está vacío', () => {
    fixture.detectChanges();

    const clearBtn = fixture.nativeElement.querySelector('.search-clear');
    expect(clearBtn).toBeNull();
  });

  it('debería mostrar el botón de limpiar cuando hay un valor', () => {
    fixture.componentRef.setInput('value', 'cuaderno');
    fixture.detectChanges();

    const clearBtn = fixture.nativeElement.querySelector('.search-clear');
    expect(clearBtn).not.toBeNull();
  });

  it('debería reflejar el valor inicial en el input', async () => {
    fixture.componentRef.setInput('value', 'lapiz');
    fixture.detectChanges();
    // NgModel escribe el valor en el próximo microtask (evita ExpressionChangedAfterChecked).
    await Promise.resolve();
    fixture.detectChanges();

    const input: HTMLInputElement = fixture.nativeElement.querySelector('input.search-input');
    expect(input.value).toBe('lapiz');
  });

  it('debería actualizar el signal value cuando el usuario escribe', async () => {
    fixture.detectChanges();

    const input: HTMLInputElement = fixture.nativeElement.querySelector('input.search-input');
    input.value = 'goma';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();

    expect(component.value()).toBe('goma');
  });

  it('debería emitir valueChange cuando el usuario escribe (model two-way binding)', async () => {
    fixture.detectChanges();

    let emitted: string | undefined;
    component.value.subscribe((v) => (emitted = v));

    const input: HTMLInputElement = fixture.nativeElement.querySelector('input.search-input');
    input.value = 'birome';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();

    expect(emitted).toBe('birome');
  });

  it('debería limpiar el valor al hacer click en el botón de limpiar', () => {
    fixture.componentRef.setInput('value', 'cartuchera');
    fixture.detectChanges();

    const clearBtn: HTMLButtonElement = fixture.nativeElement.querySelector('.search-clear');
    clearBtn.click();
    fixture.detectChanges();

    expect(component.value()).toBe('');
    expect(fixture.nativeElement.querySelector('.search-clear')).toBeNull();
  });
});
