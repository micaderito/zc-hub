import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { QueryClient, provideTanStackQuery } from '@tanstack/angular-query-experimental';
import { PricingService } from '../../../core/services/pricing.service';
import { ProductSupplierDialogComponent, supplierChipLabel } from './product-supplier-dialog.component';

const SUPPLIERS = [
  { key: 'pc', name: 'Punto Cero', profiles: [
    { id: 1, supplierKey: 'pc', name: 'General', discount1: 25, discount2: 5, isDefault: true },
    { id: 2, supplierKey: 'pc', name: 'Agendas', discount1: 30, discount2: 5, isDefault: false },
  ] },
  { key: 'bic', name: 'Bic', profiles: [{ id: 9, supplierKey: 'bic', name: 'Sin descuento', discount1: 0, discount2: 0, isDefault: true }] },
  { key: 'filgo', name: 'Filgo', profiles: [
    { id: 20, supplierKey: 'filgo', name: 'General', discount1: 0, discount2: 0, isDefault: true },
    { id: 21, supplierKey: 'filgo', name: 'Promo', discount1: 10, discount2: 0, isDefault: false },
  ] },
];
const AGENDAS = { profileId: 2, name: 'Agendas', discount1: 30, discount2: 5, level: 'pack' as const };
const info = (o = {}) => ({ vigente: 'pc', suppliers: ['pc'], cost: null, discount: AGENDAS, ...o });

describe('supplierChipLabel', () => {
  it('arma "proveedor · config" y suma "+N" con otros proveedores; null sin proveedor', () => {
    expect(supplierChipLabel(info(), SUPPLIERS)).toBe('Punto Cero · Agendas');
    expect(supplierChipLabel(info({ suppliers: ['pc', 'bic'] }), SUPPLIERS)).toBe('Punto Cero · Agendas +1');
    expect(supplierChipLabel(info({ vigente: null, suppliers: [] }), SUPPLIERS)).toBeNull();
    expect(supplierChipLabel(null, SUPPLIERS)).toBeNull();
  });
});

describe('ProductSupplierDialogComponent', () => {
  let pricing: { setProductSupplier: jasmine.Spy; removeProductSupplier: jasmine.Spy };

  beforeEach(() => {
    pricing = {
      setProductSupplier: jasmine.createSpy('set').and.returnValue(of({ ok: true, targets: [], changedSkus: [] })),
      removeProductSupplier: jasmine.createSpy('remove').and.returnValue(of({ ok: true, targets: [], changedSkus: [], lostVigente: [] })),
    };
    TestBed.configureTestingModule({
      imports: [ProductSupplierDialogComponent],
      providers: [{ provide: PricingService, useValue: pricing }, provideTanStackQuery(new QueryClient())],
    });
  });

  function create(inputs: Record<string, unknown>) {
    const fixture = TestBed.createComponent(ProductSupplierDialogComponent);
    for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
    fixture.detectChanges();
    return fixture;
  }

  const state = (c: ProductSupplierDialogComponent) => Object.fromEntries(c.rows().map((r) => [r.supplierKey, r.state]));

  it('lista todos los proveedores, tildados los del producto (arriba) con su config, y el vigente marcado', () => {
    const c = create({
      suppliers: SUPPLIERS, skus: ['AG-1'],
      info: info({
        suppliers: ['pc', 'filgo'],
        discounts: { pc: AGENDAS, filgo: { profileId: 20, name: 'General', discount1: 0, discount2: 0, level: 'default' } },
      }),
    }).componentInstance;
    expect(c.rows().map((r) => r.supplierKey)).toEqual(['pc', 'filgo', 'bic']);
    expect(state(c)).toEqual({ pc: 'on', filgo: 'on', bic: 'off' });
    expect(c.onRows().map((r) => r.profileId)).toEqual([2, 20]);
    expect(c.vigente()).toBe('pc');
  });

  it('"sin proveedor": tildar uno y guardar lo guarda (antes se mandaba la lista vacía)', async () => {
    const c = create({ suppliers: SUPPLIERS, skus: ['X'] }).componentInstance;
    expect(c.onRows()).toEqual([]);
    c.toggle('bic');
    expect(c.vigente()).toBe('bic');
    await c.save();
    expect(pricing.setProductSupplier).toHaveBeenCalledWith({
      skus: ['X'], packId: null, supplierKey: 'bic', suppliers: [{ supplierKey: 'bic', profileId: 9 }],
    });
  });

  it('se pueden tildar varios de una; destildar el vigente pasa el vigente al siguiente', async () => {
    const fixture = create({ suppliers: SUPPLIERS, skus: ['AG-1', 'AG-2'], packId: 7, info: info() });
    const c = fixture.componentInstance;
    const closed = jasmine.createSpy('closed');
    c.closed.subscribe(closed);
    c.toggle('bic');
    c.toggle('filgo');
    c.setRowProfile('filgo', 21);
    c.toggle('pc');
    expect(c.vigente()).toBe('bic');
    expect(c.removedNames()).toEqual(['Punto Cero']);
    await c.save();
    expect(pricing.setProductSupplier).toHaveBeenCalledWith({
      skus: ['AG-1', 'AG-2'], packId: 7, supplierKey: 'bic',
      suppliers: [{ supplierKey: 'bic', profileId: 9 }, { supplierKey: 'filgo', profileId: 21 }],
    });
    expect(closed).toHaveBeenCalled();
  });

  it('la lista es de checkboxes: el tilde se ve y el click lo cambia', () => {
    const fixture = create({ suppliers: SUPPLIERS, skus: ['X'] });
    const el: HTMLElement = fixture.nativeElement;
    const boxes = () => Array.from(el.querySelectorAll<HTMLButtonElement>('[role="checkbox"]'));
    expect(boxes().map((b) => b.getAttribute('aria-checked'))).toEqual(['false', 'false', 'false']);
    boxes()[1].click();
    fixture.detectChanges();
    expect(boxes()[1].getAttribute('aria-checked')).toBe('true');
    expect(el.querySelectorAll('select').length).toBe(1);
    expect(el.querySelector('input[type="radio"]')).not.toBeNull();
  });

  it('si el vigente nuevo no tiene precio de lista, avisa y queda abierto', async () => {
    pricing.setProductSupplier.and.returnValue(of({ ok: true, targets: [], changedSkus: [], withoutPrice: ['AG-1'] }));
    const c = create({ suppliers: SUPPLIERS, skus: ['AG-1'], info: info({ suppliers: ['pc', 'bic'] }) }).componentInstance;
    const closed = jasmine.createSpy('closed');
    c.closed.subscribe(closed);
    c.vigente.set('bic');
    await c.save();
    expect(c.result()).toContain('sin precio de lista de Bic');
    expect(closed).not.toHaveBeenCalled();
  });

  describe('varios productos', () => {
    const BY_SKU = {
      A: info({ suppliers: ['pc', 'bic'] }),
      B: info({ suppliers: ['pc'] }),
    };

    it('los que tienen todos van tildados, los de algunos a medias, y el vigente arranca en "no cambiar"', () => {
      const c = create({ suppliers: SUPPLIERS, skus: ['A', 'B'], bulk: true, bySku: BY_SKU }).componentInstance;
      expect(state(c)).toEqual({ pc: 'on', bic: 'mixed', filgo: 'off' });
      expect(c.rows().find((r) => r.supplierKey === 'bic')!.count).toBe(1);
      expect(c.vigente()).toBeNull();
    });

    it('un proveedor a medias da la vuelta: a medias → todos → ninguno → a medias', () => {
      const c = create({ suppliers: SUPPLIERS, skus: ['A', 'B'], bulk: true, bySku: BY_SKU }).componentInstance;
      const bic = () => c.rows().find((r) => r.supplierKey === 'bic')!.state;
      c.toggle('bic'); expect(bic()).toBe('on');
      c.toggle('bic'); expect(bic()).toBe('off');
      c.toggle('bic'); expect(bic()).toBe('mixed');
    });

    it('sin tocar nada no manda nada', async () => {
      const c = create({ suppliers: SUPPLIERS, skus: ['A', 'B'], bulk: true, bySku: BY_SKU }).componentInstance;
      await c.save();
      expect(pricing.setProductSupplier).not.toHaveBeenCalled();
      expect(pricing.removeProductSupplier).not.toHaveBeenCalled();
    });

    it('suma varios a la vez, saca otro y deja el vigente elegido para el final', async () => {
      const fixture = create({ suppliers: SUPPLIERS, skus: ['A', 'B'], bulk: true, bySku: BY_SKU });
      const c = fixture.componentInstance;
      const saved = jasmine.createSpy('saved');
      c.saved.subscribe(saved);
      c.toggle('filgo');           // se suma a todos, con la default
      c.toggle('bic'); c.toggle('bic'); // a medias → todos → ninguno: se saca
      c.vigente.set('pc');         // ya lo tienen todos: solo pasa a vigente, sin tocar su config
      await c.save();
      expect(pricing.removeProductSupplier).toHaveBeenCalledWith({ skus: ['A', 'B'], packId: null, bulk: true, supplierKey: 'bic' });
      const calls = pricing.setProductSupplier.calls.allArgs().map((a) => a[0]);
      expect(calls).toEqual([
        { skus: ['A', 'B'], packId: null, bulk: true, supplierKey: 'filgo', profileId: 20, makeVigente: false },
        { skus: ['A', 'B'], packId: null, bulk: true, supplierKey: 'pc', keepProfile: true },
      ]);
      expect(saved).toHaveBeenCalled();
    });

    it('cambiar la config de uno que ya tienen todos la aplica a todos', async () => {
      const c = create({ suppliers: SUPPLIERS, skus: ['A', 'B'], bulk: true, bySku: BY_SKU }).componentInstance;
      c.setRowProfile('pc', 2);
      await c.save();
      expect(pricing.setProductSupplier).toHaveBeenCalledOnceWith({
        skus: ['A', 'B'], packId: null, bulk: true, supplierKey: 'pc', profileId: 2, makeVigente: false,
      });
    });

    it('sacar uno avisa los que quedaron sin vigente', async () => {
      pricing.removeProductSupplier.and.returnValue(of({ ok: true, targets: [], changedSkus: ['A'], lostVigente: ['A'] }));
      const c = create({ suppliers: SUPPLIERS, skus: ['A', 'B'], bulk: true, bySku: BY_SKU }).componentInstance;
      c.toggle('pc');
      await c.save();
      expect(pricing.removeProductSupplier).toHaveBeenCalledWith({ skus: ['A', 'B'], packId: null, bulk: true, supplierKey: 'pc' });
      expect(c.result()).toContain('quedó sin vigente');
    });
  });
});
