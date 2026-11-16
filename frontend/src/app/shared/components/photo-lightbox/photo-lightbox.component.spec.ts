import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PhotoLightboxComponent } from './photo-lightbox.component';

describe('PhotoLightboxComponent', () => {
  let fixture: ComponentFixture<PhotoLightboxComponent>;
  let comp: PhotoLightboxComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [PhotoLightboxComponent] });
    fixture = TestBed.createComponent(PhotoLightboxComponent);
    fixture.componentRef.setInput('photos', ['a.jpg', 'b.jpg', 'c.jpg']);
    comp = fixture.componentInstance;
    fixture.detectChanges();
  });

  function swipe(dx: number, dy = 0, pointerType = 'touch'): void {
    const stage = fixture.nativeElement.querySelector('.lb-stage') as HTMLElement;
    stage.dispatchEvent(new PointerEvent('pointerdown', { clientX: 200, clientY: 200, pointerType, bubbles: true }));
    stage.dispatchEvent(new PointerEvent('pointerup', { clientX: 200 + dx, clientY: 200 + dy, pointerType, bubbles: true }));
  }

  it('deslizar a la izquierda pasa a la foto siguiente y a la derecha vuelve', () => {
    swipe(-80);
    expect(comp.index()).toBe(1);
    swipe(80);
    expect(comp.index()).toBe(0);
    swipe(80);
    expect(comp.index()).toBe(2);
  });

  it('un toque, un gesto vertical o un arrastre con mouse no cambian de foto', () => {
    swipe(-30);
    swipe(-60, 120);
    swipe(-80, 0, 'mouse');
    expect(comp.index()).toBe(0);
  });

  it('bloquea el scroll de la página mientras está abierto y lo devuelve al cerrar', () => {
    expect(document.body.style.overflow).toBe('hidden');
    fixture.destroy();
    expect(document.body.style.overflow).toBe('');
  });
});
