import { emptyDraft } from './product-draft.model';
import { phoneSectionStates } from './phone-sections';

describe('phoneSectionStates', () => {
  it('sin faltantes: una línea con lo cargado en cada sección', () => {
    const d = emptyDraft();
    d.common.baseName = 'Cuaderno A4';
    d.common.weightG = 480;
    d.common.sku = 'CUA-A4';
    d.common.baseStock = 12;
    d.ml.categoryName = 'Cuadernos';
    d.tn.categories = [1, 2];
    d.alert.enabled = true;
    d.alert.threshold = 3;
    const s = phoneSectionStates(d, [], 'Punto Cero');
    expect(s.common).toEqual({ missing: 0, summary: 'Cuaderno A4 · Nuevo · 480 g' });
    expect(s.ml.summary).toBe('Cuadernos · 1 publicación · 0 fotos');
    expect(s.tn.summary).toBe('2 categorías · 1 producto · 0 fotos');
    expect(s.price.summary).toBe(`Punto Cero · ganancia ${d.cost.marginPct}%`);
    expect(s.variants.summary).toBe('Producto simple · SKU CUA-A4 · stock 12');
    expect(s.alert.summary).toBe('Avisar con 3 o menos');
  });

  it('con faltantes: cuenta los de cada sección y muestra el primero', () => {
    const s = phoneSectionStates(
      emptyDraft(),
      [
        { section: 'variants', text: 'Falta el SKU' },
        { section: 'ml', text: 'Elegí una categoría de Mercado Libre' },
        { section: 'variants', text: 'Falta el stock' },
      ],
      null
    );
    expect(s.variants).toEqual({ missing: 2, summary: 'Falta el SKU' });
    expect(s.ml).toEqual({ missing: 1, summary: 'Elegí una categoría de Mercado Libre' });
    expect(s.tn.missing).toBe(0);
    expect(s.price.summary).toContain('Sin proveedor');
    expect(s.alert.summary).toBe('Sin alerta');
  });

  it('con variantes: cuántas y los ejes', () => {
    const d = emptyDraft();
    d.axes = [{ name: 'Color', values: ['Rojo', 'Azul'] } as never];
    d.variants = [{} as never, {} as never];
    expect(phoneSectionStates(d, [], null).variants.summary).toBe('2 variantes · Color');
  });
});
