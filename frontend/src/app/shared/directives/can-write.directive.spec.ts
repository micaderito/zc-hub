import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CanWriteDirective } from './can-write.directive';
import { SessionService } from '../../core/services/session.service';

@Component({
  standalone: true,
  imports: [CanWriteDirective],
  template: `<button class="edit" *zcCanWrite>Editar</button><span class="always">Ver</span>`,
})
class HostComponent {}

describe('CanWriteDirective', () => {
  const isAdmin = signal(true);

  function render() {
    TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [{ provide: SessionService, useValue: { isAdmin } }],
    });
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    return fixture;
  }

  it('muestra el bloque a un admin', () => {
    isAdmin.set(true);
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.edit')).not.toBeNull();
  });

  it('lo esconde a lectura sin tocar el resto', () => {
    isAdmin.set(false);
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.edit')).toBeNull();
    expect(fixture.nativeElement.querySelector('.always')).not.toBeNull();
  });

  it('reacciona si el rol cambia', () => {
    isAdmin.set(false);
    const fixture = render();
    isAdmin.set(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.edit')).not.toBeNull();
    isAdmin.set(false);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.edit')).toBeNull();
  });
});
