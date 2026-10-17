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

  it('arranca con todos los proveedores del producto, cada uno con su config, y el vigente marcado', () => {
    const c = create({
      suppliers: SUPPLIERS, skus: ['AG-1'],
      info: info({
        suppliers: ['pc', 'filgo'],
        discounts: { pc: AGENDAS, filgo: { profileId: 20, name: 'General', discount1: 0, discount2: 0, level: 'default' } },
      }),
    }).componentInstance;
    expect(c.rows()).toEqual([{ supplierKey: 'pc', profileId: 2 }, { supplierKey: 'filgo', profileId: 20 }]);
    expect(c.vigente()).toBe('pc');
    expect(c.available().map((s) => s.key)).toEqual(['bic']);
  });

  it('agregar uno, sacar el vigente y guardar manda la lista completa con el nuevo vigente', async () => {
    const fixture = create({ suppliers: SUPPLIERS, skus: ['AG-1', 'AG-2'], packId: 7, info: info() });
    const c = fixture.componentInstance;
    const closed = jasmine.createSpy('closed');
    c.closed.subscribe(closed);
    c.toAdd.set('bic');
    c.addRow();
    c.removeRow('pc');
    expect(c.vigente()).toBe('bic');
    expect(c.removedNames()).toEqual(['Punto Cero']);
    await c.save();
    expect(pricing.setProductSupplier).toHaveBeenCalledWith({
      skus: ['AG-1', 'AG-2'], packId: 7, supplierKey: 'bic', suppliers: [{ supplierKey: 'bic', profileId: 9 }],
    });
    expect(closed).toHaveBeenCalled();
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

  it('sin proveedores arranca vacío; el primero que se agrega queda de vigente', () => {
    const c = create({ suppliers: SUPPLIERS, skus: ['X'] }).componentInstance;
    expect(c.rows()).toEqual([]);
    c.addRow();
    expect(c.rows()).toEqual([{ supplierKey: 'pc', profileId: 1 }]);
    expect(c.vigente()).toBe('pc');
  });

  it('masivo, agregar: manda bulk y, sin tildar vigente, makeVigente false', async () => {
    const fixture = create({ suppliers: SUPPLIERS, skus: ['A', 'B', 'C'], bulk: true });
    const c = fixture.componentInstance;
    const saved = jasmine.createSpy('saved');
    c.saved.subscribe(saved);
    c.makeVigente.set(false);
    await c.save();
    expect(pricing.setProductSupplier).toHaveBeenCalledWith({
      skus: ['A', 'B', 'C'], packId: null, supplierKey: 'pc', profileId: 1, bulk: true, makeVigente: false,
    });
    expect(saved).toHaveBeenCalled();
  });

  it('masivo, quitar: llama a removeProductSupplier y avisa los que quedaron sin vigente', async () => {
    pricing.removeProductSupplier.and.returnValue(of({ ok: true, targets: [], changedSkus: ['A'], lostVigente: ['A'] }));
    const c = create({ suppliers: SUPPLIERS, skus: ['A', 'B'], bulk: true }).componentInstance;
    c.bulkMode.set('remove');
    c.setSupplier('bic');
    await c.save();
    expect(pricing.removeProductSupplier).toHaveBeenCalledWith({ skus: ['A', 'B'], packId: null, supplierKey: 'bic', bulk: true });
    expect(c.result()).toContain('quedó sin vigente');
  });
});
