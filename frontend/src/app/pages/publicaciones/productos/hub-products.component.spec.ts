import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideTanStackQuery, QueryClient } from '@tanstack/angular-query-experimental';
import { HubProductDetail, HubProductsService, HubProductSummary } from '../../../core/services/hub-products.service';
import { HubProductsComponent } from './hub-products.component';

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function summary(over: Partial<HubProductSummary> = {}): HubProductSummary {
  return { key: 'ml:MLA1', name: 'Cuaderno Rivadavia A4', thumbnail: null, status: 'orphan', mlCount: 1, tnCount: 4, variantCount: 4, mlStock: 10, tnStock: 10, ...over };
}

function detail(): HubProductDetail {
  return {
    key: 'ml:MLA1',
    name: 'Cuaderno Rivadavia A4',
    thumbnail: null,
    status: 'orphan',
    ml: [{ itemId: 'MLA1', title: 'Cuaderno Rivadavia A4', format: 'legacy', familyName: null, soldQuantity: 37, status: 'active', thumbnail: null, variantCount: 2 }],
    tn: [
      { productId: 10, name: 'Rivadavia Rojo', thumbnail: null, variantCount: 1 },
      { productId: 11, name: 'Rivadavia Azul', thumbnail: null, variantCount: 1 },
    ],
    rows: [
      {
        sku: 'RIV-ROJ', duplicate: false,
        ml: { itemId: 'MLA1', variationId: '1', variationName: 'Rojo', title: 'Cuaderno', sku: 'RIV-ROJ', price: 8990, stock: 3, thumbnail: null },
        tn: { productId: 10, variantId: 100, variantName: null, productName: 'Rivadavia Rojo', sku: 'RIV-ROJ', price: 7990, stock: 5, thumbnail: null },
      },
      {
        sku: null, duplicate: false,
        ml: { itemId: 'MLA1', variationId: '2', variationName: 'Azul', title: 'Cuaderno', sku: null, price: 8990, stock: 2, thumbnail: null },
        tn: null,
      },
    ],
    variantCount: 2,
    mlStock: 5,
    tnStock: 5,
  };
}

class HubMock {
  list = jasmine.createSpy('list').and.callFake(() => Promise.resolve({
    rows: [summary()], total: 1,
    counts: { all: 1, orphan: 1, duplicate: 0, desync: 0, only_ml: 0, only_tn: 0, linked: 0 },
    mlConnected: true, tnConnected: true, at: 1,
  }));
  get = jasmine.createSpy('get').and.callFake(() => Promise.resolve(detail()));
  linkCandidates = jasmine.createSpy('linkCandidates').and.resolveTo([]);
  link = jasmine.createSpy('link').and.resolveTo({ ok: true, sku: 'RIV-AZU', pendingMl: true });
}

describe('HubProductsComponent', () => {
  let fixture: ComponentFixture<HubProductsComponent>;
  let component: HubProductsComponent;
  let hub: HubMock;

  beforeEach(async () => {
    hub = new HubMock();
    await TestBed.configureTestingModule({
      imports: [HubProductsComponent],
      providers: [
        provideRouter([]),
        provideTanStackQuery(new QueryClient({ defaultOptions: { queries: { gcTime: 0, retry: false } } })),
        { provide: HubProductsService, useValue: hub },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(HubProductsComponent);
    component = fixture.componentInstance;
  });

  async function render() {
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  }

  it('carga la lista con los chips de estado y la pinta', async () => {
    await render();
    expect(hub.list).toHaveBeenCalled();
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Cuaderno Rivadavia A4');
    expect(text).toContain('ML × 1');
    expect(text).toContain('TN × 4');
    expect(text).toContain('Variantes sin par');
  });

  it('cambiar el filtro de estado vuelve a la página 1 y lo manda al backend', async () => {
    await render();
    component.page.set(3);
    component.setStatus('desync');
    await render();
    expect(component.page()).toBe(1);
    expect(hub.list.calls.mostRecent().args[0]).toEqual(jasmine.objectContaining({ status: 'desync', offset: 0 }));
  });

  it('abrir un producto trae el detalle con publicaciones y variantes unidas por SKU', async () => {
    await render();
    component.open('ml:MLA1');
    await render();
    expect(hub.get).toHaveBeenCalledWith('ml:MLA1');
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('MLA1');
    expect(text).toContain('Clásica con variaciones');
    expect(text).toContain('Rivadavia Azul');
    expect(text).toContain('No está en TN');
    expect(component.shape(detail(), 'ml')).toBe('1 publicación con 2 variantes');
    expect(component.shape(detail(), 'tn')).toBe('2 productos');
  });

  it('marca el stock distinto entre canales', () => {
    const [linked, orphan] = detail().rows;
    expect(component.stockDiffers(linked)).toBeTrue();
    expect(component.stockDiffers(orphan)).toBeFalse();
  });

  it('pubKey numera cada publicación por canal y mlUrl arma el link sin guardar el permalink', () => {
    const d = detail();
    expect(component.pubKey(d, 'tn', 11)).toBe('TN-2');
    expect(component.pubKey(d, 'ml', 'MLA1')).toBe('ML-1');
    expect(component.mlUrl('MLA123')).toContain('MLA-123');
  });

  it('después de vincular avisa que ML termina en la cola y relee lista y detalle', async () => {
    await render();
    component.open('ml:MLA1');
    await render();
    const before = hub.get.calls.count();
    await component.onLinked({ sku: 'RIV-AZU', pendingMl: true });
    expect(component.linking()).toBeNull();
    expect(component.notice()).toContain('RIV-AZU');
    expect(component.notice()).toContain('Mercado Libre');
    expect(hub.get.calls.count()).toBeGreaterThan(before);
  });

  it('Actualizar fuerza el crawl y relee', async () => {
    await render();
    await component.refresh();
    expect(hub.list).toHaveBeenCalledWith(jasmine.objectContaining({ refresh: true }));
    expect(component.refreshing()).toBeFalse();
  });

  it('avisa si un canal no está conectado', async () => {
    hub.list.and.callFake(() => Promise.resolve({
      rows: [], total: 0, counts: { all: 0, orphan: 0, duplicate: 0, desync: 0, only_ml: 0, only_tn: 0, linked: 0 },
      mlConnected: true, tnConnected: false, at: 1,
    }));
    await render();
    expect(fixture.nativeElement.textContent).toContain('Tienda Nube no está conectada');
  });
});
