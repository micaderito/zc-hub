import { ComponentFixture, TestBed } from '@angular/core/testing';

import { TabsComponent, TabDef } from './tabs.component';

describe('TabsComponent', () => {
  let fixture: ComponentFixture<TabsComponent>;
  let component: TabsComponent;

  const tabs: TabDef[] = [
    { key: 'todos', label: 'Todos' },
    { key: 'pendientes', label: 'Pendientes', count: 3, countVariant: 'warn' },
    { key: 'errores', label: 'Errores', count: 2, countVariant: 'err' },
    { key: 'ok', label: 'Sincronizados', count: 0, countVariant: 'ok' },
  ];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TabsComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(TabsComponent);
    component = fixture.componentInstance;
  });

  function setInputs(tabsInput: TabDef[], activeKey: string) {
    fixture.componentRef.setInput('tabs', tabsInput);
    fixture.componentRef.setInput('activeKey', activeKey);
    fixture.detectChanges();
  }

  it('debería renderizar un botón por cada tab', () => {
    setInputs(tabs, 'todos');

    const buttons = fixture.nativeElement.querySelectorAll('button[role="tab"]');
    expect(buttons.length).toBe(4);
    expect(buttons[0].textContent).toContain('Todos');
    expect(buttons[1].textContent).toContain('Pendientes');
  });

  it('no debería renderizar ningún tab cuando la lista está vacía', () => {
    setInputs([], 'todos');

    const buttons = fixture.nativeElement.querySelectorAll('button[role="tab"]');
    expect(buttons.length).toBe(0);
  });

  it('debería marcar como activo el tab cuya key coincide con activeKey', () => {
    setInputs(tabs, 'pendientes');

    const buttons: NodeListOf<HTMLButtonElement> = fixture.nativeElement.querySelectorAll(
      'button[role="tab"]'
    );
    expect(buttons[0].classList.contains('active')).toBeFalse();
    expect(buttons[0].getAttribute('aria-selected')).toBe('false');
    expect(buttons[1].classList.contains('active')).toBeTrue();
    expect(buttons[1].getAttribute('aria-selected')).toBe('true');
  });

  it('no debería mostrar el contador cuando count es undefined', () => {
    setInputs(tabs, 'todos');

    const buttons: NodeListOf<HTMLButtonElement> = fixture.nativeElement.querySelectorAll(
      'button[role="tab"]'
    );
    expect(buttons[0].querySelector('.tab-count')).toBeNull();
  });

  it('debería mostrar el contador y su valor cuando count está definido, incluso si es 0', () => {
    setInputs(tabs, 'todos');

    const buttons: NodeListOf<HTMLButtonElement> = fixture.nativeElement.querySelectorAll(
      'button[role="tab"]'
    );
    const pendientesCount = buttons[1].querySelector('.tab-count');
    expect(pendientesCount?.textContent?.trim()).toBe('3');

    const okCount = buttons[3].querySelector('.tab-count');
    expect(okCount).not.toBeNull();
    expect(okCount?.textContent?.trim()).toBe('0');
  });

  it('debería aplicar la clase de variante correspondiente al contador', () => {
    setInputs(tabs, 'todos');

    const buttons: NodeListOf<HTMLButtonElement> = fixture.nativeElement.querySelectorAll(
      'button[role="tab"]'
    );
    const warnCount = buttons[1].querySelector('.tab-count');
    const errCount = buttons[2].querySelector('.tab-count');
    const okCount = buttons[3].querySelector('.tab-count');

    expect(warnCount?.classList.contains('warn')).toBeTrue();
    expect(warnCount?.classList.contains('err')).toBeFalse();
    expect(errCount?.classList.contains('err')).toBeTrue();
    expect(okCount?.classList.contains('ok')).toBeTrue();
  });

  it('debería emitir tabChange con la key del tab clickeado', () => {
    setInputs(tabs, 'todos');

    let emittedKey: string | undefined;
    component.tabChange.subscribe((key) => (emittedKey = key));

    const buttons: NodeListOf<HTMLButtonElement> = fixture.nativeElement.querySelectorAll(
      'button[role="tab"]'
    );
    buttons[2].click();

    expect(emittedKey).toBe('errores');
  });
});
