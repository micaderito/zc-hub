import { Component, LOCALE_ID } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { CurrencyPipe, registerLocaleData } from '@angular/common';
import localeEsAr from '@angular/common/locales/es-AR';
import { CurrencyInputDirective } from './currency-input.directive';

registerLocaleData(localeEsAr, 'es-AR');

@Component({
  standalone: true,
  imports: [FormsModule, CurrencyInputDirective],
  template: `<input type="text" appCurrencyInput [(ngModel)]="value" />`
})
class HostComponent {
  value: number | null = null;
}

describe('CurrencyInputDirective', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;
  let input: HTMLInputElement;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [CurrencyPipe, { provide: LOCALE_ID, useValue: 'es-AR' }]
    });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    input = fixture.nativeElement.querySelector('input');
  });

  function setInputValue(raw: string) {
    input.value = raw;
    input.dispatchEvent(new Event('input'));
  }

  it('muestra el valor formateado como moneda al inicializar', async () => {
    host.value = 1234.5;
    fixture.detectChanges();
    // NgModel escribe el valor inicial en el próximo microtask (evita ExpressionChangedAfterChecked).
    await Promise.resolve();
    fixture.detectChanges();
    expect(input.value).toContain('1.234,50');
  });

  it('muestra el input vacío cuando el valor es null', () => {
    host.value = null;
    fixture.detectChanges();
    expect(input.value).toBe('');
  });

  it('al enfocar muestra el número plano (sin formato) para editar', async () => {
    host.value = 1234.5;
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();
    input.dispatchEvent(new Event('focus'));
    expect(input.value).toBe('1234.5');
  });

  it('al enfocar con valor null deja el input vacío', () => {
    host.value = null;
    fixture.detectChanges();
    input.dispatchEvent(new Event('focus'));
    expect(input.value).toBe('');
  });

  it('al perder el foco formatea de nuevo el número ingresado en formato argentino (coma decimal)', () => {
    fixture.detectChanges();
    input.dispatchEvent(new Event('focus'));
    setInputValue('1.234,56');
    input.dispatchEvent(new Event('blur'));
    fixture.detectChanges();

    expect(host.value).toBe(1234.56);
    expect(input.value).toContain('1.234,56');
  });

  it('acepta formato con punto decimal (1234.56)', () => {
    fixture.detectChanges();
    input.dispatchEvent(new Event('focus'));
    setInputValue('1234.56');
    input.dispatchEvent(new Event('blur'));

    expect(host.value).toBe(1234.56);
  });

  it('formato coma sin parte entera (",56") se interpreta como 0,56', () => {
    fixture.detectChanges();
    input.dispatchEvent(new Event('focus'));
    setInputValue(',56');
    input.dispatchEvent(new Event('blur'));

    expect(host.value).toBe(0.56);
  });

  it('formato coma sin parte decimal ("56,") se interpreta como 56,0', () => {
    fixture.detectChanges();
    input.dispatchEvent(new Event('focus'));
    setInputValue('56,');
    input.dispatchEvent(new Event('blur'));

    expect(host.value).toBe(56);
  });

  it('formato punto sin parte entera (".56") se interpreta como 0.56', () => {
    fixture.detectChanges();
    input.dispatchEvent(new Event('focus'));
    setInputValue('.56');
    input.dispatchEvent(new Event('blur'));

    expect(host.value).toBe(0.56);
  });

  it('formato punto sin parte decimal ("56.") se interpreta como 56.0', () => {
    fixture.detectChanges();
    input.dispatchEvent(new Event('focus'));
    setInputValue('56.');
    input.dispatchEvent(new Event('blur'));

    expect(host.value).toBe(56);
  });

  it('redondea a 2 decimales', () => {
    fixture.detectChanges();
    input.dispatchEvent(new Event('focus'));
    setInputValue('10,999');
    input.dispatchEvent(new Event('blur'));

    expect(host.value).toBe(11);
  });

  it('deja el valor en null cuando el input queda vacío al perder el foco', () => {
    host.value = 100;
    fixture.detectChanges();
    input.dispatchEvent(new Event('focus'));
    setInputValue('   ');
    input.dispatchEvent(new Event('blur'));

    expect(host.value).toBeNull();
  });

  it('ignora números negativos (no actualiza el modelo)', () => {
    fixture.detectChanges();
    input.dispatchEvent(new Event('focus'));
    setInputValue('-5');
    input.dispatchEvent(new Event('blur'));

    expect(host.value).toBeNull();
  });

  it('propaga el valor externo (writeValue) al input cuando no está enfocado', async () => {
    fixture.detectChanges();
    host.value = 555;
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();
    expect(input.value).toContain('555');
  });
});
