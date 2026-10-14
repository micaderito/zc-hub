import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { provideTanStackQuery, QueryClient } from '@tanstack/angular-query-experimental';
import { MappingProduct, MappingState, PricingService } from '../../../core/services/pricing.service';
import { MapeoProveedorComponent } from './mapeo-proveedor.component';

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function product(over: Partial<MappingProduct> = {}): MappingProduct {
  return {
    key: 'sku:30700', kind: 'sku', sku: '30700', packId: null, name: 'Cuaderno · Rosa', memberSkus: [],
    packName: null, code: '30700', codeDescription: 'Cuaderno removible', listLabel: 'Cuadernos',
    matchSource: 'exact', hasCost: true, mappedMl: true, mappedTn: true, ...over,
  };
}

function state(): MappingState {
  return {
    products: [
      product(),
      product({ key: 'sku:LAP-1', sku: 'LAP-1', name: 'Lapicera', code: null, codeDescription: null, listLabel: null, matchSource: null, hasCost: false }),
      product({ key: 'sku:REP-ROJO', sku: 'REP-ROJO', name: 'Repuesto rojo', packName: 'Repuestos x8', code: null, codeDescription: null, listLabel: null, matchSource: null, hasCost: false }),
      product({ key: 'pack:1', kind: 'pack', sku: '39001', packId: 1, name: 'Surtido', memberSkus: ['A', 'B'], code: '39001', listLabel: 'Repuestos' }),
    ],
    codes: [
      { code: '30700', description: 'Cuaderno', listLabel: 'Cuadernos', mapped: true },
      { code: '39001', description: 'Repuesto', listLabel: 'Repuestos', mapped: true },
      { code: '50000', description: 'Agenda', listLabel: 'Agendas', mapped: false },
    ],
    mapped: [], packMapped: [], skusWithoutCode: [], packsWithoutCode: [], codesWithoutSku: [],
    totals: { codes: 3, skus: 4, mapped: 2 },
  };
}

class PricingMock {
  getMappingState = jasmine.createSpy('getMappingState').and.callFake(() => of(state()));
  confirmMapping = jasmine.createSpy('confirmMapping').and.returnValue(of({ ok: true, costsUpdated: 1, changedSkus: ['LAP-1'], listLabel: 'Agendas' }));
  confirmPackMapping = jasmine.createSpy('confirmPackMapping').and.returnValue(of({ ok: true, costsUpdated: 2, changedSkus: ['A', 'B'], listLabel: 'Repuestos' }));
  removeMapping = jasmine.createSpy('removeMapping').and.returnValue(of({ ok: true }));
  removePackMapping = jasmine.createSpy('removePackMapping').and.returnValue(of({ ok: true }));
}

describe('MapeoProveedorComponent', () => {
  let fixture: ComponentFixture<MapeoProveedorComponent>;
  let component: MapeoProveedorComponent;
  let pricing: PricingMock;

  beforeEach(async () => {
    pricing = new PricingMock();
    await TestBed.configureTestingModule({
      imports: [MapeoProveedorComponent],
      providers: [
        provideTanStackQuery(new QueryClient({ defaultOptions: { queries: { gcTime: 0, retry: false } } })),
        { provide: PricingService, useValue: pricing },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(MapeoProveedorComponent);
    component = fixture.componentInstance;
  });

  async function render() {
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  }

  const text = () => (fixture.nativeElement as HTMLElement).textContent ?? '';

  it('muestra todos los productos, con y sin código, y los cuenta', async () => {
    await render();
    expect(component.counts()).toEqual({ all: 4, mapped: 2, unmapped: 2 });
    expect(text()).toContain('Cuaderno · Rosa');
    expect(text()).toContain('Lapicera');
    expect(text()).toContain('sin código');
    expect(text()).toContain('Cuadernos');
  });

  it('filtra "Sin código" y por lista', async () => {
    await render();
    component.filter.set('unmapped');
    expect(component.groups().flatMap((g) => g.rows).map((r) => r.sku).sort()).toEqual(['LAP-1', 'REP-ROJO']);
    component.filter.set('all');
    component.listFilter.set('Repuestos');
    expect(component.groups().flatMap((g) => g.rows).map((r) => r.sku)).toEqual(['39001']);
  });

  it('los modelos de un pack sin código propio van agrupados y plegados', async () => {
    await render();
    const group = component.groups().find((g) => g.pack === 'Repuestos x8')!;
    expect(group.unmapped).toBe(1);
    expect(text()).not.toContain('Repuesto rojo');
    component.togglePack('Repuestos x8');
    fixture.detectChanges();
    expect(text()).toContain('Repuesto rojo');
  });

  it('con una búsqueda el pack se abre solo', async () => {
    await render();
    component.search.set('repuesto rojo');
    fixture.detectChanges();
    expect(text()).toContain('Repuesto rojo');
  });

  it('asignar un código a mano lo guarda, avisa de qué lista tomó el precio y emite los SKUs', async () => {
    await render();
    const emitted: string[][] = [];
    component.costsChanged.subscribe((s) => emitted.push(s));
    const lap = component.products().find((p) => p.sku === 'LAP-1')!;
    component.startEdit(lap);
    component.editCode.set('50000');
    await component.saveEdit(lap);
    expect(pricing.confirmMapping).toHaveBeenCalledWith('LAP-1', '50000', 'manual');
    expect(component.message()?.kind).toBe('ok');
    expect(component.message()?.text).toContain('Agendas');
    expect(emitted).toEqual([['LAP-1']]);
    expect(component.editingKey()).toBeNull();
  });

  it('un pack con código propio se mapea por pack', async () => {
    await render();
    const pack = component.products().find((p) => p.kind === 'pack')!;
    component.startEdit(pack);
    component.editCode.set('39001');
    await component.saveEdit(pack);
    expect(pricing.confirmPackMapping).toHaveBeenCalledWith(1, '39001', 'manual');
  });

  it('un código que no está en ninguna lista se guarda con aviso', async () => {
    pricing.confirmMapping.and.returnValue(of({ ok: true, costsUpdated: 0, changedSkus: [], listLabel: null }));
    await render();
    const lap = component.products().find((p) => p.sku === 'LAP-1')!;
    component.startEdit(lap);
    component.editCode.set('NO-EXISTE');
    await component.saveEdit(lap);
    expect(component.message()?.kind).toBe('warn');
    expect(component.message()?.text).toContain('no está en ninguna lista');
  });

  it('lista los códigos de las listas sin producto asignado', async () => {
    await render();
    expect(component.unusedCodes().map((c) => c.code)).toEqual(['50000']);
  });
});
