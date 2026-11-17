import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SupplierOrder } from '../../core/services/orders.service';
import { FactorySheetDialogComponent } from './factory-sheet-dialog.component';

const order: SupplierOrder = {
  id: 17, name: 'Pedido octubre', status: 'borrador', partial: false, discount1: 25, discount2: 5, note: '',
  basedOnId: null, supplierKey: 'punto_cero', createdAt: '2026-10-08T12:00:00.000Z', updatedAt: null, orderedAt: null, receivedAt: null,
  totals: { lineCount: 1, packs: 2, subtotal: 0, discount1Amount: 0, discount2Amount: 0, total: 0, missingPrices: 0 },
  lines: [
    { kind: 'pack', packId: 1, sku: null, code: '4410', description: 'Cuaderno', detail: '', qty: 2, unitPrice: 1000, priceSource: 'precios', unitsPerPack: 8, origin: 'alerta', receivedQty: null },
  ],
};

describe('FactorySheetDialogComponent', () => {
  let fixture: ComponentFixture<FactorySheetDialogComponent>;
  let comp: FactorySheetDialogComponent;
  const file = new File(['x'], 'pedido-17.png', { type: 'image/png' });
  const nav = navigator as unknown as Record<string, unknown>;
  /** La imagen pre-armada al abrir (el toBlob real es asíncrono). */
  const withFile = () => { (comp as unknown as { pngFile: File | null }).pngFile = file; };

  beforeEach(() => {
    fixture = TestBed.configureTestingModule({ imports: [FactorySheetDialogComponent] }).createComponent(FactorySheetDialogComponent);
    fixture.componentRef.setInput('order', order);
    fixture.detectChanges();
    comp = fixture.componentInstance;
  });

  afterEach(() => {
    delete nav['canShare'];
    delete nav['share'];
  });

  it('con el dedo y si el navegador comparte archivos, abre la hoja de compartir (sin descargar)', async () => {
    spyOn(window, 'matchMedia').and.returnValue({ matches: true } as MediaQueryList);
    const share = jasmine.createSpy('share').and.resolveTo();
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    const click = spyOn(HTMLAnchorElement.prototype, 'click');

    withFile();
    comp.downloadImage();
    await Promise.resolve();

    expect(share).toHaveBeenCalledWith({ files: [file], title: 'Pedido octubre' });
    expect(click).not.toHaveBeenCalled();
  });

  it('sin poder compartir archivos (o con mouse), descarga como siempre', () => {
    spyOn(window, 'matchMedia').and.returnValue({ matches: true } as MediaQueryList);
    Object.defineProperty(navigator, 'canShare', { value: () => false, configurable: true });
    const click = spyOn(HTMLAnchorElement.prototype, 'click');

    withFile();
    comp.downloadImage();

    expect(click).toHaveBeenCalled();
    expect(comp.feedback()).toEqual({ text: 'Imagen descargada' });
  });

  it('con mouse no comparte aunque el navegador pueda', () => {
    spyOn(window, 'matchMedia').and.returnValue({ matches: false } as MediaQueryList);
    const share = jasmine.createSpy('share').and.resolveTo();
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    const click = spyOn(HTMLAnchorElement.prototype, 'click');

    withFile();
    comp.downloadImage();

    expect(share).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
  });

  it('si no se puede copiar la tabla, lo dice en vez de no hacer nada', async () => {
    spyOn(navigator.clipboard, 'write').and.rejectWith(new Error('denied'));
    spyOn(navigator.clipboard, 'writeText').and.rejectWith(new Error('denied'));

    await comp.copyTable();
    fixture.detectChanges();

    expect(comp.feedback()?.error).toBeTrue();
    expect(fixture.nativeElement.querySelector('.feedback.err')?.textContent).toContain('No se pudo copiar');
  });
});
