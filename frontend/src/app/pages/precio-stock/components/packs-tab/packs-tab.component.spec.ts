import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { QueryClient, provideTanStackQuery } from '@tanstack/angular-query-experimental';
import { Pack, PacksService } from '../../../../core/services/packs.service';
import { ConflictsService } from '../../../../core/services/conflicts.service';
import { PricingService } from '../../../../core/services/pricing.service';
import { SessionService } from '../../../../core/services/session.service';
import { PacksTabComponent } from './packs-tab.component';

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const SUPPLIERS = [
  { key: 'pc', name: 'Punto Cero', profiles: [
    { id: 1, supplierKey: 'pc', name: 'General', discount1: 25, discount2: 5, isDefault: true },
    { id: 2, supplierKey: 'pc', name: 'Agendas', discount1: 30, discount2: 5, isDefault: false },
  ] },
  { key: 'bic', name: 'Bic', profiles: [{ id: 9, supplierKey: 'bic', name: 'Sin descuento', discount1: 0, discount2: 0, isDefault: true }] },
];

const AGENDAS: Pack = {
  id: 7, name: 'Agendas 2027', sku: null, unitCount: 4, mode: 'assorted',
  products: [{ sku: 'AG-ROSA', label: 'Agenda rosa', stockMl: 1, stockTn: 1 } as Pack['products'][number]],
};
const EMPTY: Pack = { id: 8, name: 'Resaltadores', sku: null, unitCount: 6, mode: 'assorted', products: [] };

describe('PacksTabComponent', () => {
  let packs: { getPacksPromise: jasmine.Spy; createPack: jasmine.Spy; updatePack: jasmine.Spy; setSkuPack: jasmine.Spy; deletePack: jasmine.Spy };
  let pricing: { getProductSuppliers: jasmine.Spy; setProductSupplier: jasmine.Spy };

  beforeEach(() => {
    packs = {
      getPacksPromise: jasmine.createSpy('getPacks').and.resolveTo({ packs: [AGENDAS, EMPTY] }),
      createPack: jasmine.createSpy('createPack').and.resolveTo(12),
      updatePack: jasmine.createSpy('updatePack').and.resolveTo(),
      setSkuPack: jasmine.createSpy('setSkuPack').and.resolveTo(),
      deletePack: jasmine.createSpy('deletePack').and.resolveTo(),
    };
    pricing = {
      getProductSuppliers: jasmine.createSpy('getProductSuppliers').and.returnValue(of({
        suppliers: SUPPLIERS,
        bySku: { 'AG-ROSA': { vigente: 'pc', suppliers: ['pc'], cost: null,
          discount: { profileId: 2, name: 'Agendas', discount1: 30, discount2: 5, level: 'pack' } } },
        byPack: { '7': [{ supplierKey: 'pc', profileId: 2 }], '8': [{ supplierKey: 'bic', profileId: null }] },
        packBySku: { 'AG-ROSA': 7 },
      })),
      setProductSupplier: jasmine.createSpy('setProductSupplier').and.returnValue(of({ ok: true, targets: [], changedSkus: [] })),
    };
    TestBed.configureTestingModule({
      imports: [PacksTabComponent],
      providers: [
        { provide: PacksService, useValue: packs },
        { provide: PricingService, useValue: pricing },
        { provide: ConflictsService, useValue: { getAnalysisPromise: () => Promise.resolve({ matched: [] }) } },
        { provide: SessionService, useValue: { isAdmin: () => true } },
        provideTanStackQuery(new QueryClient({ defaultOptions: { queries: { retry: false } } })),
      ],
    });
  });

  async function create() {
    const fixture = TestBed.createComponent(PacksTabComponent);
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
    return fixture;
  }

  describe('alta de pack', () => {
    it('el form trae la lista de proveedores; crear con uno tildado lo guarda en el pack nuevo', async () => {
      const fixture = await create();
      const c = fixture.componentInstance;
      c.toggleNewPackForm();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.new-pack-form zc-supplier-picker')).not.toBeNull();
      const picker = c.newPackPicker()!;
      picker.toggle('pc');
      picker.setRowProfile('pc', 2);
      c.newPackName = 'Agendas 2028';
      await c.createPack();
      expect(packs.createPack).toHaveBeenCalled();
      expect(pricing.setProductSupplier).toHaveBeenCalledOnceWith({
        skus: [], packId: 12, supplierKey: 'pc', suppliers: [{ supplierKey: 'pc', profileId: 2 }],
      });
      expect(c.showNewPackForm()).toBeFalse();
    });

    it('"sin proveedor" (nada tildado) no toca proveedores', async () => {
      const c = (await create()).componentInstance;
      c.toggleNewPackForm();
      c.newPackName = 'Suelto';
      await c.createPack();
      expect(packs.createPack).toHaveBeenCalled();
      expect(pricing.setProductSupplier).not.toHaveBeenCalled();
    });

    it('si falla el proveedor, el pack queda creado y se avisa', async () => {
      pricing.setProductSupplier.and.returnValue(throwError(() => ({ error: { error: 'boom' } })));
      const c = (await create()).componentInstance;
      c.toggleNewPackForm();
      c.newPackPicker()!.toggle('bic');
      c.newPackName = 'Bic x6';
      await c.createPack();
      expect(c.showNewPackForm()).toBeFalse();
      expect(c.supplierNotice()).toContain('El pack se creó, pero no se pudo guardar el proveedor: boom');
    });
  });

  describe('edición de pack', () => {
    it('arranca con los proveedores del pack y su config', async () => {
      const c = (await create()).componentInstance;
      c.startEditPack(AGENDAS);
      const picker = c.editPicker()!;
      expect(picker.onRows().map((r) => [r.supplierKey, r.profileId])).toEqual([['pc', 2]]);
      expect(picker.vigente()).toBe('pc');
    });

    it('sin tocar los proveedores, guardar no los manda', async () => {
      const c = (await create()).componentInstance;
      c.startEditPack(AGENDAS);
      c.editName = 'Agendas 2027 (nuevas)';
      await c.saveEditPack(AGENDAS);
      expect(packs.updatePack).toHaveBeenCalled();
      expect(pricing.setProductSupplier).not.toHaveBeenCalled();
    });

    it('cambiar la config o sumar un proveedor se guarda en el pack', async () => {
      const c = (await create()).componentInstance;
      c.startEditPack(AGENDAS);
      c.editPicker()!.setRowProfile('pc', 1);
      c.editPicker()!.toggle('bic');
      await c.saveEditPack(AGENDAS);
      expect(pricing.setProductSupplier).toHaveBeenCalledOnceWith({
        skus: [], packId: 7, supplierKey: 'pc',
        suppliers: [{ supplierKey: 'pc', profileId: 1 }, { supplierKey: 'bic', profileId: 9 }],
      });
    });

    it('un pack sin modelos toma lo asignado al pack mismo (y su chip lo muestra)', async () => {
      const c = (await create()).componentInstance;
      expect(c.packSupplierLabel(EMPTY)).toBe('Bic · Sin descuento');
      c.startEditPack(EMPTY);
      expect(c.editPicker()!.onRows().map((r) => r.supplierKey)).toEqual(['bic']);
    });
  });

  it('el ícono de proveedor ya no está deshabilitado en un pack sin modelos', async () => {
    const fixture = await create();
    const btns = Array.from(fixture.nativeElement.querySelectorAll('button[title="Proveedor y descuento"]')) as HTMLButtonElement[];
    expect(btns.length).toBe(2);
    expect(btns.every((b) => !b.disabled)).toBeTrue();
  });
});
