import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { homeRedirect, routes } from './app.routes';

describe('routes', () => {
  it('define /login pública y una ruta raíz con el shell protegido por authGuard', () => {
    const topPaths = routes.map(r => r.path);
    expect(topPaths).toEqual(['login', '']);

    const shell = routes.find(r => r.path === '')!;
    expect(shell.canActivate).toBeTruthy();
  });

  it('el shell define una entrada para cada página principal, incluida Usuarios', () => {
    const shell = routes.find(r => r.path === '')!;
    const childPaths = (shell.children ?? []).map(r => r.path);
    expect(childPaths).toEqual([
      '', 'conexiones', 'conflictos', 'precio-stock', 'precios', 'deposito', 'crear', 'publicaciones', 'alertas', 'pedidos', 'pedidos/:id', 'despachos', 'ventas', 'sincronizacion', 'usuarios',
    ]);
  });

  it('login y todas las páginas del shell cargan su componente de forma diferida (loadComponent)', () => {
    expect(typeof routes.find(r => r.path === 'login')!.loadComponent).toBe('function');
    const shell = routes.find(r => r.path === '')!;
    expect(typeof shell.loadComponent).toBe('function');
    // La raíz del shell es un redirect (a Para preparar), no una página.
    for (const child of (shell.children ?? []).filter(r => r.path !== '')) {
      expect(typeof child.loadComponent).toBe('function');
    }
  });

  it('cada loadComponent() resuelve directamente a la clase del componente', async () => {
    const loginComponent = await (routes.find(r => r.path === 'login')!.loadComponent as unknown as () => Promise<unknown>)();
    expect(typeof loginComponent).toBe('function');

    const shell = routes.find(r => r.path === '')!;
    const conexiones = (shell.children ?? []).find(r => r.path === 'conexiones')!;
    const conexionesComponent = await (conexiones.loadComponent as unknown as () => Promise<unknown>)();
    expect(typeof conexionesComponent).toBe('function');
  });
});

@Component({ standalone: true, template: '' })
class BlankComponent {}

describe('homeRedirect', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: '', pathMatch: 'full', redirectTo: homeRedirect },
          { path: 'despachos', component: BlankComponent },
          { path: 'conexiones', component: BlankComponent },
        ]),
      ],
    });
  });

  it('la raíz abre Para preparar', async () => {
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/');
    expect(router.url).toBe('/despachos');
  });

  it('la vuelta del OAuth de ML/TN va a Conexiones conservando el resultado', async () => {
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/?ml_connected=1');
    expect(router.url).toBe('/conexiones?ml_connected=1');
    await router.navigateByUrl('/?tn_error=fallo');
    expect(router.url).toBe('/conexiones?tn_error=fallo');
  });
});
