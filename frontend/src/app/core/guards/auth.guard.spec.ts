import { TestBed } from '@angular/core/testing';
import { Router, UrlTree } from '@angular/router';
import { authGuard } from './auth.guard';
import { SessionService } from '../services/session.service';

describe('authGuard', () => {
  function run(isAuthenticated: boolean) {
    const sessionSpy = { isAuthenticated: () => isAuthenticated };
    const urlTree = {} as UrlTree;
    const routerSpy = jasmine.createSpyObj<Router>('Router', ['createUrlTree']);
    routerSpy.createUrlTree.and.returnValue(urlTree);

    TestBed.configureTestingModule({
      providers: [
        { provide: SessionService, useValue: sessionSpy },
        { provide: Router, useValue: routerSpy },
      ],
    });

    return TestBed.runInInjectionContext(() => authGuard({} as never, {} as never));
  }

  it('deja pasar cuando hay sesión', () => {
    expect(run(true)).toBeTrue();
  });

  it('redirige a /login cuando no hay sesión', () => {
    const result = run(false);
    expect(result).not.toBeTrue();
  });
});
