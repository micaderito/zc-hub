import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { provideTanStackQuery, QueryClient } from '@tanstack/angular-query-experimental';
import { PreviewRow, PricingConfig, PricingService } from '../../../core/services/pricing.service';
import { PreciosStore } from '../precios.store';
import { PlanillaPhoneComponent, buildPhoneUnits, money, pendingSkus } from './planilla-phone.component';

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const PACK = { packId: 1, name: 'Agenda 2027', sku: '39137', unitCount: 8, mode: 'assorted' as const, modelCount: 2 };

function row(over: Partial<PreviewRow> = {}): PreviewRow {
  return {
    sku: 'A', label: null, source: 'list', bulkQty: 8, unitCost: 1000, valorFinal: 2000, bulkPrice: 8000, unitListPrice: 1000,
    discount: null, supplierKey: 'pc', suppliers: ['pc'],
    tn: { transfer: 2000, list: 2500, override: null, effective: 2500 }, ml: 3000, mlOverride: null, mlEffective: 3000,
    mlNet: 2200, currentMl: 3000, currentTn: 2500, pendingMl: false, pendingTn: false, mlQueued: false,
    freeShipping: false, mappedMl: true, mappedTn: true, name: 'Cuaderno', pack: null, ...over,
  };
}

/** Sube (pack), baja (suelto), en cola y al día. */
function rows(): PreviewRow[] {
  return [
    row({ sku: 'P1', name: 'Floral', pack: PACK, currentTn: 2000, pendingTn: true, currentMl: 2800, pendingMl: true }),
    row({ sku: 'P2', name: 'Liso', pack: PACK, currentTn: 2000, pendingTn: true }),
    row({ sku: 'B', name: 'Block', currentTn: 3000, pendingTn: true }),
    row({ sku: 'Q', name: 'Carpeta', pendingMl: true, mlQueued: true, currentMl: 2900 }),
    row({ sku: 'OK', name: 'Repuesto' }),
  ];
}

describe('planilla del celular: armado', () => {
  it('agrupa por pack y separa sube / baja / en cola / al día', () => {
    const units = buildPhoneUnits(rows());
    const by = (k: string) => units.find((u) => u.key === k)!;
    expect(by('pack:1').section).toBe('up');
    expect(by('pack:1').tn).toEqual(jasmine.objectContaining({ pending: true, from: '$2.000', to: '$2.500' }));
    expect(by('sku:B').section).toBe('down');
    expect(by('sku:Q').section).toBe('queued');
    expect(by('sku:OK').section).toBe('ok');
  });

  it('money arma el rango y descarta lo desconocido', () => {
    expect(money([1000, 1500, 0])).toBe('$1.000–$1.500');
    expect(money([0])).toBe('');
  });

  it('manda solo lo pendiente del canal elegido (lo en cola de ML no)', () => {
    expect(pendingSkus(rows(), 'both')).toEqual(['P1', 'P2', 'B']);
    expect(pendingSkus(rows(), 'ml')).toEqual(['P1']);
  });
});

@Component({ standalone: true, imports: [PlanillaPhoneComponent], providers: [PreciosStore], template: '<zc-planilla-phone />' })
class HostComponent {}

describe('PlanillaPhoneComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let pricing: jasmine.SpyObj<PricingService>;
  let comp: PlanillaPhoneComponent;

  beforeEach(async () => {
    pricing = jasmine.createSpyObj<PricingService>('PricingService', ['getConfig', 'getPreview', 'listApplyRuns', 'apply', 'saveOverrides']);
    pricing.getConfig.and.returnValue(of({ settings: {}, tiers: [], updatedAt: null, suppliers: [] } as unknown as PricingConfig));
    pricing.getPreview.and.returnValue(of({ rows: rows() }));
    pricing.listApplyRuns.and.returnValue(of({ runs: [{ id: 1, createdBy: null, total: 3, createdAt: null, counts: { ml: { failed: 2 }, tn: { ok: 3 } } }], total: 1 }));
    pricing.apply.and.returnValue(of({ runId: 2, total: 3, enqueuedMl: 1, appliedTn: 3, failed: 0, results: [] }));
    pricing.saveOverrides.and.returnValue(of({ ok: true, saved: 2 }));
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        provideRouter([]),
        provideTanStackQuery(new QueryClient({ defaultOptions: { queries: { gcTime: 0, retry: false } } })),
        { provide: PricingService, useValue: pricing },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
    comp = fixture.debugElement.children[0].componentInstance as PlanillaPhoneComponent;
  });

  const el = () => fixture.nativeElement as HTMLElement;

  it('muestra los números, las secciones y el botón para aplicar lo pendiente', () => {
    const tiles = Array.from(el().querySelectorAll('.pp-tile b')).map((b) => b.textContent?.trim());
    expect(tiles).toEqual(['3', '1', '2']);
    expect(el().textContent).toContain('Suben');
    expect(el().textContent).toContain('Bajan');
    expect(el().textContent).toContain('Ver el producto al día');
    expect(el().querySelector('.pp-cta')?.textContent).toContain('Aplicar los 3');
  });

  it('tocar "Por aplicar" deja solo lo pendiente', () => {
    (el().querySelector('.pp-tile.warn') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(comp.sections().map((s) => s.key)).toEqual(['up', 'down']);
    expect(el().textContent).not.toContain('al día');
  });

  it('confirmar aplica lo tildado y solo al canal elegido', async () => {
    comp.openConfirm();
    fixture.detectChanges();
    comp.toggleExcluded(comp.pendingUnits().find((u) => u.key === 'sku:B')!);
    comp.channels.set('tn');
    fixture.detectChanges();
    await comp.apply(comp.confirmSkus(), comp.channels());
    expect(pricing.apply).toHaveBeenCalledWith(['P1', 'P2'], { ml: false, tn: true });
    expect(comp.confirming()).toBeFalse();
  });

  it('la hoja de un pack guarda el mismo precio para todos sus modelos', async () => {
    comp.openUnit('pack:1');
    fixture.detectChanges();
    expect(el().querySelector('zc-bottom-sheet')?.textContent).toContain('Agenda 2027');
    comp.tnDraft.set(2700);
    expect(comp.dirty()).toBeTrue();
    await comp.savePrices(comp.open()!);
    expect(pricing.saveOverrides).toHaveBeenCalledOnceWith('tn', [{ sku: 'P1', value: 2700 }, { sku: 'P2', value: 2700 }]);
  });

  it('volver al calculado no guarda ajuste', async () => {
    comp.openUnit('sku:B');
    comp.tnDraft.set(2500);
    comp.mlDraft.set(3000);
    expect(comp.dirty()).toBeFalse();
    comp.tnDraft.set(null);
    await comp.savePrices(comp.open()!);
    expect(pricing.saveOverrides).toHaveBeenCalledOnceWith('tn', [{ sku: 'B', value: null }]);
  });

  // iOS hace zoom al tocar un campo de menos de 16px (y no vuelve solo).
  it('ningún campo queda con menos de 16px (buscador y precios de la hoja)', () => {
    comp.openUnit('pack:1');
    fixture.detectChanges();
    const inputs = Array.from(document.querySelectorAll('zc-planilla-phone input')) as HTMLInputElement[];
    expect(inputs.length).toBe(3);
    for (const i of inputs) expect(parseFloat(getComputedStyle(i).fontSize)).toBeGreaterThanOrEqual(16);
  });
});
