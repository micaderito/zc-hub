import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AppComponent } from './app.component';
import { GlobalErrorService } from './core/services/global-error.service';
import { ThemeService } from './core/services/theme.service';

describe('AppComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [provideRouter([])]
    });
  });

  it('se crea y arranca con el panel expandido', () => {
    const fixture = TestBed.createComponent(AppComponent);
    expect(fixture.componentInstance.collapsed()).toBeFalse();
  });

  it('toggleSidebar() alterna el estado colapsado', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const component = fixture.componentInstance;

    component.toggleSidebar();
    expect(component.collapsed()).toBeTrue();

    component.toggleSidebar();
    expect(component.collapsed()).toBeFalse();
  });

  it('expone los 5 items de navegación principales', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const paths = fixture.componentInstance.nav.map(i => i.path);
    expect(paths).toEqual(['/', '/precio-stock', '/crear', '/conflictos', '/sincronizacion']);
  });

  it('muestra el banner de error global cuando GlobalErrorService tiene un mensaje', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const globalError = TestBed.inject(GlobalErrorService);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.global-error')).toBeNull();

    globalError.show('algo falló');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.global-error-text').textContent).toContain('algo falló');
  });

  it('el botón de cerrar del error global limpia el mensaje', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const globalError = TestBed.inject(GlobalErrorService);
    globalError.show('algo falló');
    fixture.detectChanges();

    fixture.nativeElement.querySelector('.global-error-dismiss').click();
    fixture.detectChanges();

    expect(globalError.message()).toBeNull();
    expect(fixture.nativeElement.querySelector('.global-error')).toBeNull();
  });

  it('el botón de tema alterna entre claro y oscuro', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const theme = TestBed.inject(ThemeService);
    theme.set('light');
    fixture.detectChanges();

    fixture.nativeElement.querySelector('.theme-toggle').click();
    expect(theme.theme()).toBe('dark');
  });
});
