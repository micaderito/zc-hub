import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';

import { ProductThumbComponent, THUMB_RETRY_MS } from './product-thumb.component';
import { largePhotoUrl } from './photo-url';
import { PhotoLightboxService } from '../photo-lightbox/photo-lightbox.service';

describe('ProductThumbComponent', () => {
  let fixture: ComponentFixture<ProductThumbComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ProductThumbComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(ProductThumbComponent);
  });

  afterEach(() => TestBed.inject(PhotoLightboxService).close());

  const lightbox = () => document.querySelector('zc-photo-lightbox');
  const stageSrc = () => document.querySelector('zc-photo-lightbox .lb-stage img')?.getAttribute('src');

  it('debería renderizar un placeholder cuando no hay src', () => {
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('.thumb-placeholder')).not.toBeNull();
  });

  it('debería renderizar un placeholder cuando src es null o vacío, con el ícono pedido', () => {
    fixture.componentRef.setInput('src', '');
    fixture.componentRef.setInput('placeholderIcon', 'ti-package');
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('.thumb-placeholder i')?.classList).toContain('ti-package');
    expect(el.querySelector('[role="button"]')).toBeNull();
  });

  it('debería renderizar la imagen cuando se provee un src', () => {
    fixture.componentRef.setInput('src', 'https://example.com/producto.jpg');
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    const img = el.querySelector('img.thumb-img') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toBe('https://example.com/producto.jpg');
    expect(el.querySelector('.thumb-placeholder')).toBeNull();
  });

  it('al tocar la foto abre el zoom colgado de body, con la de ML en grande', () => {
    fixture.componentRef.setInput('src', 'https://http2.mlstatic.com/D_1-I.jpg');
    fixture.componentRef.setInput('title', 'Agenda 2027');
    fixture.componentRef.setInput('subtitle', 'SKU AGE27');
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('.thumb-wrap') as HTMLElement).click();

    expect(lightbox()?.parentElement).toBe(document.body);
    expect(stageSrc()).toBe('https://http2.mlstatic.com/D_1-O.jpg');
    expect(lightbox()?.textContent).toContain('Agenda 2027');
    expect(lightbox()?.textContent).toContain('SKU AGE27');
  });

  it('con varias fotos arranca en la suya y sin repetidas', () => {
    fixture.componentRef.setInput('src', 'https://tn.example.com/b.jpg');
    fixture.componentRef.setInput('photos', ['https://tn.example.com/a.jpg', null, 'https://tn.example.com/b.jpg', 'https://tn.example.com/a.jpg']);
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('.thumb-wrap') as HTMLElement).click();

    expect(stageSrc()).toBe('https://tn.example.com/b.jpg');
    expect(document.querySelectorAll('zc-photo-lightbox .lb-mini').length).toBe(2);
  });

  it('zoomSrc: arranca en la versión grande de esta foto', () => {
    fixture.componentRef.setInput('src', 'blob:thumb-2');
    fixture.componentRef.setInput('zoomSrc', '/img/2');
    fixture.componentRef.setInput('photos', ['/img/1', '/img/2']);
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('.thumb-wrap') as HTMLElement).click();

    expect(stageSrc()).toBe('/img/2');
  });

  it("zoom='none' muestra solo la miniatura", () => {
    fixture.componentRef.setInput('src', 'https://example.com/a.jpg');
    fixture.componentRef.setInput('zoom', 'none');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[role="button"]')).toBeNull();
    (fixture.nativeElement.querySelector('img') as HTMLElement).click();
    expect(lightbox()).toBeNull();
  });

  it('se abre con Enter desde el teclado', () => {
    fixture.componentRef.setInput('src', 'https://example.com/a.jpg');
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('.thumb-wrap') as HTMLElement)
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(lightbox()).not.toBeNull();
  });

  describe('si la foto no carga', () => {
    const img = () => (fixture.nativeElement as HTMLElement).querySelector('img');
    const fail = () => { img()!.dispatchEvent(new Event('error')); fixture.detectChanges(); };

    it('reintenta una vez y, si vuelve a fallar, muestra el ícono de sin foto', fakeAsync(() => {
      fixture.componentRef.setInput('src', 'https://http2.mlstatic.com/D_1-I.jpg');
      fixture.detectChanges();
      fail();
      expect(img()).toBeNull();
      expect((fixture.nativeElement as HTMLElement).querySelector('.thumb-placeholder')).not.toBeNull();
      tick(THUMB_RETRY_MS);
      fixture.detectChanges();
      expect(img()!.getAttribute('src')).toBe('https://http2.mlstatic.com/D_1-I.jpg?zcr=1');
      fail();
      tick(THUMB_RETRY_MS * 2);
      fixture.detectChanges();
      expect(img()).toBeNull();
    }));

    it('una foto nueva arranca de cero', fakeAsync(() => {
      fixture.componentRef.setInput('src', 'https://x.test/a.jpg');
      fixture.detectChanges();
      fail();
      fixture.componentRef.setInput('src', 'https://x.test/b.jpg');
      fixture.detectChanges();
      expect(img()!.getAttribute('src')).toBe('https://x.test/b.jpg');
      tick(THUMB_RETRY_MS);
      fixture.detectChanges();
      expect(img()!.getAttribute('src')).toBe('https://x.test/b.jpg', 'el reintento de la vieja no pisa la nueva');
    }));

    it('una foto local (blob:) no se reintenta', fakeAsync(() => {
      fixture.componentRef.setInput('src', 'blob:http://localhost/abc');
      fixture.detectChanges();
      fail();
      tick(THUMB_RETRY_MS);
      fixture.detectChanges();
      expect(img()).toBeNull();
    }));
  });
});

@Component({
  standalone: true,
  imports: [ProductThumbComponent],
  template: `
    <button type="button" class="row" (click)="rowClicks.set(rowClicks() + 1)">
      <zc-product-thumb [src]="src" [zoom]="zoom()" title="Cuaderno" />
      <span>Fila</span>
    </button>
    <label class="opt"><input type="checkbox" /> <zc-product-thumb [src]="src" zoom="badge" /></label>
  `,
})
class HostComponent {
  src = 'https://example.com/a.jpg';
  zoom = signal<'image' | 'badge'>('image');
  rowClicks = signal(0);
}

describe('ProductThumbComponent adentro de algo clickeable', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => TestBed.inject(PhotoLightboxService).close());

  it("zoom='image': tocar la foto abre el zoom y NO dispara la fila", () => {
    (fixture.nativeElement.querySelector('.row .thumb-wrap') as HTMLElement).click();
    expect(document.querySelector('zc-photo-lightbox')).not.toBeNull();
    expect(host.rowClicks()).toBe(0);

    // Cerrar el zoom tampoco le llega a la fila (vive en body, no adentro del botón).
    (document.querySelector('zc-photo-lightbox .lb-icon') as HTMLElement).click();
    expect(document.querySelector('zc-photo-lightbox')).toBeNull();
    expect(host.rowClicks()).toBe(0);
  });

  it("zoom='badge': tocar la foto hace lo de la fila; solo la lupita abre el zoom", () => {
    host.zoom.set('badge');
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('.row img') as HTMLElement).click();
    expect(host.rowClicks()).toBe(1);
    expect(document.querySelector('zc-photo-lightbox')).toBeNull();

    (fixture.nativeElement.querySelector('.row .zoom-btn') as HTMLElement).click();
    expect(host.rowClicks()).toBe(1);
    expect(document.querySelector('zc-photo-lightbox')).not.toBeNull();
  });

  it('la lupita adentro de un <label> no tilda el checkbox', () => {
    (fixture.nativeElement.querySelector('.opt .zoom-btn') as HTMLElement).click();
    expect((fixture.nativeElement.querySelector('.opt input') as HTMLInputElement).checked).toBeFalse();
    expect(document.querySelector('zc-photo-lightbox')).not.toBeNull();
  });

  it('Esc cierra el zoom sin que le llegue a un document:keydown de la página (el modal de atrás)', () => {
    const pageEsc = jasmine.createSpy('pageEsc');
    document.addEventListener('keydown', pageEsc);
    (fixture.nativeElement.querySelector('.row .thumb-wrap') as HTMLElement).click();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(document.querySelector('zc-photo-lightbox')).toBeNull();
    expect(pageEsc).not.toHaveBeenCalled();
    document.removeEventListener('keydown', pageEsc);
  });
});

describe('largePhotoUrl', () => {
  it('pasa la miniatura de ML a la original y deja las demás como están', () => {
    expect(largePhotoUrl('https://http2.mlstatic.com/D_NQ_1-I.jpg')).toBe('https://http2.mlstatic.com/D_NQ_1-O.jpg');
    expect(largePhotoUrl('https://dcdn.mitiendanube.com/p/foto-A.jpg')).toBe('https://dcdn.mitiendanube.com/p/foto-A.jpg');
    expect(largePhotoUrl(null)).toBeNull();
  });
});
