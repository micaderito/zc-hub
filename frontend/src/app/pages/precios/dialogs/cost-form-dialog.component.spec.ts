import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { QueryClient, provideTanStackQuery } from '@tanstack/angular-query-experimental';
import { DiscountProfile, PreviewRow, PricingService } from '../../../core/services/pricing.service';
import { PreciosStore } from '../precios.store';
import { CostFormDialogComponent, inheritedDiscountLabel } from './cost-form-dialog.component';

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const PC_PROFILES: DiscountProfile[] = [
  { id: 1, supplierKey: 'pc', name: 'General', discount1: 25, discount2: 5, isDefault: true, productCount: 0 },
  { id: 2, supplierKey: 'pc', name: 'Agendas', discount1: 30, discount2: 5, isDefault: false, productCount: 0 },
];
const SUPPLIERS = [
  { key: 'pc', name: 'Punto Cero', productCount: 0, profiles: PC_PROFILES },
  { key: 'bic', name: 'Bic', productCount: 0, profiles: [] },
];

describe('inheritedDiscountLabel', () => {
  it('dice cuál config se aplica sin una propia: la del pack, si no la default, si no ninguna', () => {
    expect(inheritedDiscountLabel(PC_PROFILES, 2)).toBe('La del pack (Agendas · −30% −5%)');
    expect(inheritedDiscountLabel(PC_PROFILES, null)).toBe('La default del proveedor (General · −25% −5%)');
    expect(inheritedDiscountLabel(PC_PROFILES, 99)).toBe('La default del proveedor (General · −25% −5%)');
    expect(inheritedDiscountLabel([], null)).toBe('Sin descuento (el proveedor no tiene configs)');
  });
});

describe('CostFormDialogComponent', () => {
  let pricing: { getProductSuppliers: jasmine.Spy; saveCost: jasmine.Spy };

  beforeEach(() => {
    pricing = {
      getProductSuppliers: jasmine.createSpy('getProductSuppliers').and.returnValue(of({
        suppliers: [], bySku: {},
        byPack: { '7': [{ supplierKey: 'pc', profileId: 2 }] },
        packBySku: { 'AG-ROSA': 7, 'AG-AZUL': 7 },
      })),
      saveCost: jasmine.createSpy('saveCost').and.returnValue(of({})),
    };
    const store = {
      suppliers: signal(SUPPLIERS), currentSupplier: signal(null),
      close: jasmine.createSpy('close'), markChanged: () => {}, refreshAll: () => Promise.resolve(),
    };
    TestBed.configureTestingModule({
      imports: [CostFormDialogComponent],
      providers: [
        { provide: PricingService, useValue: pricing },
        { provide: PreciosStore, useValue: store },
        provideTanStackQuery(new QueryClient({ defaultOptions: { queries: { retry: false } } })),
      ],
    });
  });

  async function create(inputs: Record<string, unknown>) {
    const fixture = TestBed.createComponent(CostFormDialogComponent);
    for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
    return fixture;
  }

  const firstOption = (el: HTMLElement) => el.querySelectorAll('select')[1]?.querySelector('option')?.textContent?.trim();

  it('un modelo de un pack con config para ese proveedor muestra "La del pack (…)"', async () => {
    const fixture = await create({ prefill: { skus: ['AG-ROSA'], label: 'Agenda', supplierKey: 'pc' } });
    expect(fixture.componentInstance.inheritedLabel()).toBe('La del pack (Agendas · −30% −5%)');
    expect(firstOption(fixture.nativeElement)).toBe('La del pack (Agendas · −30% −5%)');
  });

  it('un SKU suelto (o un pack sin config de ese proveedor) muestra la default del proveedor', async () => {
    const fixture = await create({ prefill: { skus: ['LAP'], label: null, supplierKey: 'pc' } });
    expect(fixture.componentInstance.inheritedLabel()).toBe('La default del proveedor (General · −25% −5%)');
    fixture.componentInstance.update('supplierKey', 'bic');
    expect(fixture.componentInstance.inheritedLabel()).toBe('Sin descuento (el proveedor no tiene configs)');
  });

  it('con una fila de la planilla usa su pack', async () => {
    const row = {
      sku: 'X-1', label: null, bulkPrice: 1000, bulkQty: 10, unitCost: 100, supplierKey: 'pc', suppliers: ['pc'],
      discount: { profileId: 2, name: 'Agendas', discount1: 30, discount2: 5, level: 'pack' },
      pack: { packId: 7, name: 'Agendas', sku: null, unitCount: 4, mode: 'assorted', modelCount: 2 },
    } as unknown as PreviewRow;
    const fixture = await create({ row });
    expect(fixture.componentInstance.form().profileId).toBeNull();
    expect(fixture.componentInstance.inheritedLabel()).toBe('La del pack (Agendas · −30% −5%)');
  });

  it('carga masiva: mismo costo para todos, cada uno con su nombre y sin tocar su config', async () => {
    const fixture = await create({
      prefill: { skus: ['A', 'B'], label: null, supplierKey: 'pc', bulkLabels: { A: 'Agenda', B: null } },
    });
    const c = fixture.componentInstance;
    const el: HTMLElement = fixture.nativeElement;
    expect(c.form().profileId).toBe('keep');
    expect(el.textContent).toContain('Se carga el mismo costo a los 2 productos seleccionados');
    expect(el.textContent).not.toContain('Nombre (opcional)');
    expect(firstOption(el)).toBe('Mantener la de cada uno');

    c.update('bulkPrice', 1000);
    c.update('bulkQty', 10);
    await c.save();
    const calls = pricing.saveCost.calls.allArgs();
    expect(calls.map(([sku, body]) => [sku, body.label, 'profileId' in body])).toEqual([['A', 'Agenda', false], ['B', null, false]]);
    expect(calls[0][1]).toEqual(jasmine.objectContaining({ bulkPrice: 1000, bulkQty: 10, supplierKey: 'pc' }));

    pricing.saveCost.calls.reset();
    c.update('profileId', 2);
    await c.save();
    expect(pricing.saveCost.calls.allArgs().every(([, body]) => body.profileId === 2)).toBeTrue();
  });
});
