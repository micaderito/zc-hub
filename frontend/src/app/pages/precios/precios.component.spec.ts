import { Type } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { provideTanStackQuery, QueryClient } from '@tanstack/angular-query-experimental';
import { ApplyRun, ApplyRunItem, ImportPreview, ImportResult, PreviewRow, PricingService } from '../../core/services/pricing.service';
import { PdfTextService } from '../../core/services/pdf-text.service';
import { PreciosComponent } from './precios.component';
import { PreciosStore } from './precios.store';
import { PreciosPlanillaComponent } from './planilla/precios-planilla.component';
import { PreciosAplicacionesComponent } from './aplicaciones/precios-aplicaciones.component';
import { CostFormDialogComponent } from './dialogs/cost-form-dialog.component';
import { AssignDialogComponent } from './dialogs/assign-dialog.component';
import { ImportListDialogComponent } from './dialogs/import-list-dialog.component';
import { PriceListsDialogComponent } from './dialogs/price-lists-dialog.component';
import { ProfileFormDialogComponent } from './dialogs/profile-form-dialog.component';
import { discountChain } from './precios.utils';

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const PACK = { packId: 1, name: 'Repuestos x8', sku: '39001', unitCount: 8, mode: 'assorted' as const, modelCount: 2 };

function row(over: Partial<PreviewRow> = {}): PreviewRow {
  return {
    sku: '30700', label: 'Descr. de la lista', source: 'list', bulkQty: 8, unitCost: 1000, valorFinal: 2000,
    bulkPrice: 11228, unitListPrice: 1403.5,
    discount: { profileId: 1, name: 'General', discount1: 25, discount2: 5, level: 'default' },
    supplierKey: 'punto_cero', suppliers: ['punto_cero'],
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

const APPLY_RUNS: ApplyRun[] = [
  { id: 4, createdBy: 'mica', total: 361, createdAt: '2026-10-18T15:00:00.000Z',
    counts: { ml: { ok: 350, failed: 1, retrying: 2 }, tn: { ok: 359, failed: 2 } } },
  { id: 3, createdBy: 'mica', total: 5, createdAt: '2026-10-10T15:00:00.000Z', counts: { ml: { ok: 5 }, tn: { ok: 5 } } },
];

function applyItem(over: Partial<ApplyRunItem>): ApplyRunItem {
  return {
    id: 1, sku: '30700', channel: 'ml', status: 'ok', price: 3000, reason: null, productLabel: 'Cuaderno',
    mlTaskId: 1, mlAttempts: 0, itemId: 'MLA1', updatedAt: null, ...over,
  };
}

const APPLY_ITEMS: ApplyRunItem[] = [
  applyItem({ id: 1 }),
  applyItem({ id: 2, sku: 'A', status: 'failed', reason: 'HTTP 429' }),
  applyItem({ id: 3, sku: 'B', channel: 'tn', status: 'failed', reason: 'bulk TN falló: 503', mlTaskId: null }),
  applyItem({ id: 4, sku: 'C', status: 'retrying', reason: 'HTTP 429', mlAttempts: 2 }),
];

class PricingMock {
  getConfig = jasmine.createSpy('getConfig').and.returnValue(of({
    settings: { commissionPct: 14, taxes: 0, shippingCost: 0, freeShippingThreshold: 33000, cardMultiplier: 1.1, roundStep: 100, defaultMarginPct: 100, defaultDiscount1: 25, defaultDiscount2: 5 },
    tiers: [], updatedAt: null,
    suppliers: [
      { key: 'punto_cero', name: 'Punto Cero', productCount: 3, profiles: [
        { id: 1, supplierKey: 'punto_cero', name: 'General', discount1: 25, discount2: 5, isDefault: true, productCount: 3 },
        { id: 2, supplierKey: 'punto_cero', name: 'Agendas', discount1: 30, discount2: 5, isDefault: false, productCount: 0 },
      ] },
      { key: 'bic', name: 'Bic', productCount: 1, profiles: [
        { id: 9, supplierKey: 'bic', name: 'Sin descuento', discount1: 0, discount2: 0, isDefault: true, productCount: 1 },
      ] },
    ],
  }));
  assignDiscount = jasmine.createSpy('assignDiscount').and.returnValue(of({ ok: true, assigned: 1 }));
  setVigente = jasmine.createSpy('setVigente').and.returnValue(of({ ok: true, changedSkus: [], withoutPrice: ['30700'] }));
  createProfile = jasmine.createSpy('createProfile').and.returnValue(of({ id: 3 }));
  updateProfile = jasmine.createSpy('updateProfile').and.returnValue(of({ ok: true }));
  deleteProfile = jasmine.createSpy('deleteProfile').and.returnValue(of({ ok: true }));
  createSupplier = jasmine.createSpy('createSupplier').and.returnValue(of({ key: 'filgo' }));
  getPreview = jasmine.createSpy('getPreview').and.callFake(() => of({ rows: rows() }));
  previewImport = jasmine.createSpy('previewImport').and.returnValue(of(PREVIEW));
  confirmImport = jasmine.createSpy('confirmImport').and.returnValue(of(RESULT));
  getMappingState = jasmine.createSpy('getMappingState').and.returnValue(of({ products: [], codes: [] }));
  getLists = jasmine.createSpy('getLists').and.returnValue(of({ lists: [
    { id: 3, label: 'LISTA BE POSITIVE', sourceFilename: null, discount1: 0, discount2: 0, importedAt: null, itemCount: 46 },
  ] }));
  saveCost = jasmine.createSpy('saveCost').and.returnValue(of({}));
  getProductSuppliers = jasmine.createSpy('getProductSuppliers').and.returnValue(of({ suppliers: [], bySku: {}, byPack: {}, packBySku: {} }));
  deleteList = jasmine.createSpy('deleteList').and.returnValue(of({ ok: true }));
  apply = jasmine.createSpy('apply').and.returnValue(of({
    runId: 4, total: 2, enqueuedMl: 1, appliedTn: 0, failed: 2,
    results: [
      { sku: '30700', channel: 'ml', ok: true, taskId: 1, price: 3000 },
      { sku: '30700', channel: 'tn', ok: false, reason: 'bulk TN falló: 429' },
      { sku: 'REP-AZUL', ok: false, reason: 'sin costo cargado' },
    ],
  }));
  listApplyRuns = jasmine.createSpy('listApplyRuns').and.returnValue(of({ runs: APPLY_RUNS, total: 2 }));
  getApplyRun = jasmine.createSpy('getApplyRun').and.returnValue(of({ items: APPLY_ITEMS }));
  retryApplyRun = jasmine.createSpy('retryApplyRun').and.returnValue(of({ retriedMl: 1, appliedTn: 1, failedTn: 0 }));
}

describe('PreciosComponent', () => {
  let fixture: ComponentFixture<PreciosComponent>;
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
  });

  async function render() {
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  }

  const text = () => (fixture.nativeElement as HTMLElement).textContent ?? '';
  const store = () => fixture.debugElement.injector.get(PreciosStore);
  function child<T>(type: Type<T>): T {
    return fixture.debugElement.query(By.directive(type)).componentInstance as T;
  }
  const planilla = () => child(PreciosPlanillaComponent);
  /** Abre un diálogo de la página y devuelve su componente. */
  async function openDialog<T>(d: Parameters<PreciosStore['open']>[0], type: Type<T>): Promise<T> {
    store().open(d);
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
    return child(type);
  }

  // ── Planilla ──

  it('muestra el nombre de la publicación y "no publicado" solo si el SKU no está en ML ni TN', async () => {
    await render();
    expect(text()).toContain('Cuaderno · Rosa');
    expect(text()).not.toContain('sin mapear');
    expect(planilla().priceGroups().groups[0].unpublished).toBe(1);
  });

  it('los packs arrancan plegados, con el rango de precios en el encabezado, y se despliegan', async () => {
    await render();
    expect(text()).toContain('Repuestos x8');
    expect(text()).not.toContain('Repuesto rojo');
    expect(planilla().priceGroups().groups[0].ml).toEqual({ min: 3000, max: 3100 });

    planilla().togglePack(1);
    fixture.detectChanges();
    expect(text()).toContain('Repuesto rojo');

    planilla().setAllPacksExpanded(false);
    fixture.detectChanges();
    expect(text()).not.toContain('Repuesto rojo');
  });

  it('una búsqueda abre los packs y también busca por nombre de publicación', async () => {
    await render();
    planilla().search.set('azul');
    fixture.detectChanges();
    expect(planilla().filteredRows().map((r) => r.sku)).toEqual(['REP-AZUL']);
    expect(text()).toContain('Repuesto azul');
  });

  it('el checkbox del pack selecciona todos sus modelos', async () => {
    await render();
    const p = planilla();
    const group = p.priceGroups().groups[0];
    p.toggleGroup(group);
    expect([...p.selected()].sort()).toEqual(['REP-AZUL', 'REP-ROJO']);
    expect(p.groupSelection(group)).toBe('all');
    p.toggleRow('REP-AZUL');
    expect(p.groupSelection(group)).toBe('some');
    p.toggleGroup(group);
    expect(p.selected().size).toBe(2);
  });

  it('marca lo pendiente de aplicar, filtra "Solo pendientes" y lo selecciona', async () => {
    await render();
    const p = planilla();
    expect(p.pendingCount()).toBe(1);
    expect(p.priceGroups().groups[0].pending).toBe(1);
    expect(text()).toContain('1 pendiente');

    p.onlyPending.set(true);
    fixture.detectChanges();
    expect(p.filteredRows().map((r) => r.sku)).toEqual(['REP-ROJO']);
    // El pack se abre solo para que se vea lo pendiente, con el precio publicado hoy.
    expect(text()).toContain('Repuesto rojo');
    expect(text()).toContain('pendiente de aplicar');
    expect(text()).toContain('hoy');

    p.selectPending();
    expect([...p.selected()]).toEqual(['REP-ROJO']);
  });

  it('el encabezado del pack marca si lo pendiente sube o baja en cada canal', async () => {
    pricing.getPreview.and.callFake(() => of({ rows: [
      row({ sku: 'A', pack: PACK, currentTn: 2000, pendingTn: true, currentMl: 3300, pendingMl: true }),
      row({ sku: 'B', pack: PACK, currentTn: 2000, pendingTn: true, currentMl: 2900, pendingMl: true }),
    ] }));
    await render();
    const g = planilla().priceGroups().groups[0];
    expect(g.tnTrend).toEqual({ dir: 'up', minPct: 25, maxPct: 25 });
    expect(g.mlTrend?.dir).toBe('mixed');
    const tn = fixture.nativeElement.querySelector('tr.group-row td.tn .trend') as HTMLElement;
    expect(tn.classList).toContain('up');
    expect(tn.textContent).toContain('+25%');
    expect(fixture.nativeElement.querySelector('tr.group-row td.ml .trend.mixed')).toBeTruthy();
  });

  it('sin nada pendiente (o solo en cola ML) el pack no muestra sube/baja', async () => {
    pricing.getPreview.and.callFake(() => of({ rows: [
      row({ sku: 'A', pack: PACK, currentMl: 3500, pendingMl: true, mlQueued: true }),
    ] }));
    await render();
    const g = planilla().priceGroups().groups[0];
    expect(g.tnTrend).toBeNull();
    expect(g.mlTrend).toBeNull();
    expect(fixture.nativeElement.querySelector('tr.group-row .trend')).toBeNull();
  });

  it('baja: rojo', async () => {
    pricing.getPreview.and.callFake(() => of({ rows: [
      row({ sku: 'A', pack: PACK, currentTn: 3000, pendingTn: true }),
    ] }));
    await render();
    const tn = fixture.nativeElement.querySelector('tr.group-row td.tn .trend') as HTMLElement;
    expect(tn.classList).toContain('down');
    expect(tn.textContent).toContain('−16,7%');
  });

  it('lo que ya está en la cola de ML no cuenta como pendiente', async () => {
    pricing.getPreview.and.callFake(() => of({ rows: [row({ currentMl: 2500, pendingMl: true, mlQueued: true })] }));
    await render();
    expect(planilla().pendingCount()).toBe(0);
    expect(text()).toContain('en cola ML');
  });

  it('con "Solo pendientes" y nada pendiente avisa que está todo aplicado', async () => {
    pricing.getPreview.and.callFake(() => of({ rows: [row({ currentMl: 3000, currentTn: 2500 })] }));
    await render();
    planilla().onlyPending.set(true);
    fixture.detectChanges();
    expect(text()).toContain('No hay nada pendiente');
  });

  it('la columna Bulto muestra el precio del bulto y la de Descuento la config con sus %', async () => {
    await render();
    const t = text();
    expect(t).toMatch(/11[.,]228/);
    expect(t).toContain('8 u.');
    expect(t).toContain('General');
    expect(t).toContain('−25% −5%');
    expect(discountChain(store().rows()[0])).toContain('−25%');
    expect(discountChain(store().rows()[0])).toContain('default del proveedor');
  });

  // ── Proveedores ──

  function withBic() {
    pricing.getPreview.and.callFake(() => of({ rows: [
      ...rows(),
      row({ sku: 'BIC-50', name: 'Bolígrafo x50', supplierKey: 'bic', suppliers: ['bic'], bulkPrice: 15500, bulkQty: 50, unitListPrice: 310,
        discount: { profileId: 9, name: 'Sin descuento', discount1: 0, discount2: 0, level: 'default' } }),
    ] }));
  }

  it('una pestaña por proveedor filtra la planilla y muestra sus configuraciones', async () => {
    withBic();
    await render();
    expect(store().supplierTabs().map((t) => [t.label, t.count])).toEqual([['Todos', 4], ['Punto Cero', 3], ['Bic', 1]]);

    store().setSupplierTab('bic');
    fixture.detectChanges();
    expect(store().rows().map((r) => r.sku)).toEqual(['BIC-50']);
    expect(text()).toContain('Sin descuento');
    expect(text()).toContain('Nueva configuración');

    store().setSupplierTab('punto_cero');
    fixture.detectChanges();
    expect(store().rows().length).toBe(3);
    expect(text()).toContain('Agendas');
    expect(text()).toContain('−30% −5%');
  });

  it('lo de un proveedor que todavía no tiene costo cuenta en su pestaña y se lista para cargarle el costo', async () => {
    withBic();
    const pack = { packId: 9, name: 'Resaltadores x6', sku: null, unitCount: 6, mode: 'assorted' as const, modelCount: 3 };
    pricing.getPreview.and.callFake(() => of({
      rows: rows(),
      uncosted: [
        { sku: 'RES-AM', name: 'Resaltador amarillo', suppliers: ['bic'], pack },
        { sku: 'RES-VE', name: 'Resaltador verde', suppliers: ['bic'], pack },
        { sku: 'CORR', name: 'Corrector', suppliers: ['bic'], pack: null },
      ],
    }));
    await render();
    expect(store().supplierTabs().find((t) => t.key === 'bic')?.count).toBe(3);

    store().setSupplierTab('bic');
    fixture.detectChanges();
    expect(text()).toContain('Sin costo cargado');
    expect(text()).toContain('Resaltadores x6');
    expect(text()).toContain('2 de 3 modelos sin costo');
    expect(text()).toContain('Corrector');

    planilla().loadCost(planilla().uncostedGroups()[0]);
    expect(store().dialog()).toEqual({
      kind: 'cost', row: null, prefill: { skus: ['RES-AM', 'RES-VE'], label: 'Resaltadores x6', supplierKey: 'bic' },
    });
  });

  it('carga el mismo costo a lo tildado (con costo y sin costo), cada uno con su nombre', async () => {
    withBic();
    const pack = { packId: 9, name: 'Resaltadores x6', sku: null, unitCount: 6, mode: 'assorted' as const, modelCount: 3 };
    pricing.getPreview.and.callFake(() => of({
      rows: rows(),
      uncosted: [
        { sku: 'RES-AM', name: 'Resaltador amarillo', suppliers: ['bic'], pack },
        { sku: 'RES-VE', name: 'Resaltador verde', suppliers: ['bic'], pack },
        { sku: 'CORR', name: 'Corrector', suppliers: ['bic'], pack: null },
      ],
    }));
    await render();
    const p = planilla();
    p.toggleUncostedGroup(p.uncostedGroups()[0]);
    p.toggleRow('CORR');
    p.toggleRow('30700');
    expect(p.selectedCosted()).toEqual(['30700']);

    p.loadCostForSelected();
    expect(store().dialog()).toEqual({
      kind: 'cost', row: null,
      prefill: {
        skus: ['30700', 'RES-AM', 'RES-VE', 'CORR'], label: null, supplierKey: 'punto_cero',
        bulkLabels: { '30700': 'Descr. de la lista', 'RES-AM': 'Resaltadores x6', 'RES-VE': 'Resaltadores x6', CORR: 'Corrector' },
      },
    });
  });

  it('con un solo tildado "Cargar costo…" abre el formulario de siempre', async () => {
    await render();
    planilla().toggleRow('30700');
    planilla().loadCostForSelected();
    expect(store().dialog()).toEqual({ kind: 'cost', row: rows()[0] });
  });

  it('cambiar de pestaña de proveedor limpia la selección', async () => {
    await render();
    planilla().toggleRow('30700');
    store().setSupplierTab('bic');
    fixture.detectChanges();
    expect(planilla().selected().size).toBe(0);
  });

  it('asignar descuento manda el pack entero como pack y el resto por SKU', async () => {
    await render();
    const p = planilla();
    p.toggleGroup(p.priceGroups().groups[0]);
    p.toggleRow('30700');
    expect(p.selectionTargets()).toEqual([{ type: 'pack', id: 1 }, { type: 'sku', id: '30700' }]);

    p.assignMode.set('discount');
    fixture.detectChanges();
    const dlg = child(AssignDialogComponent);
    expect(dlg.supplierKey()).toBe('punto_cero');
    expect(dlg.profileId()).toBe(1);
    dlg.profileId.set(2);
    await dlg.confirm();
    fixture.detectChanges();
    expect(pricing.assignDiscount).toHaveBeenCalledWith('punto_cero', [{ type: 'pack', id: 1 }, { type: 'sku', id: '30700' }], 2);
    expect(p.assignMode()).toBeNull();
  });

  it('cambiar el proveedor vigente avisa lo que quedó sin precio de ese proveedor', async () => {
    await render();
    planilla().toggleRow('30700');
    planilla().assignMode.set('vigente');
    fixture.detectChanges();
    const dlg = child(AssignDialogComponent);
    dlg.setSupplier('bic');
    await dlg.confirm();
    expect(pricing.setVigente).toHaveBeenCalledWith('bic', [{ type: 'sku', id: '30700' }]);
    expect(dlg.result()).toContain('sin precio de Bic');
    expect(planilla().assignMode()).toBe('vigente');
  });

  it('crear una configuración la guarda en el proveedor de la pestaña', async () => {
    await render();
    const dlg = await openDialog({ kind: 'profile', supplierKey: 'punto_cero', profile: null }, ProfileFormDialogComponent);
    dlg.name.set('Liquidación');
    dlg.discount1.set(40);
    await dlg.save();
    expect(pricing.createProfile).toHaveBeenCalledWith('punto_cero', { name: 'Liquidación', discount1: 40, discount2: 0 });
    expect(store().dialog()).toBeNull();
  });

  // ── Cargar costo desde Mapeo con el proveedor ──

  function mappingProduct(over: Record<string, unknown> = {}) {
    return {
      key: 'sku:LAP-1', kind: 'sku' as const, sku: 'LAP-1', packId: null, name: 'Lapicera', memberSkus: [], packName: null,
      code: null, codeDescription: null, listLabel: null, matchSource: null, hasCost: false, mappedMl: true, mappedTn: true,
      ...over,
    };
  }

  it('un producto sin costo de Mapeo abre costo nuevo con el proveedor de la pestaña y lo guarda', async () => {
    await render();
    store().setSupplierTab('bic');
    fixture.componentInstance.onMappingEditCost(mappingProduct());
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
    const dlg = child(CostFormDialogComponent);
    expect(dlg.form().sku).toBe('LAP-1');
    expect(dlg.form().label).toBe('Lapicera');
    expect(dlg.form().supplierKey).toBe('bic');
    expect(dlg.form().mode).toBe('bulk');
    dlg.update('bulkPrice', 12000);
    dlg.update('bulkQty', 12);
    await dlg.save();
    expect(pricing.saveCost).toHaveBeenCalledWith('LAP-1', jasmine.objectContaining({ bulkPrice: 12000, bulkQty: 12, supplierKey: 'bic' }));
    expect(store().dialog()).toBeNull();
  });

  it('un pack con código propio carga el mismo costo a todos sus modelos', async () => {
    await render();
    store().setSupplierTab('punto_cero');
    fixture.componentInstance.onMappingEditCost(mappingProduct({ key: 'pack:7', kind: 'pack', sku: '39500', packId: 7, name: 'Lapiceras x2', memberSkus: ['LAP-A', 'LAP-B'] }));
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
    expect(text()).toContain('los 2 modelos del pack');
    const dlg = child(CostFormDialogComponent);
    dlg.update('bulkPrice', 5000);
    dlg.update('bulkQty', 10);
    await dlg.save();
    expect(pricing.saveCost.calls.allArgs().map((a: unknown[]) => a[0])).toEqual(['LAP-A', 'LAP-B']);
  });

  it('un producto que ya tiene costo de Mapeo abre la edición de su fila', async () => {
    await render();
    fixture.componentInstance.onMappingEditCost(mappingProduct({ key: 'sku:30700', sku: '30700', hasCost: true }));
    const d = store().dialog();
    expect(d?.kind === 'cost' && d.row?.sku).toBe('30700');
    expect(d?.kind === 'cost' && d.prefill).toBeUndefined();
  });

  // ── Importar lista ──

  it('el import muestra qué toma precio de esta lista, qué es de otra y qué no tiene código', async () => {
    await render();
    const dlg = await openDialog({ kind: 'import' }, ImportListDialogComponent);
    dlg.importPreview.set(PREVIEW);
    fixture.detectChanges();
    const t = text();
    expect(t).toContain('toma precio de esta lista');
    expect(t).toContain('ya tienen código de otra lista');
    expect(t).toContain('sin código');
    expect(t).toContain('Lapicera');
  });

  it('al confirmar, el diálogo queda con el resumen y ofrece ir a asignar códigos', async () => {
    await render();
    const dlg = await openDialog({ kind: 'import' }, ImportListDialogComponent);
    dlg.importPreview.set(PREVIEW);
    dlg.importLabel.set('Cuadernos');
    await dlg.confirmImport();
    fixture.detectChanges();
    expect(store().dialog()?.kind).toBe('import');
    expect(dlg.importResult()).toEqual(RESULT);
    expect(store().notice()).toContain('1 producto con precio de esta lista');
    expect(store().notice()).toContain('1 sin código');
    expect(text()).toContain('Asignar códigos a mano');

    dlg.goToMapping();
    fixture.detectChanges();
    expect(store().dialog()).toBeNull();
    expect(store().view()).toBe('mapeo');
  });

  it('el import manda el proveedor y la config elegida (precargada con la default)', async () => {
    await render();
    store().setSupplierTab('punto_cero');
    const dlg = await openDialog({ kind: 'import' }, ImportListDialogComponent);
    expect(dlg.importSupplier()).toBe('punto_cero');
    expect(dlg.importProfileId()).toBe(1);
    dlg.importPreview.set(PREVIEW);
    dlg.importLabel.set('Agendas 2027');
    dlg.importProfileId.set(2);
    await dlg.confirmImport();
    expect(pricing.confirmImport).toHaveBeenCalledWith(jasmine.objectContaining({ supplierKey: 'punto_cero', profileId: 2 }));
  });

  it('cambiar el proveedor del import precarga su default y rehace el preview con sus códigos', async () => {
    await render();
    const dlg = await openDialog({ kind: 'import' }, ImportListDialogComponent);
    await dlg.onFileSelected({ target: { files: [new File(['x'], 'bic.pdf')], value: '' } } as unknown as Event);
    await dlg.setImportSupplier('bic');
    expect(dlg.importProfileId()).toBe(9);
    expect(pricing.previewImport).toHaveBeenCalledWith('x', 'pdf', 'bic');
  });

  // ── Historial de listas ──

  it('el historial de listas permite borrar una lista con confirmación', async () => {
    await render();
    const dlg = await openDialog({ kind: 'lists' }, PriceListsDialogComponent);
    expect(text()).toContain('LISTA BE POSITIVE');
    dlg.confirmDeleteId.set(3);
    fixture.detectChanges();
    expect(text()).toContain('¿Borrar esta lista?');
    await dlg.deleteList(dlg.lists()[0]);
    expect(pricing.deleteList).toHaveBeenCalledWith(3);
    expect(dlg.confirmDeleteId()).toBeNull();
    expect(dlg.deleteError()).toBeNull();
  });

  // ── Aplicar: detalle de lo que no se aplicó ──

  it('al aplicar muestra qué SKU no se aplicó, en qué canal y por qué', async () => {
    await render();
    const p = planilla();
    p.selected.set(new Set(['30700', 'REP-ROJO']));
    await p.apply();
    fixture.detectChanges();

    expect(store().notice()).toBe('1 en cola para ML · 0 aplicados en TN · 2 con problemas');
    const panel = (fixture.nativeElement as HTMLElement).querySelector('.pr-apply-failures')!;
    expect(panel.textContent).toContain('2 cambios no se aplicaron');
    expect(panel.textContent).toContain('bulk TN falló: 429');
    expect(panel.textContent).toContain('sin costo cargado');
    expect(panel.textContent).toContain('ML y TN');

    (Array.from(panel.querySelectorAll('button')).find((b) => b.textContent?.includes('Ver en Aplicaciones')) as HTMLButtonElement).click();
    expect(store().view()).toBe('aplicaciones');
  });

  // ── Aplicaciones ──

  async function openAplicaciones(): Promise<PreciosAplicacionesComponent> {
    await render();
    store().setView('aplicaciones');
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
    return child(PreciosAplicacionesComponent);
  }

  it('Aplicaciones lista cada aplicación con el estado por canal', async () => {
    await openAplicaciones();
    expect(pricing.listApplyRuns).toHaveBeenCalledWith(20, 0);
    expect(text()).toContain('361 productos');
    expect(text()).toContain('350 aplicados');
    expect(text()).toContain('2 reintentando');
    expect(text()).toContain('Reintentar fallidos (3)');
  });

  it('al abrir una aplicación muestra solo lo que tuvo problemas, con el motivo', async () => {
    const ap = await openAplicaciones();
    ap.toggle(APPLY_RUNS[0]);
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();

    expect(pricing.getApplyRun).toHaveBeenCalledWith(4);
    expect(ap.items().map((i) => i.id)).toEqual([2, 3, 4]);
    expect(text()).toContain('bulk TN falló: 503');
    expect(text()).toContain('intento 2 de 5');

    ap.onlyProblems.set(false);
    expect(ap.items().length).toBe(4);
  });

  it('reintenta todo lo fallido de una aplicación, o una sola fila', async () => {
    const ap = await openAplicaciones();
    await ap.retry(APPLY_RUNS[0]);
    expect(pricing.retryApplyRun).toHaveBeenCalledWith(4, undefined);
    expect(ap.notice()).toBe('1 vuelven a la cola de ML · 1 aplicados en TN');

    await ap.retry(APPLY_RUNS[0], [3]);
    expect(pricing.retryApplyRun).toHaveBeenCalledWith(4, [3]);
  });
});
