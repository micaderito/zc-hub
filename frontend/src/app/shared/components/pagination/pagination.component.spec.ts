import { ComponentFixture, TestBed } from '@angular/core/testing';

import { PaginationComponent } from './pagination.component';

describe('PaginationComponent', () => {
  let fixture: ComponentFixture<PaginationComponent>;
  let component: PaginationComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PaginationComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(PaginationComponent);
    component = fixture.componentInstance;
  });

  function setInputs(currentPage: number, totalPages: number, total: number) {
    fixture.componentRef.setInput('currentPage', currentPage);
    fixture.componentRef.setInput('totalPages', totalPages);
    fixture.componentRef.setInput('total', total);
    fixture.detectChanges();
  }

  it('no debería renderizar el nav cuando hay una sola página', () => {
    setInputs(1, 1, 3);

    const nav = fixture.nativeElement.querySelector('nav.pagination');
    expect(nav).toBeNull();
  });

  it('no debería renderizar el nav cuando totalPages es 0', () => {
    setInputs(1, 0, 0);

    const nav = fixture.nativeElement.querySelector('nav.pagination');
    expect(nav).toBeNull();
  });

  it('debería renderizar el nav y la info de paginación cuando hay más de una página', () => {
    setInputs(2, 5, 42);

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('nav.pagination')).not.toBeNull();
    expect(el.querySelector('.page-current')?.textContent).toContain('2');
    expect(el.querySelector('.page-total')?.textContent).toContain('5');
    expect(el.querySelector('.page-results')?.textContent).toContain('42 resultados');
  });

  it('debería usar el singular "resultado" cuando total es 1', () => {
    setInputs(1, 2, 1);

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.page-results')?.textContent).toContain('1 resultado)');
    expect(el.querySelector('.page-results')?.textContent).not.toContain('resultados');
  });

  it('debería deshabilitar el botón anterior en la primera página', () => {
    setInputs(1, 3, 10);

    const buttons = fixture.nativeElement.querySelectorAll('button.page-btn');
    expect((buttons[0] as HTMLButtonElement).disabled).toBeTrue();
    expect((buttons[1] as HTMLButtonElement).disabled).toBeFalse();
  });

  it('debería deshabilitar el botón siguiente en la última página', () => {
    setInputs(3, 3, 10);

    const buttons = fixture.nativeElement.querySelectorAll('button.page-btn');
    expect((buttons[0] as HTMLButtonElement).disabled).toBeFalse();
    expect((buttons[1] as HTMLButtonElement).disabled).toBeTrue();
  });

  it('debería emitir prev al hacer click en el botón anterior', () => {
    setInputs(2, 3, 10);

    let prevEmitted = false;
    component.prev.subscribe(() => (prevEmitted = true));

    const buttons = fixture.nativeElement.querySelectorAll('button.page-btn');
    (buttons[0] as HTMLButtonElement).click();

    expect(prevEmitted).toBeTrue();
  });

  it('debería emitir next al hacer click en el botón siguiente', () => {
    setInputs(2, 3, 10);

    let nextEmitted = false;
    component.next.subscribe(() => (nextEmitted = true));

    const buttons = fixture.nativeElement.querySelectorAll('button.page-btn');
    (buttons[1] as HTMLButtonElement).click();

    expect(nextEmitted).toBeTrue();
  });
});
