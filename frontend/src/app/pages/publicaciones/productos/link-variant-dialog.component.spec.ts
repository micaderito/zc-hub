import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { HubProductsService, HubVariantRow, LinkCandidate } from '../../../core/services/hub-products.service';
import { LinkVariantDialogComponent } from './link-variant-dialog.component';

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const mlOnly: HubVariantRow = {
  sku: null, duplicate: false, tn: null,
  ml: { itemId: 'MLA1', variationId: '2', variationName: 'Cuadriculado', title: 'Monoblock', sku: null, price: 1, stock: 9, thumbnail: null },
};
const tnOnly: HubVariantRow = {
  sku: 'LED-CUA', duplicate: false, ml: null,
  tn: { productId: 7, variantId: 71, variantName: 'Cuadriculado', productName: 'Monoblock', sku: 'LED-CUA', price: 1, stock: 9, thumbnail: null },
};
const tnCandidate: LinkCandidate = { channel: 'tn', productId: 7, variantId: 71, name: 'Monoblock', variant: 'Cuadriculado', sku: 'LED-CUA', stock: 9, thumbnail: null };
const mlCandidate: LinkCandidate = { channel: 'ml', itemId: 'MLA1', variationId: '2', name: 'Monoblock', variant: 'Cuadriculado', sku: null, stock: 9, thumbnail: null };

describe('LinkVariantDialogComponent', () => {
  let fixture: ComponentFixture<LinkVariantDialogComponent>;
  let component: LinkVariantDialogComponent;
  let hub: { linkCandidates: jasmine.Spy; link: jasmine.Spy };

  async function setup(row: HubVariantRow, candidates: LinkCandidate[]) {
    hub = {
      linkCandidates: jasmine.createSpy('linkCandidates').and.resolveTo(candidates),
      link: jasmine.createSpy('link').and.resolveTo({ ok: true, sku: 'LED-CUA', pendingMl: true }),
    };
    await TestBed.configureTestingModule({
      imports: [LinkVariantDialogComponent],
      providers: [{ provide: HubProductsService, useValue: hub }],
    }).compileComponents();
    fixture = TestBed.createComponent(LinkVariantDialogComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('row', row);
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  }

  it('a una variante que está solo en ML le ofrece las de TN sin par', async () => {
    await setup(mlOnly, [tnCandidate]);
    expect(hub.linkCandidates).toHaveBeenCalledWith('tn', '');
    expect(fixture.nativeElement.textContent).toContain('Vincular "Monoblock · Cuadriculado" con Tienda Nube');
    expect(fixture.nativeElement.textContent).toContain('LED-CUA');
  });

  it('elegir una propone el SKU que ya tenga alguna punta y vincula las dos', async () => {
    await setup(mlOnly, [tnCandidate]);
    expect(component.canConfirm()).toBeFalse();
    component.select(tnCandidate);
    expect(component.sku()).toBe('LED-CUA');
    const emitted: unknown[] = [];
    component.linked.subscribe((v) => emitted.push(v));
    await component.confirm();
    expect(hub.link).toHaveBeenCalledWith({ sku: 'LED-CUA', ml: { itemId: 'MLA1', variationId: '2' }, tn: { productId: 7, variantId: 71 } });
    expect(emitted.length).toBe(1);
  });

  it('desde una variante solo en TN busca en ML', async () => {
    await setup(tnOnly, [mlCandidate]);
    expect(hub.linkCandidates).toHaveBeenCalledWith('ml', '');
    component.select(mlCandidate);
    expect(component.sku()).toBe('LED-CUA');
    await component.confirm();
    expect(hub.link).toHaveBeenCalledWith({ sku: 'LED-CUA', ml: { itemId: 'MLA1', variationId: '2' }, tn: { productId: 7, variantId: 71 } });
  });

  it('sin SKU en ninguna punta no deja confirmar hasta que se escriba uno', async () => {
    await setup(mlOnly, [{ ...tnCandidate, sku: null }]);
    component.select({ ...tnCandidate, sku: null });
    expect(component.canConfirm()).toBeFalse();
    component.sku.set('NUEVO-1');
    expect(component.canConfirm()).toBeTrue();
  });

  it('muestra el error del backend (ej. SKU ya usado)', async () => {
    await setup(mlOnly, [tnCandidate]);
    hub.link.and.rejectWith(new HttpErrorResponse({ status: 409, error: { error: 'El SKU LED-CUA ya lo usa otra variante.' } }));
    component.select(tnCandidate);
    await component.confirm();
    expect(component.error()).toContain('ya lo usa otra variante');
    expect(component.saving()).toBeFalse();
  });
});
