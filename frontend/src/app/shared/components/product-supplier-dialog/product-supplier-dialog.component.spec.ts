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
];
const info = (o = {}) => ({
  vigente: 'pc', suppliers: ['pc'], cost: null,
  discount: { profileId: 2, name: 'Agendas', discount1: 30, discount2: 5, level: 'pack' as const }, ...o,
});

describe('supplierChipLabel', () => {
  it('arma "proveedor · config" y suma "+N" con otros proveedores; null sin proveedor', () => {
    expect(supplierChipLabel(info(), SUPPLIERS)).toBe('Punto Cero · Agendas');
    expect(supplierChipLabel(info({ suppliers: ['pc', 'bic'] }), SUPPLIERS)).toBe('Punto Cero · Agendas +1');
    expect(supplierChipLabel(info({ vigente: null, suppliers: [] }), SUPPLIERS)).toBeNull();
    expect(supplierChipLabel(null, SUPPLIERS)).toBeNull();
  });
});

describe('ProductSupplierDialogComponent', () => {
  let pricing: { setProductSupplier: jasmine.Spy };

  beforeEach(() => {
    pricing = { setProductSupplier: jasmine.createSpy('set').and.returnValue(of({ ok: true, targets: [], changedSkus: [] })) };
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

  it('arranca con el proveedor y la config actuales del producto', () => {
    const c = create({ suppliers: SUPPLIERS, skus: ['AG-1'], info: info() }).componentInstance;
    expect(c.supplierKey()).toBe('pc');
    expect(c.profileId()).toBe(2);
  });

  it('cambiar de proveedor precarga su default; guardar manda SKUs, pack y config', async () => {
    const fixture = create({ suppliers: SUPPLIERS, skus: ['AG-1', 'AG-2'], packId: 7, info: info() });
    const c = fixture.componentInstance;
    const closed = jasmine.createSpy('closed');
    c.closed.subscribe(closed);
    c.setSupplier('bic');
    expect(c.profileId()).toBe(9);
    await c.save();
    expect(pricing.setProductSupplier).toHaveBeenCalledWith({ skus: ['AG-1', 'AG-2'], packId: 7, supplierKey: 'bic', profileId: 9 });
    expect(closed).toHaveBeenCalled();
  });

  it('en modo masivo manda bulk: true y avisa con saved', async () => {
    const fixture = create({ suppliers: SUPPLIERS, skus: ['A', 'B', 'C'], bulk: true });
    const saved = jasmine.createSpy('saved');
    fixture.componentInstance.saved.subscribe(saved);
    await fixture.componentInstance.save();
    expect(pricing.setProductSupplier).toHaveBeenCalledWith({ skus: ['A', 'B', 'C'], packId: null, supplierKey: 'pc', profileId: 1, bulk: true });
    expect(saved).toHaveBeenCalled();
  });

  it('sin info arranca con el primer proveedor y su default', () => {
    const c = create({ suppliers: SUPPLIERS, skus: ['X'] }).componentInstance;
    expect(c.supplierKey()).toBe('pc');
    expect(c.profileId()).toBe(1);
  });
});
