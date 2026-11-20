import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, ActivatedRoute, convertToParamMap } from '@angular/router';
import { of } from 'rxjs';
import { provideTanStackQuery, QueryClient } from '@tanstack/angular-query-experimental';
import { CatalogUnit, OrdersService, SupplierOrder } from '../../core/services/orders.service';
import { PedidoEditorComponent } from './pedido-editor.component';

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const unit = (over: Partial<CatalogUnit> = {}): CatalogUnit => ({
  key: 'pack:1', kind: 'pack', packId: 1, sku: null, name: 'Cuadernos inteligentes', code: '4410', description: 'CUADERNO X8',
  unitsPerPack: 8, mode: 'assorted', price: 96000,
  members: [
    { sku: 'A', label: 'A5 rayado', stockMl: 0, stockTn: 0, stockEffective: 0, depositoStock: 8, threshold: 2, alertState: 'out' },
    { sku: 'B', label: 'A4', stockMl: 6, stockTn: 6, stockEffective: 6, depositoStock: null, threshold: 2, alertState: 'watching' },
  ],
  alerted: true, suggestedQty: 2, depositoStock: 8, lastOrder: null, pendingOrder: null,
  suppliers: ['punto_cero'], priceSupplier: 'punto_cero', ...over,
});

const draft = (over: Partial<SupplierOrder> = {}): SupplierOrder => ({
  id: 17, name: 'Pedido octubre', status: 'borrador', partial: false, discount1: 25, discount2: 5, note: '', basedOnId: null,
  supplierKey: 'punto_cero',
  createdAt: '2026-10-08T00:00:00Z', updatedAt: null, orderedAt: null, receivedAt: null, lines: [],
  totals: { lineCount: 0, packs: 0, subtotal: 0, discount1Amount: 0, discount2Amount: 0, total: 0, missingPrices: 0 },
  ...over,
});

class OrdersMock {
  current = draft();
  get = jasmine.createSpy('get').and.callFake(() => Promise.resolve(this.current));
  units: CatalogUnit[] = [unit(), unit({ key: 'sku:LG', kind: 'sku', packId: null, sku: 'LG', name: 'Lapicera', code: 'GEL', price: 14400, unitsPerPack: 12, alerted: false, suggestedQty: null, members: [] })];
  catalog = jasmine.createSpy('catalog').and.callFake(() => Promise.resolve({ units: this.units }));
  suppliers = jasmine.createSpy('suppliers').and.resolveTo({ suppliers: [
    { key: 'punto_cero', name: 'Punto Cero', profileName: 'General', discount1: 25, discount2: 5, profiles: [
      { id: 1, name: 'General', discount1: 25, discount2: 5, isDefault: true },
      { id: 2, name: 'Agendas', discount1: 30, discount2: 5, isDefault: false },
    ] },
    { key: 'filgo', name: 'Filgo', profileName: 'General', discount1: 0, discount2: 0 },
  ] });
  saveDraft = jasmine.createSpy('saveDraft').and.callFake((_id: number, input: SupplierOrder) => Promise.resolve({ ...this.current, ...input }));
  place = jasmine.createSpy('place').and.callFake(() => Promise.resolve({ ...this.current, status: 'pendiente' }));
  receive = jasmine.createSpy('receive').and.callFake(() => Promise.resolve({ ...this.current, status: 'recibido', partial: true }));
  duplicate = jasmine.createSpy('duplicate').and.resolveTo(draft({ id: 18 }));
  delete = jasmine.createSpy('delete').and.resolveTo(undefined);
}

describe('PedidoEditorComponent', () => {
  let fixture: ComponentFixture<PedidoEditorComponent>;
  let component: PedidoEditorComponent;
  let orders: OrdersMock;

  /** Por defecto escritorio (la tabla); el navegador de los tests puede ser más angosto que 760px. */
  async function create(order: SupplierOrder, units?: CatalogUnit[], phone = false): Promise<void> {
    spyOn(window, 'matchMedia').and.returnValue({ matches: phone, addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as MediaQueryList);
    orders = new OrdersMock();
    orders.current = order;
    if (units) orders.units = units;
    await TestBed.configureTestingModule({
      imports: [PedidoEditorComponent],
      providers: [
        provideRouter([]),
        provideTanStackQuery(new QueryClient({ defaultOptions: { queries: { gcTime: 0, retry: false } } })),
        { provide: OrdersService, useValue: orders },
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ id: String(order.id) })) } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(PedidoEditorComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  }

  it('agregar desde el catálogo usa la cantidad sugerida, marca "alerta" y recalcula el total', async () => {
    await create(draft());
    component.addUnit(component.catalogUnits()[0]);
    const line = component.order()!.lines[0];
    expect(line.qty).toBe(2);
    expect(line.origin).toBe('alerta');
    expect(component.totals()!.subtotal).toBe(192000);
    expect(component.qtyInOrder().get('pack:1')).toBe(2);
  });

  it('un pack con alerta muestra todos sus modelos', async () => {
    await create(draft());
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('A5 rayado');
    expect(text).toContain('A4');
    expect(text).toContain('1 de 2 con stock');
  });

  it('filtro "Con alerta" esconde lo que no avisó; "Todos" lo muestra', async () => {
    await create(draft());
    expect(component.visibleUnits().map((u) => u.key)).toEqual(['pack:1']);
    component.catalogFilter.set('all');
    expect(component.visibleUnits().length).toBe(2);
  });

  it('un pack con código de lista y SKU propio deja elegir cuál mandar, con su descripción', async () => {
    await create(draft(), [unit({
      code: '39137', description: 'PANEL SURTIDO',
      codeOptions: [
        { code: '39021/22/33/137', source: 'lista', description: 'PANEL SURTIDO' },
        { code: '39137', source: 'pack', description: 'PANEL MI MOMENTO' },
      ],
    })]);
    component.addUnit(component.catalogUnits()[0]);
    fixture.detectChanges();
    const buttons = [...fixture.nativeElement.querySelectorAll('.code-opt')] as HTMLButtonElement[];
    expect(buttons.map((b) => b.textContent!.trim())).toEqual(['Lista', 'Pack']);
    expect(buttons[1].classList).toContain('on');
    buttons[0].click();
    expect(component.order()!.lines[0]).toEqual(jasmine.objectContaining({ code: '39021/22/33/137', description: 'PANEL SURTIDO' }));
  });

  it('el título se elige aparte: lista genérica, nombre del pack o del producto', async () => {
    await create(draft(), [unit({
      description: 'PANEL SURTIDO',
      titleOptions: [
        { text: 'PANEL SURTIDO', source: 'lista' },
        { text: 'Panel Mi Momento De Conexión', source: 'pack' },
        { text: 'Panel Removible Mi Momento', source: 'producto' },
      ],
    })]);
    component.addUnit(component.catalogUnits()[0]);
    fixture.detectChanges();
    const group = fixture.nativeElement.querySelector('[aria-label="Elegir título"]') as HTMLElement;
    const buttons = Array.from(group.querySelectorAll<HTMLButtonElement>('.code-opt'));
    expect(buttons.map((b) => b.textContent!.trim())).toEqual(['Lista', 'Pack', 'Producto']);
    expect(buttons[0].classList).toContain('on');
    buttons[1].click();
    expect(component.order()!.lines[0].description).toBe('Panel Mi Momento De Conexión');
    expect(component.order()!.lines[0].code).toBe('4410', 'elegir el título no toca el código');
  });

  it('con un solo código no muestra la elección', async () => {
    await create(draft());
    component.addUnit(component.catalogUnits()[0]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.code-pick')).toBeNull();
  });

  it('pisar el precio lo marca editado; volver lo trae de Precios', async () => {
    await create(draft());
    component.addUnit(component.catalogUnits()[0]);
    component.setLinePrice(0, 99000);
    expect(component.order()!.lines[0]).toEqual(jasmine.objectContaining({ unitPrice: 99000, priceSource: 'manual' }));
    component.revertLinePrice(0);
    expect(component.order()!.lines[0]).toEqual(jasmine.objectContaining({ unitPrice: 96000, priceSource: 'precios' }));
  });

  it('autoguarda el borrador después de editar', async () => {
    await create(draft());
    component.setName('Pedido agendas');
    expect(component.saveState()).toBe('pending');
    await settle(800);
    expect(orders.saveDraft).toHaveBeenCalledWith(17, jasmine.objectContaining({ name: 'Pedido agendas' }));
    expect(component.saveState()).toBe('saved');
  });

  it('"Agregar sugeridos" solo suma lo que avisó y no está en el pedido', async () => {
    await create(draft());
    component.addAllSuggested();
    component.addAllSuggested();
    expect(component.order()!.lines.length).toBe(1);
  });

  it('"Agregar sugeridos" saltea lo que ya está en camino (sigue con alerta, se agrega a mano)', async () => {
    await create(draft(), [
      unit({ pendingOrder: { orderId: 9, orderName: 'Pedido septiembre' } }),
      unit({ key: 'pack:2', packId: 2, name: 'Agendas' }),
    ]);
    expect(component.alertedCount()).toBe(2);
    component.addAllSuggested();
    expect(component.order()!.lines.map((l) => l.packId)).toEqual([2]);
  });

  it('ítem libre: se agrega editable y no sigue a Precios', async () => {
    await create(draft());
    component.addFreeItem();
    expect(component.order()!.lines[0]).toEqual(jasmine.objectContaining({ kind: 'free', origin: 'libre', priceSource: 'manual' }));
  });

  it('marcar como pedido guarda antes y pasa a pendiente', async () => {
    await create(draft({ lines: [{ id: 1, kind: 'pack', packId: 1, sku: null, code: '4410', description: 'X', detail: '', qty: 1, unitPrice: 96000, priceSource: 'precios', unitsPerPack: 8, origin: 'manual', receivedQty: null }] }));
    component.setLineQty(0, 3);
    component.openSheetAfterPlace = false;
    await component.place();
    expect(orders.saveDraft).toHaveBeenCalled();
    expect(orders.place).toHaveBeenCalledWith(17);
    expect(component.order()!.status).toBe('pendiente');
  });

  it('recepción: "Llegó todo" completa cada línea; cerrar incompleto crea el borrador de faltantes', async () => {
    const lines = [
      { id: 10, kind: 'pack' as const, packId: 1, sku: null, code: 'A', description: 'A', detail: '', qty: 2, unitPrice: 1, priceSource: 'precios' as const, unitsPerPack: 8, origin: 'manual' as const, receivedQty: null },
      { id: 11, kind: 'pack' as const, packId: 2, sku: null, code: 'B', description: 'B', detail: '', qty: 3, unitPrice: 1, priceSource: 'precios' as const, unitsPerPack: 8, origin: 'manual' as const, receivedQty: null },
    ];
    await create(draft({ status: 'pendiente', lines }));
    component.startReceiving();
    component.allArrived();
    expect(component.received()).toEqual({ 10: 2, 11: 3 });
    component.setReceived(lines[1], 1);
    expect(component.shortLines().map((s) => s.got)).toEqual([1]);
    await component.closeReceiving();
    expect(orders.receive).toHaveBeenCalledWith(17, { 10: 2, 11: 1 }, true);
    expect(orders.duplicate).toHaveBeenCalledWith(17, { mode: 'missing' });
    expect(component.missingDraftId()).toBe(18);
  });

  it('un pedido mandado no se edita', async () => {
    await create(draft({ status: 'pendiente' }));
    component.setName('otro');
    expect(component.order()!.name).toBe('Pedido octubre');
    expect(fixture.nativeElement.querySelector('.catalog')).toBeNull();
  });

  it('el catálogo se pide para el proveedor del pedido y lo muestra en el encabezado', async () => {
    await create(draft({ supplierKey: 'filgo' }));
    expect(orders.catalog).toHaveBeenCalledWith('filgo');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.supplier-chip').textContent).toContain('Filgo');
  });

  it('lo que no tiene proveedor queda escondido (y fuera de "Agregar sugeridos") hasta tildar "Sin proveedor"', async () => {
    await create(draft(), [unit(), unit({ key: 'pack:9', packId: 9, name: 'Gomas', suppliers: [], priceSupplier: null })]);
    expect(component.unassignedCount()).toBe(1);
    expect(component.visibleUnits().map((u) => u.key)).toEqual(['pack:1']);
    component.addAllSuggested();
    expect(component.order()!.lines.map((l) => l.packId)).toEqual([1]);
    component.showUnassigned.set(true);
    expect(component.visibleUnits().map((u) => u.key)).toEqual(['pack:1', 'pack:9']);
  });

  it('avisa cuando el precio de Precios es de otro proveedor (el vigente)', async () => {
    await create(draft({ supplierKey: 'filgo' }), [unit({ suppliers: ['punto_cero', 'filgo'], priceSupplier: 'punto_cero' })]);
    expect(component.otherPriceSupplier(component.catalogUnits()[0])).toBe('Punto Cero');
    expect(component.otherPriceSupplier(unit({ priceSupplier: 'filgo' }))).toBeNull();
  });

  it('ofrece las configs de descuento del proveedor y elegir una pisa los dos %', async () => {
    await create(draft());
    expect(component.discountProfiles().map((p) => p.name)).toEqual(['General', 'Agendas']);
    expect(component.selectedProfile()?.name).toBe('General');
    component.applyProfile('2');
    expect([component.order()!.discount1, component.order()!.discount2]).toEqual([30, 5]);
    expect(component.selectedProfile()?.name).toBe('Agendas');
    expect(component.saveState()).toBe('pending');
  });

  it('tocar un % a mano deja el pedido como "Personalizado"', async () => {
    await create(draft());
    component.setDiscount('discount1', 27);
    expect(component.selectedProfile()).toBeNull();
    expect(component.order()!.discount1).toBe(27);
  });

  it('un proveedor sin configs no muestra el selector', async () => {
    await create(draft({ supplierKey: 'filgo' }));
    expect(component.discountProfiles()).toEqual([]);
    expect(fixture.nativeElement.querySelector('.profile-row')).toBeNull();
  });

  describe('en el celular', () => {
    const line = (over: Partial<SupplierOrder['lines'][number]> = {}): SupplierOrder['lines'][number] => ({
      id: 1, kind: 'pack', packId: 1, sku: null, code: '4410', description: 'CUADERNO X8', detail: 'sin unicornios', qty: 2,
      unitPrice: 96000, priceSource: 'precios', unitsPerPack: 8, origin: 'alerta', receivedQty: null, ...over,
    });
    const el = (sel: string) => fixture.nativeElement.querySelector(sel) as HTMLElement | null;
    const all = (sel: string) => Array.from(fixture.nativeElement.querySelectorAll(sel)) as HTMLElement[];

    it('muestra las líneas como lista (sin la tabla) y la barra con el total', async () => {
      await create(draft({ lines: [line()] }), undefined, true);
      expect(el('table')).toBeNull();
      const rows = all('.ph-line');
      expect(rows.length).toBe(1);
      expect(rows[0].textContent).toContain('CUADERNO X8');
      expect(rows[0].textContent).toContain('sin unicornios');
      expect(el('.ph-bar')!.textContent).toContain('Marcar como pedido');
    });

    it('tocar una línea abre su hoja: +/− de packs, detalle y quitar', async () => {
      await create(draft({ lines: [line(), line({ id: 2, code: 'GEL', description: 'LAPICERA', packId: null, kind: 'sku', sku: 'LG' })] }), undefined, true);
      all('.ph-line')[0].click();
      fixture.detectChanges();
      expect(el('zc-bottom-sheet')!.textContent).toContain('Packs');
      const plus = el('.ph-bigstep button[aria-label="Un pack más"]') as HTMLButtonElement;
      plus.click();
      expect(component.order()!.lines[0].qty).toBe(3);
      component.stepLineQty(0, -5);
      expect(component.order()!.lines[0].qty).toBe(1, 'nunca menos de 1');
      component.removeSheetLine();
      fixture.detectChanges();
      expect(component.lineSheet()).toBeNull();
      expect(component.order()!.lines.map((l) => l.code)).toEqual(['GEL']);
    });

    it('el ítem libre se agrega y abre su hoja para cargarlo', async () => {
      await create(draft(), undefined, true);
      component.addFreeItemAndEdit();
      fixture.detectChanges();
      expect(component.lineSheet()).toBe(0);
      expect(el('.bs-title')!.textContent).toContain('Ítem libre');
    });

    it('"Agregar productos" abre el catálogo en una hoja y el + suma la sugerencia', async () => {
      await create(draft(), undefined, true);
      (all('.ph-add .ph-btn')[0] as HTMLButtonElement).click();
      fixture.detectChanges();
      const add = el('.ph-addb') as HTMLButtonElement;
      expect(add.textContent).toContain('2');
      add.click();
      fixture.detectChanges();
      expect(component.order()!.lines[0].qty).toBe(2);
      expect(el('.ph-addb.in')!.textContent).toContain('2');
    });

    it('un pedido mandado no se edita: la hoja muestra los datos sin campos', async () => {
      await create(draft({ status: 'pendiente', orderedAt: '2026-10-09T00:00:00Z', lines: [line()] }), undefined, true);
      all('.ph-line')[0].click();
      fixture.detectChanges();
      expect(el('.ph-bigstep')).toBeNull();
      expect(el('.ph-stats')!.textContent).toContain('Packs');
      expect(el('.ph-bar')!.textContent).toContain('Registrar recepción');
    });

    it('recepción: +/− y "llegó completo" por línea; la barra cuenta las completas', async () => {
      await create(draft({ status: 'pendiente', orderedAt: '2026-10-09T00:00:00Z', lines: [line(), line({ id: 2, qty: 3 })] }), undefined, true);
      component.startReceiving();
      fixture.detectChanges();
      const lines = component.order()!.lines;
      component.stepReceived(lines[0], 1);
      component.stepReceived(lines[0], 5);
      expect(component.received()[1]).toBe(2, 'no pasa de lo pedido');
      fixture.detectChanges();
      expect(all('.ph-tick').length).toBe(1, 'la completa ya no ofrece el tilde');
      (all('.ph-tick')[0] as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(component.received()[2]).toBe(3);
      expect(el('.ph-bar')!.textContent).toContain('2 de 2');
    });

    it('el menú ⋯ ofrece la vista para la fábrica y borrar el borrador', async () => {
      await create(draft({ lines: [line()] }), undefined, true);
      (el('.ph-more') as HTMLButtonElement).click();
      fixture.detectChanges();
      const items = all('.ph-menu button').map((b) => b.textContent!.trim());
      expect(items).toEqual(['Vista para la fábrica', 'Duplicar como borrador', 'Borrar borrador']);
      component.askDeleteFromMenu();
      expect(component.showDeleteConfirm()).toBeTrue();
    });
  });
});
