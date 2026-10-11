import { TestBed } from '@angular/core/testing';
import { Router, UrlTree } from '@angular/router';
import { adminGuard } from './admin.guard';
import { SessionService } from '../services/session.service';

describe('adminGuard', () => {
  function run(isAdmin: boolean) {
    const urlTree = {} as UrlTree;
    const routerSpy = jasmine.createSpyObj<Router>('Router', ['createUrlTree']);
    routerSpy.createUrlTree.and.returnValue(urlTree);
    TestBed.configureTestingModule({
      providers: [
        { provide: SessionService, useValue: { isAdmin: () => isAdmin } },
        { provide: Router, useValue: routerSpy },
      ],
    });
    return { result: TestBed.runInInjectionContext(() => adminGuard({} as never, {} as never)), routerSpy, urlTree };
  }

  it('deja pasar a un admin', () => {
    expect(run(true).result).toBeTrue();
  });

  it('manda a lectura al inicio', () => {
    const { result, routerSpy, urlTree } = run(false);
    expect(result).toBe(urlTree);
    expect(routerSpy.createUrlTree).toHaveBeenCalledWith(['/']);
  });
});
