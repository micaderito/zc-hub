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


/** Karma corre más angosto que 760px: sin mock, todos los specs verían la versión de celular. */
function mockMedia(phone: boolean): void {
  const fake = (q: string) => ({ matches: phone && q.includes('760'), media: q, addEventListener: () => undefined, removeEventListener: () => undefined }) as unknown as MediaQueryList;
  if (jasmine.isSpy(window.matchMedia)) (window.matchMedia as jasmine.Spy).and.callFake(fake);
  else spyOn(window, 'matchMedia').and.callFake(fake);
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
    mockMedia(false);
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
  it('en táctil, tocar una fila marca sus publicaciones y tocarla de nuevo las desmarca', () => {
    const row = detail().rows[0];
    (window.matchMedia as jasmine.Spy).and.returnValue({ matches: true } as MediaQueryList);
    component.tapRow(row);
    expect(component.isHovered('ml', 'MLA1')).toBeTrue();
    expect(component.isHovered('tn', 10)).toBeTrue();
    component.tapRow(row);
    expect(component.isHovered('ml', 'MLA1')).toBeFalse();
  });

  it('con mouse, el click en una fila no cambia el resaltado', () => {
    (window.matchMedia as jasmine.Spy).and.returnValue({ matches: false } as MediaQueryList);
    component.tapRow(detail().rows[0]);
    expect(component.tappedRow()).toBeNull();
    expect(component.isHovered('ml', 'MLA1')).toBeFalse();
  });

  describe('en el celular', () => {
    beforeEach(() => {
      mockMedia(true);
      fixture = TestBed.createComponent(HubProductsComponent);
      component = fixture.componentInstance;
    });

    function listResponse(rows: HubProductSummary[]) {
      return Promise.resolve({
        rows, total: rows.length,
        counts: { all: 9, orphan: 2, duplicate: 1, desync: 3, only_ml: 1, only_tn: 0, linked: 2 },
        mlConnected: true, tnConnected: true, at: 1,
      });
    }

    it('muestra los números que filtran y la lista en secciones, con Vinculados plegada', async () => {
      hub.list.and.callFake(() => listResponse([
        summary(),
        summary({ key: 'ml:MLA2', name: 'Agenda', status: 'desync', mlStock: 7, tnStock: 5 }),
        summary({ key: 'ml:MLA3', name: 'Repuesto', status: 'only_ml', tnCount: 0 }),
        summary({ key: 'ml:MLA4', name: 'Lapicera', status: 'linked' }),
      ]));
      await render();
      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('.hp-split')).toBeNull();
      const tiles = Array.from(el.querySelectorAll('.ph-tile')).map((t) => Array.from(t.children).map((c) => c.textContent!.trim()).join(' '));
      expect(tiles).toEqual(['2 Sin par', '3 Stock distinto', '1 SKU repetido']);
      const sections = Array.from(el.querySelectorAll('.ph-section')).map((s) => Array.from(s.children).map((c) => c.textContent!.trim()).join(' '));
      expect(sections).toEqual(['Para revisar 2', 'Solo en un canal 1', 'Vinculados 1']);
      expect(el.querySelectorAll('.ph-card').length).toBe(3);
      expect(el.textContent).toContain('stock 7 / 5');
      expect(el.textContent).not.toContain('Lapicera');

      (el.querySelector('.ph-collapsed') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(el.textContent).toContain('Lapicera');
    });

    it('tocar un número filtra por ese estado y tocarlo de nuevo saca el filtro', async () => {
      await render();
      const tile = () => fixture.nativeElement.querySelector('.ph-tile.warn') as HTMLButtonElement;
      tile().click();
      fixture.detectChanges();
      expect(component.status()).toBe('desync');
      expect(tile().classList).toContain('on');
      tile().click();
      expect(component.status()).toBe('');
    });

    it('abre el producto a pantalla completa con las variantes con problema primero', async () => {
      await render();
      (fixture.nativeElement.querySelector('.ph-card') as HTMLButtonElement).click();
      await render();
      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('.ph-tiles')).toBeNull();
      expect(el.querySelector('.ph-detail-bar')!.textContent).toContain('Cuaderno Rivadavia A4');
      const vars = el.querySelectorAll('.ph-var');
      expect(vars.length).toBe(2);
      // La de sin SKU (sin par) va primero, aunque en la lista venga segunda.
      expect(vars[0].classList).toContain('err');
      expect(vars[0].textContent).toContain('No está en TN');
      expect(vars[1].classList).toContain('warn');
      expect(vars[1].querySelectorAll('.ph-s.warn').length).toBe(2);
      expect(el.querySelector('.ph-cta')?.textContent).toContain('Editar publicación');

      (el.querySelectorAll('.ph-seg button')[1] as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(el.querySelectorAll('.ph-pub').length).toBe(3);
      expect(el.querySelector('.ph-pub a')?.getAttribute('href')).toContain('MLA-1');

      (el.querySelector('.ph-back') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(component.selectedKey()).toBeNull();
      expect(el.querySelector('.ph-tiles')).not.toBeNull();
    });

    it('Vincular desde la tarjeta de la variante abre el diálogo', async () => {
      await render();
      component.open('ml:MLA1');
      await render();
      (fixture.nativeElement.querySelector('.ph-link') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(component.linking()?.ml?.variationId).toBe('2');
    });
  });
});
