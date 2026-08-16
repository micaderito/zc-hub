import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideTanStackQuery, QueryClient } from '@tanstack/angular-query-experimental';
import { LayoutComponent } from './layout.component';
import { SessionService, SessionUser } from '../core/services/session.service';
import { ThemeService } from '../core/services/theme.service';

describe('LayoutComponent', () => {
  let sessionSpy: {
    user: jasmine.Spy<() => SessionUser | null>;
    isAuthenticated: jasmine.Spy<() => boolean>;
    logout: jasmine.Spy;
    changePassword: jasmine.Spy;
  };

  function setup(user: SessionUser | null = { id: 1, username: 'mica', displayName: 'Mica' }) {
    sessionSpy = {
      user: jasmine.createSpy('user').and.returnValue(user),
      isAuthenticated: jasmine.createSpy('isAuthenticated').and.returnValue(!!user),
      logout: jasmine.createSpy('logout'),
      changePassword: jasmine.createSpy('changePassword').and.resolveTo(undefined),
    };

    TestBed.configureTestingModule({
      imports: [LayoutComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTanStackQuery(new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })),
        { provide: SessionService, useValue: sessionSpy },
      ],
    });
  }

  it('se crea y arranca con el panel expandido', () => {
    setup();
    const fixture = TestBed.createComponent(LayoutComponent);
    expect(fixture.componentInstance.collapsed()).toBeFalse();
  });

  it('toggleSidebar() alterna el estado colapsado', () => {
    setup();
    const fixture = TestBed.createComponent(LayoutComponent);
    const component = fixture.componentInstance;

    component.toggleSidebar();
    expect(component.collapsed()).toBeTrue();

    component.toggleSidebar();
    expect(component.collapsed()).toBeFalse();
  });

  it('expone los items de navegación principales, incluidos Alertas y Usuarios', () => {
    setup();
    const fixture = TestBed.createComponent(LayoutComponent);
    const paths = fixture.componentInstance.nav.map(i => i.path);
    expect(paths).toEqual([
      '/', '/precio-stock', '/precios', '/deposito', '/crear', '/alertas', '/conflictos', '/sincronizacion', '/usuarios',
    ]);
  });

  it('el botón de tema alterna entre claro y oscuro', () => {
    setup();
    const fixture = TestBed.createComponent(LayoutComponent);
    const theme = TestBed.inject(ThemeService);
    theme.set('light');
    fixture.detectChanges();

    fixture.nativeElement.querySelector('.theme-toggle').click();
    expect(theme.theme()).toBe('dark');
  });

  describe('userInitials', () => {
    it('usa las iniciales de nombre y apellido cuando hay displayName con dos palabras', () => {
      setup({ id: 1, username: 'mica', displayName: 'Mica Derito' });
      const fixture = TestBed.createComponent(LayoutComponent);
      expect(fixture.componentInstance.userInitials()).toBe('MD');
    });

    it('usa las dos primeras letras cuando el nombre es una sola palabra', () => {
      setup({ id: 1, username: 'mica', displayName: null });
      const fixture = TestBed.createComponent(LayoutComponent);
      expect(fixture.componentInstance.userInitials()).toBe('MI');
    });

    it('devuelve "?" si no hay usuario', () => {
      setup(null);
      const fixture = TestBed.createComponent(LayoutComponent);
      expect(fixture.componentInstance.userInitials()).toBe('?');
    });
  });

  describe('logout', () => {
    it('limpia la sesión y manda a /login', () => {
      setup();
      const fixture = TestBed.createComponent(LayoutComponent);
      const router = TestBed.inject(Router);
      spyOn(router, 'navigate');

      fixture.componentInstance.logout();

      expect(sessionSpy.logout).toHaveBeenCalled();
      expect(router.navigate).toHaveBeenCalledWith(['/login']);
    });
  });

  describe('cambiar contraseña', () => {
    it('openPasswordModal limpia el formulario y lo muestra', () => {
      setup();
      const fixture = TestBed.createComponent(LayoutComponent);
      const component = fixture.componentInstance;

      component.openPasswordModal();

      expect(component.showPasswordModal()).toBeTrue();
      expect(component.passwordError()).toBeNull();
    });

    it('savePassword rechaza una contraseña nueva corta sin llamar al servicio', async () => {
      setup();
      const fixture = TestBed.createComponent(LayoutComponent);
      const component = fixture.componentInstance;
      component.newPassword.set('corta');
      component.newPasswordRepeat.set('corta');

      await component.savePassword();

      expect(component.passwordError()).toContain('al menos 8 caracteres');
      expect(sessionSpy.changePassword).not.toHaveBeenCalled();
    });

    it('savePassword rechaza si las contraseñas nuevas no coinciden', async () => {
      setup();
      const fixture = TestBed.createComponent(LayoutComponent);
      const component = fixture.componentInstance;
      component.newPassword.set('nuevaClave123');
      component.newPasswordRepeat.set('otraClave123');

      await component.savePassword();

      expect(component.passwordError()).toContain('no coinciden');
      expect(sessionSpy.changePassword).not.toHaveBeenCalled();
    });

    it('savePassword OK: llama al servicio y cierra el modal', async () => {
      setup();
      const fixture = TestBed.createComponent(LayoutComponent);
      const component = fixture.componentInstance;
      component.currentPassword.set('actual123');
      component.newPassword.set('nuevaClave123');
      component.newPasswordRepeat.set('nuevaClave123');
      component.showPasswordModal.set(true);

      await component.savePassword();

      expect(sessionSpy.changePassword).toHaveBeenCalledWith('actual123', 'nuevaClave123');
      expect(component.showPasswordModal()).toBeFalse();
    });

    it('savePassword muestra el error del backend si falla', async () => {
      setup();
      sessionSpy.changePassword.and.rejectWith({ error: { error: 'La contraseña actual no es correcta' } });
      const fixture = TestBed.createComponent(LayoutComponent);
      const component = fixture.componentInstance;
      component.newPassword.set('nuevaClave123');
      component.newPasswordRepeat.set('nuevaClave123');

      await component.savePassword();

      expect(component.passwordError()).toBe('La contraseña actual no es correcta');
    });
  });
});
