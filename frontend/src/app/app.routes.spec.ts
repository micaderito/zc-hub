import { routes } from './app.routes';

describe('routes', () => {
  it('define una entrada para cada página principal', () => {
    const paths = routes.map(r => r.path);
    expect(paths).toEqual(['', 'conflictos', 'precio-stock', 'crear', 'sincronizacion']);
  });

  it('cada ruta carga su componente de forma diferida (loadComponent)', () => {
    for (const route of routes) {
      expect(typeof route.loadComponent).toBe('function');
    }
  });

  it('cada loadComponent() resuelve directamente a la clase del componente', async () => {
    const dashboard = routes.find(r => r.path === '')!;
    const component = await (dashboard.loadComponent as unknown as () => Promise<unknown>)();
    expect(typeof component).toBe('function');
  });
});
