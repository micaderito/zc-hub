import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ProductThumbComponent } from './product-thumb.component';

describe('ProductThumbComponent', () => {
  let fixture: ComponentFixture<ProductThumbComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ProductThumbComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(ProductThumbComponent);
  });

  it('debería renderizar un placeholder cuando no hay src', () => {
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('.thumb-placeholder')).not.toBeNull();
  });

  it('debería renderizar un placeholder cuando src es null', () => {
    fixture.componentRef.setInput('src', null);
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('.thumb-placeholder')).not.toBeNull();
  });

  it('debería renderizar un placeholder cuando src es una cadena vacía', () => {
    fixture.componentRef.setInput('src', '');
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('.thumb-placeholder')).not.toBeNull();
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
});
