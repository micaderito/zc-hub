import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PhoneSectionComponent } from './phone-section.component';

@Component({
  standalone: true,
  imports: [PhoneSectionComponent],
  template: `
    <zc-phone-section [phone]="phone()" [open]="open()" title="Tienda Nube" accent="tn" summary="Falta la categoría" [missing]="missing()" [complete]="!missing()" (toggle)="toggles = toggles + 1">
      <p class="inner">contenido</p>
    </zc-phone-section>
  `,
})
class HostComponent {
  readonly phone = signal(true);
  readonly open = signal(false);
  readonly missing = signal(1);
  toggles = 0;
}

describe('PhoneSectionComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  const sec = () => fixture.nativeElement.querySelector('zc-phone-section') as HTMLElement;

  beforeEach(() => {
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
  });

  it('en el celular: encabezado con título, resumen y faltantes; cerrada esconde el contenido', () => {
    expect(sec().classList).toContain('is-phone');
    expect(sec().querySelector('.psec-title b')?.textContent).toBe('Tienda Nube');
    expect(sec().querySelector('.psec-sum')?.textContent).toBe('Falta la categoría');
    expect(sec().querySelector('.psec-miss')?.textContent?.trim()).toBe('1');
    expect(getComputedStyle(sec().querySelector('.psec-body')!).display).toBe('none');
  });

  it('abierta muestra el contenido; sin faltantes, el ✓', () => {
    fixture.componentInstance.open.set(true);
    fixture.componentInstance.missing.set(0);
    fixture.detectChanges();
    expect(getComputedStyle(sec().querySelector('.psec-body')!).display).not.toBe('none');
    expect(sec().querySelector('.psec-ok')).not.toBeNull();
    expect(sec().querySelector('.psec-head')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('tocar el encabezado avisa', () => {
    (sec().querySelector('.psec-head') as HTMLButtonElement).click();
    expect(fixture.componentInstance.toggles).toBe(1);
  });

  it('fuera del celular no dibuja nada propio: el contenido se ve tal cual', () => {
    fixture.componentInstance.phone.set(false);
    fixture.detectChanges();
    expect(sec().querySelector('.psec-head')).toBeNull();
    expect(getComputedStyle(sec()).display).toBe('contents');
    expect(sec().querySelector('.inner')).not.toBeNull();
  });
});
