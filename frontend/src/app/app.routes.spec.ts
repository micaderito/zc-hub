import { routes } from './app.routes';

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
      '', 'conflictos', 'precio-stock', 'precios', 'deposito', 'crear', 'sincronizacion', 'usuarios',
    ]);
  });

  it('login y todas las páginas del shell cargan su componente de forma diferida (loadComponent)', () => {
    expect(typeof routes.find(r => r.path === 'login')!.loadComponent).toBe('function');
    const shell = routes.find(r => r.path === '')!;
    expect(typeof shell.loadComponent).toBe('function');
    for (const child of shell.children ?? []) {
      expect(typeof child.loadComponent).toBe('function');
    }
  });

  it('cada loadComponent() resuelve directamente a la clase del componente', async () => {
    const loginComponent = await (routes.find(r => r.path === 'login')!.loadComponent as unknown as () => Promise<unknown>)();
    expect(typeof loginComponent).toBe('function');

    const shell = routes.find(r => r.path === '')!;
    const dashboard = (shell.children ?? []).find(r => r.path === '')!;
    const dashboardComponent = await (dashboard.loadComponent as unknown as () => Promise<unknown>)();
    expect(typeof dashboardComponent).toBe('function');
  });
});
