import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { provideTanStackQuery, QueryClient } from '@tanstack/angular-query-experimental';
import { DepositoComponent } from './deposito.component';
import { DepositoService } from '../../core/services/deposito.service';
import { MappingService } from '../../core/services/mapping.service';
import { SessionService } from '../../core/services/session.service';

describe('DepositoComponent — autocomplete de SKU', () => {
  function setup() {
    TestBed.configureTestingModule({
      imports: [DepositoComponent],
      providers: [
        provideTanStackQuery(new QueryClient({ defaultOptions: { queries: { retry: false } } })),
        { provide: DepositoService, useValue: { getAll: () => of({ items: [] }) } },
        {
          provide: MappingService,
          useValue: {
            getMercadoLibreSources: () => of([{ sku: '39000', label: 'Cuaderno rayado', thumbnail: null }]),
            getTiendaNubeSources: () => of([]),
          },
        },
        { provide: SessionService, useValue: { isAdmin: () => true, isReadOnly: () => false } },
      ],
    });
    const fixture = TestBed.createComponent(DepositoComponent);
    const c = fixture.componentInstance;
    c.catalogOptions.set([{ sku: '39000', label: 'Cuaderno rayado', thumbnail: null }]);
    c.showForm.set(true);
    fixture.detectChanges();
    return { fixture, c };
  }

  it('elige la opción en pointerdown (el toque no se pierde por el blur) y no saca el foco', () => {
    const { fixture, c } = setup();
    c.onSkuQueryChange('cuad');
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector('.sku-result') as HTMLButtonElement;
    expect(btn).toBeTruthy();

    const ev = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
    btn.dispatchEvent(ev);
    fixture.detectChanges();

    expect(ev.defaultPrevented).toBeTrue();
    expect(c.form().sku).toBe('39000');
    expect(c.form().label).toBe('Cuaderno rayado');
    expect(c.skuDropdownOpen()).toBeFalse();
  });

  it('ignora el botón derecho del mouse', () => {
    const { c } = setup();
    const ev = new PointerEvent('pointerdown', { cancelable: true, button: 2 });
    c.onSkuResultPointerDown(ev, { sku: '39000', label: 'Cuaderno rayado', thumbnail: null });
    expect(c.form().sku).toBe('');
    expect(ev.defaultPrevented).toBeFalse();
  });
});
