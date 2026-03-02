import {
  Directive,
  ElementRef,
  HostListener,
  Inject,
  LOCALE_ID,
  OnInit
} from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { CurrencyPipe } from '@angular/common';

/**
 * Directiva para inputs de moneda: muestra el valor con formato (puntos/miles, coma decimal)
 * usando CurrencyPipe. Al enfocar se muestra el número para editar; al salir se formatea de nuevo.
 * Uso: <input type="text" appCurrencyInput [(ngModel)]="miPrecio" />
 */
@Directive({
  selector: 'input[appCurrencyInput]',
  standalone: true,
  providers: [
    CurrencyPipe,
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: CurrencyInputDirective,
      multi: true
    }
  ]
})
export class CurrencyInputDirective implements ControlValueAccessor, OnInit {
  private value: number | null = null;
  private focused = false;
  private onChange: (value: number | null) => void = () => {};
  private onTouched: () => void = () => {};

  constructor(
    private el: ElementRef<HTMLInputElement>,
    private currencyPipe: CurrencyPipe,
    @Inject(LOCALE_ID) private locale: string
  ) {}

  ngOnInit(): void {
    this.updateDisplay();
  }

  @HostListener('focus')
  onFocus(): void {
    this.focused = true;
    const num = this.value;
    this.el.nativeElement.value = num != null && !isNaN(num) ? String(num) : '';
  }

  @HostListener('blur')
  onBlur(): void {
    this.focused = false;
    this.onTouched();
    this.parseAndUpdate();
    this.updateDisplay();
  }

  writeValue(value: number | null): void {
    this.value = value != null && !isNaN(value) ? value : null;
    if (!this.focused) {
      this.updateDisplay();
    }
  }

  registerOnChange(fn: (value: number | null) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  private updateDisplay(): void {
    const input = this.el.nativeElement;
    if (this.value != null && !isNaN(this.value)) {
      const formatted = this.currencyPipe.transform(
        this.value,
        'ARS',
        'symbol',
        '1.2-2',
        this.locale
      );
      input.value = formatted ?? String(this.value);
    } else {
      input.value = '';
    }
  }

  private parseAndUpdate(): void {
    const raw = this.el.nativeElement.value?.trim().replace(/\s/g, '') ?? '';
    if (!raw) {
      this.value = null;
      this.onChange(null);
      return;
    }
    // Aceptar formato argentino (1.234,56) o con punto decimal (1234.56)
    const commaIdx = raw.lastIndexOf(',');
    const dotIdx = raw.lastIndexOf('.');
    let normalized: string;
    if (commaIdx > dotIdx) {
      const intPart = raw.slice(0, commaIdx).replace(/\./g, '');
      const decPart = raw.slice(commaIdx + 1);
      normalized = (intPart || '0') + '.' + (decPart || '0');
    } else if (dotIdx >= 0) {
      const intPart = raw.slice(0, dotIdx).replace(/,/g, '');
      const decPart = raw.slice(dotIdx + 1);
      normalized = (intPart || '0') + '.' + (decPart || '0');
    } else {
      normalized = raw.replace(/,/g, '');
    }
    const num = parseFloat(normalized);
    if (!isNaN(num) && num >= 0) {
      this.value = Math.round(num * 100) / 100;
      this.onChange(this.value);
    }
  }
}
