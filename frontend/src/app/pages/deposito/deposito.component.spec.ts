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
        { provide: DepositoService, useValue: { getAll: () => of({ items: [] }), getMovements: () => of({ movements: [] }) } },
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

describe('DepositoComponent — lista del celular, hoja de detalle e historial', () => {
  const items = [
    { id: 1, sku: '39000', label: 'Cuaderno rayado', itemType: 'producto', quantity: 3, unit: 'unidades', notes: 'Caja 3', createdAt: null, updatedAt: null },
    { id: 2, sku: null, label: 'Burbupack', itemType: 'embalaje', quantity: 0, unit: 'rollos', notes: null, createdAt: null, updatedAt: null },
  ];

  function setup() {
    const deposito = {
      getAll: jasmine.createSpy('getAll').and.returnValue(of({ items })),
      getMovements: jasmine.createSpy('getMovements').and.returnValue(of({
        movements: [{ id: 9, itemId: 1, kind: 'ajuste', delta: -2, quantityAfter: 3, label: 'Cuaderno rayado', unit: 'unidades', actor: 'mica', createdAt: new Date().toISOString() }],
      })),
      adjust: jasmine.createSpy('adjust').and.returnValue(of({ ok: true })),
      delete: jasmine.createSpy('delete').and.returnValue(of({ ok: true })),
    };
    TestBed.configureTestingModule({
      imports: [DepositoComponent],
      providers: [
        provideTanStackQuery(new QueryClient({ defaultOptions: { queries: { retry: false } } })),
        { provide: DepositoService, useValue: deposito },
        { provide: MappingService, useValue: { getMercadoLibreSources: () => of([]), getTiendaNubeSources: () => of([]) } },
        { provide: SessionService, useValue: { isAdmin: () => true, isReadOnly: () => false } },
      ],
    });
    const fixture = TestBed.createComponent(DepositoComponent);
    return { fixture, c: fixture.componentInstance, deposito };
  }

  async function ready(fixture: ReturnType<typeof setup>['fixture']) {
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 20));
    fixture.detectChanges();
  }

  it('agrupa la lista en Productos y Embalaje, con la cantidad a la derecha', async () => {
    const { fixture } = setup();
    await ready(fixture);
    const el: HTMLElement = fixture.nativeElement;
    const heads = Array.from(el.querySelectorAll('.dp-group-h')).map((h) => Array.from(h.querySelectorAll('span')).map((x) => x.textContent!.trim()));
    expect(heads).toEqual([['Productos · 1', '3 u.'], ['Embalaje · 1']]);
    const rows = el.querySelectorAll('.dp-row');
    expect(rows[0].querySelector('.dp-row-sub')!.textContent).toContain('39000 · Caja 3');
    expect(rows[1].querySelector('.dp-row-qty')!.classList).toContain('zero');
  });

  it('tocar una fila abre la hoja con el +/−, los atajos y el historial', async () => {
    const { fixture, deposito } = setup();
    await ready(fixture);
    (fixture.nativeElement.querySelector('.dp-row') as HTMLButtonElement).click();
    await ready(fixture);
    const sheet: HTMLElement = fixture.nativeElement.querySelector('.dp-detail');
    expect(sheet.querySelector('.dp-big-val b')!.textContent).toBe('3');
    expect(Array.from(sheet.querySelectorAll('.dp-quick button')).map((b) => b.textContent!.trim())).toEqual(['−10', '−5', '+5', '+10']);
    expect(deposito.getMovements).toHaveBeenCalledWith(1);
    expect(sheet.querySelector('zc-deposito-history .dh-desc b')!.textContent).toBe('Restado a mano');
  });

  it('restar más de lo que hay se manda igual (el backend lo deja en 0); con 0 no se resta', async () => {
    const { fixture, c, deposito } = setup();
    await ready(fixture);
    await c.adjust(c.items()[0], -5);
    expect(deposito.adjust).toHaveBeenCalledWith(1, -5);
    deposito.adjust.calls.reset();
    await c.adjust(c.items()[1], -1);
    expect(deposito.adjust).not.toHaveBeenCalled();
  });

  it('borrar pide confirmación y cierra la hoja', async () => {
    const { fixture, c, deposito } = setup();
    await ready(fixture);
    c.openDetail(c.items()[0]);
    c.confirmDelete.set(c.items()[0]);
    expect(deposito.delete).not.toHaveBeenCalled();
    await c.remove(c.items()[0]);
    expect(deposito.delete).toHaveBeenCalledWith(1);
    expect(c.detailId()).toBeNull();
    expect(c.confirmDelete()).toBeNull();
  });

  it('el relojito de la tabla abre el historial de esa fila', async () => {
    const { fixture, deposito } = setup();
    await ready(fixture);
    (fixture.nativeElement.querySelector('.dp-table button[title="Historial"]') as HTMLButtonElement).click();
    await ready(fixture);
    expect(deposito.getMovements).toHaveBeenCalledWith(1);
    expect(fixture.nativeElement.querySelector('.modal-head h2')!.textContent).toContain('Historial');
  });
});
