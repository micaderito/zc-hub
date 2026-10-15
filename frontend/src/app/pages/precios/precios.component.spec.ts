import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { provideTanStackQuery, QueryClient } from '@tanstack/angular-query-experimental';
import { ImportPreview, ImportResult, PreviewRow, PricingService } from '../../core/services/pricing.service';
import { PdfTextService } from '../../core/services/pdf-text.service';
import { PreciosComponent } from './precios.component';

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const PACK = { packId: 1, name: 'Repuestos x8', sku: '39001', unitCount: 8, mode: 'assorted' as const, modelCount: 2 };

function row(over: Partial<PreviewRow> = {}): PreviewRow {
  return {
    sku: '30700', label: 'Descr. de la lista', source: 'list', bulkQty: 8, unitCost: 1000, valorFinal: 2000,
    tn: { transfer: 2000, list: 2500, override: null, effective: 2500 }, ml: 3000, mlOverride: null, mlEffective: 3000,
    mlNet: 2200, currentMl: null, currentTn: null, pendingMl: false, pendingTn: false, mlQueued: false,
    freeShipping: false, mappedMl: true, mappedTn: true,
    name: 'Cuaderno · Rosa', pack: null, ...over,
  };
}

function rows(): PreviewRow[] {
  return [
    row(),
    row({ sku: 'REP-ROJO', name: 'Repuesto rojo', pack: PACK, currentTn: 2000, pendingTn: true }),
    row({ sku: 'REP-AZUL', name: 'Repuesto azul', pack: PACK, mappedMl: false, mappedTn: false, mlEffective: 3100 }),
  ];
}

const PREVIEW: ImportPreview = {
  stats: { total: 2, valid: 2, flagged: 0 },
  rows: [],
  flagged: [],
  mapping: {
    auto: 1, otherLists: 3, review: [], unmatched: 1,
    inListItems: [{ sku: '30700', name: 'Cuaderno · Rosa', isPack: false, packId: null, memberCount: null, code: '30700' }],
    unmatchedItems: [{ sku: 'LAP-1', name: 'Lapicera', isPack: false, packId: null, memberCount: null, code: null }],
    codesWithoutProduct: [{ code: '50000', description: 'Agenda' }],
  },
};

const RESULT: ImportResult = {
  ok: true, listId: 9, autoMapped: 1, newMappings: 1, costsUpdated: 1, changedSkus: ['30700'],
  summary: {
    inList: PREVIEW.mapping.inListItems,
    otherLists: 3,
    unmatched: PREVIEW.mapping.unmatchedItems,
    codesWithoutProduct: PREVIEW.mapping.codesWithoutProduct,
  },
};

class PricingMock {
  getConfig = jasmine.createSpy('getConfig').and.returnValue(of({
    settings: { commissionPct: 14, taxes: 0, shippingCost: 0, freeShippingThreshold: 33000, cardMultiplier: 1.1, roundStep: 100, defaultMarginPct: 100, defaultDiscount1: 25, defaultDiscount2: 5 },
    tiers: [], updatedAt: null,
  }));
  getPreview = jasmine.createSpy('getPreview').and.callFake(() => of({ rows: rows() }));
  previewImport = jasmine.createSpy('previewImport').and.returnValue(of(PREVIEW));
  confirmImport = jasmine.createSpy('confirmImport').and.returnValue(of(RESULT));
  getMappingState = jasmine.createSpy('getMappingState').and.returnValue(of({ products: [], codes: [] }));
  getLists = jasmine.createSpy('getLists').and.returnValue(of({ lists: [
    { id: 3, label: 'LISTA BE POSITIVE', sourceFilename: null, discount1: 0, discount2: 0, importedAt: null, itemCount: 46 },
  ] }));
  deleteList = jasmine.createSpy('deleteList').and.returnValue(of({ ok: true }));
}

describe('PreciosComponent', () => {
  let fixture: ComponentFixture<PreciosComponent>;
  let component: PreciosComponent;
  let pricing: PricingMock;

  beforeEach(async () => {
    pricing = new PricingMock();
    await TestBed.configureTestingModule({
      imports: [PreciosComponent],
      providers: [
        provideRouter([]),
        provideTanStackQuery(new QueryClient({ defaultOptions: { queries: { gcTime: 0, retry: false } } })),
        { provide: PricingService, useValue: pricing },
        { provide: PdfTextService, useValue: { extract: () => Promise.resolve({ text: 'x', format: 'pdf' }) } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(PreciosComponent);
    component = fixture.componentInstance;
  });

  async function render() {
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  }

  const text = () => (fixture.nativeElement as HTMLElement).textContent ?? '';

  it('muestra el nombre de la publicación y "no publicado" solo si el SKU no está en ML ni TN', async () => {
    await render();
    expect(text()).toContain('Cuaderno · Rosa');
    expect(text()).not.toContain('sin mapear');
    const group = component.priceGroups().groups[0];
    expect(group.unpublished).toBe(1);
  });

  it('los packs arrancan plegados, con el rango de precios en el encabezado, y se despliegan', async () => {
    await render();
    expect(text()).toContain('Repuestos x8');
    expect(text()).not.toContain('Repuesto rojo');
    const group = component.priceGroups().groups[0];
    expect(group.ml).toEqual({ min: 3000, max: 3100 });

    component.togglePack(1);
    fixture.detectChanges();
    expect(text()).toContain('Repuesto rojo');

    component.setAllPacksExpanded(false);
    fixture.detectChanges();
    expect(text()).not.toContain('Repuesto rojo');
  });

  it('una búsqueda abre los packs y también busca por nombre de publicación', async () => {
    await render();
    component.search.set('azul');
    fixture.detectChanges();
    expect(component.filteredRows().map((r) => r.sku)).toEqual(['REP-AZUL']);
    expect(text()).toContain('Repuesto azul');
  });

  it('el checkbox del pack selecciona todos sus modelos', async () => {
    await render();
    const group = component.priceGroups().groups[0];
    component.toggleGroup(group);
    expect([...component.selected()].sort()).toEqual(['REP-AZUL', 'REP-ROJO']);
    expect(component.groupSelection(group)).toBe('all');
    component.toggleRow('REP-AZUL');
    expect(component.groupSelection(group)).toBe('some');
    component.toggleGroup(group);
    expect(component.selected().size).toBe(2);
  });

  it('el import muestra qué toma precio de esta lista, qué es de otra y qué no tiene código', async () => {
    await render();
    component.openImport();
    component.importPreview.set(PREVIEW);
    fixture.detectChanges();
    const t = text();
    expect(t).toContain('toma precio de esta lista');
    expect(t).toContain('ya tienen código de otra lista');
    expect(t).toContain('sin código');
    expect(t).toContain('Lapicera');
  });

  it('al confirmar, el modal queda con el resumen y ofrece ir a asignar códigos', async () => {
    await render();
    component.openImport();
    component.importPreview.set(PREVIEW);
    component.importLabel.set('Cuadernos');
    await component.confirmImport();
    fixture.detectChanges();
    expect(component.showImport()).toBeTrue();
    expect(component.importResult()).toEqual(RESULT);
    expect(component.applyResult()).toContain('1 producto con precio de esta lista');
    expect(component.applyResult()).toContain('1 sin código');
    expect(text()).toContain('Asignar códigos a mano');

    component.goToMapping();
    fixture.detectChanges();
    expect(component.showImport()).toBeFalse();
    expect(component.tab()).toBe('mapeo');
  });

  it('marca lo pendiente de aplicar, filtra "Solo pendientes" y lo selecciona', async () => {
    await render();
    expect(component.pendingCount()).toBe(1);
    expect(component.priceGroups().groups[0].pending).toBe(1);
    expect(text()).toContain('1 pendiente');

    component.onlyPending.set(true);
    fixture.detectChanges();
    expect(component.filteredRows().map((r) => r.sku)).toEqual(['REP-ROJO']);
    // El pack se abre solo para que se vea lo pendiente, con el precio publicado hoy.
    expect(text()).toContain('Repuesto rojo');
    expect(text()).toContain('pendiente de aplicar');
    expect(text()).toContain('hoy');

    component.selectPending();
    expect([...component.selected()]).toEqual(['REP-ROJO']);
  });

  it('lo que ya está en la cola de ML no cuenta como pendiente', async () => {
    pricing.getPreview.and.callFake(() => of({ rows: [row({ currentMl: 2500, pendingMl: true, mlQueued: true })] }));
    await render();
    expect(component.pendingCount()).toBe(0);
    expect(text()).toContain('en cola ML');
  });

  it('con "Solo pendientes" y nada pendiente avisa que está todo aplicado', async () => {
    pricing.getPreview.and.callFake(() => of({ rows: [row({ currentMl: 3000, currentTn: 2500 })] }));
    await render();
    component.onlyPending.set(true);
    fixture.detectChanges();
    expect(text()).toContain('No hay nada pendiente');
  });

  it('el historial de listas permite borrar una lista con confirmación', async () => {
    fixture.detectChanges();
    component.openLists();
    await new Promise((r) => setTimeout(r, 20));
    fixture.detectChanges();
    expect(text()).toContain('LISTA BE POSITIVE');
    component.confirmDeleteListId.set(3);
    fixture.detectChanges();
    expect(text()).toContain('¿Borrar esta lista?');
    await component.deleteList(component.importedLists()[0]);
    expect(pricing.deleteList).toHaveBeenCalledWith(3);
    expect(component.confirmDeleteListId()).toBeNull();
    expect(component.listDeleteError()).toBeNull();
  });
});
