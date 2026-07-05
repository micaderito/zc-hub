import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';

import { CrearProductoComponent } from './crear-producto.component';
import { PublishResult } from './product-draft.model';

describe('CrearProductoComponent', () => {
  let component: CrearProductoComponent;
  let fixture: ComponentFixture<CrearProductoComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CrearProductoComponent]
    }).compileComponents();

    fixture = TestBed.createComponent(CrearProductoComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('se crea correctamente', () => {
    expect(component).toBeTruthy();
  });

  describe('estado inicial (seedDraft)', () => {
    it('carga datos comunes de ejemplo con el SKU base', () => {
      expect(component.draft().common.baseName).toBe('Cuaderno A4 Tapa Dura');
      expect(component.draft().common.sku).toBe('CUA-A4-TD');
    });

    it('no arranca con variantes ni ejes', () => {
      expect(component.draft().axes).toEqual([]);
      expect(component.draft().variants).toEqual([]);
    });

    it('no muestra resultados de publicación y no está publicando', () => {
      expect(component.publishResults()).toBeNull();
      expect(component.publishing()).toBeFalse();
    });

    it('carga título y descripción de ML como propios (no heredados)', () => {
      expect(component.draft().ml.title.inherited).toBeFalse();
      expect(component.draft().ml.title.value).toContain('Cuaderno A4 Tapa Dura');
    });

    it('carga el nombre (es) de TN como heredado del común', () => {
      expect(component.draft().tn.nameEs.inherited).toBeTrue();
      expect(component.draft().tn.nameEs.value).toBe('Cuaderno A4 Tapa Dura');
    });
  });

  describe('hasVariants / proyecciones', () => {
    it('hasVariants() es false cuando no hay ejes', () => {
      expect(component.hasVariants()).toBeFalse();
    });

    it('hasVariants() es true después de agregar un eje', () => {
      component.addAxis();
      expect(component.hasVariants()).toBeTrue();
    });

    it('mlProjection y tnProjection reflejan el modo por defecto (single_with_variants, sin variantes)', () => {
      expect(component.mlProjection()).toBe('1 publicación');
      expect(component.tnProjection()).toBe('1 producto');
    });

    it('mlProjection cambia al agregar variantes', () => {
      // addAxis() solo crea la primera variante automáticamente; para tener más de una
      // variante (y que el modo single_with_variants muestre "con N variantes") hace
      // falta agregar una variante extra explícitamente.
      component.addAxis();
      component.addVariant();
      expect(component.draft().variants.length).toBeGreaterThan(1);
      expect(component.mlProjection()).toContain('con');
    });

    it('mlProjection refleja el modo one_per_variant', () => {
      component.addAxis();
      component.addVariant();
      component.setMode('ml', 'one_per_variant');
      expect(component.mlProjection()).toContain('publicaciones');
    });
  });

  describe('override-on-demand: effective / makeOwn / revert', () => {
    it('effective() devuelve el valor común cuando el campo está heredado', () => {
      const field = { inherited: true, value: 'propio' };
      expect(component.effective(field, 'común')).toBe('común');
    });

    it('effective() devuelve el valor propio cuando el campo no está heredado', () => {
      const field = { inherited: false, value: 'propio' };
      expect(component.effective(field, 'común')).toBe('propio');
    });

    it('makeOwn() marca el campo como propio y copia el valor común si está vacío', () => {
      const field = { inherited: true, value: '' };
      component.makeOwn(field, 'Nombre común');
      expect(field.inherited).toBeFalse();
      expect(field.value).toBe('Nombre común');
    });

    it('makeOwn() no pisa un valor propio ya cargado', () => {
      const field = { inherited: true, value: 'ya tenía algo' };
      component.makeOwn(field, 'Nombre común');
      expect(field.inherited).toBeFalse();
      expect(field.value).toBe('ya tenía algo');
    });

    it('revert() vuelve a marcar el campo como heredado', () => {
      const field = { inherited: false, value: 'propio' };
      component.revert(field);
      expect(field.inherited).toBeTrue();
    });

    it('makeOwn() y revert() disparan una nueva referencia de la señal draft', () => {
      const before = component.draft();
      component.makeOwn(component.draft().tn.nameEs, component.draft().common.baseName);
      const after = component.draft();
      expect(after).not.toBe(before);
    });
  });

  describe('setMode()', () => {
    it('cambia el mappingMode de ML sin afectar el de TN', () => {
      component.setMode('ml', 'one_per_variant');
      expect(component.draft().ml.mappingMode).toBe('one_per_variant');
      expect(component.draft().tn.mappingMode).toBe('single_with_variants');
    });

    it('cambia el mappingMode de TN sin afectar el de ML', () => {
      component.setMode('tn', 'one_per_variant');
      expect(component.draft().tn.mappingMode).toBe('one_per_variant');
      expect(component.draft().ml.mappingMode).toBe('single_with_variants');
    });
  });

  describe('variantes: addAxis / removeAxis / addVariant / removeVariant', () => {
    it('addAxis() agrega un eje vacío', () => {
      component.addAxis();
      expect(component.draft().axes.length).toBe(1);
      expect(component.draft().axes[0].name).toBe('');
    });

    it('addAxis() crea automáticamente una primera variante si no existía ninguna', () => {
      expect(component.draft().variants.length).toBe(0);
      component.addAxis();
      expect(component.draft().variants.length).toBe(1);
      expect(component.draft().variants[0].values).toEqual(['']);
    });

    it('addAxis() agrega un valor vacío por cada variante existente al sumar un segundo eje', () => {
      component.addAxis();
      component.addVariant();
      expect(component.draft().variants.length).toBe(2);

      component.addAxis();
      expect(component.draft().axes.length).toBe(2);
      for (const v of component.draft().variants) {
        expect(v.values.length).toBe(2);
      }
    });

    it('addAxis() no permite más de 3 ejes', () => {
      component.addAxis();
      component.addAxis();
      component.addAxis();
      expect(component.draft().axes.length).toBe(3);

      component.addAxis();
      expect(component.draft().axes.length).toBe(3);
    });

    it('removeAxis() quita el eje y el valor correspondiente de cada variante', () => {
      component.addAxis();
      component.addAxis();
      component.draft().variants[0].values = ['Negro', 'A4'];

      component.removeAxis(0);

      expect(component.draft().axes.length).toBe(1);
      expect(component.draft().variants[0].values).toEqual(['A4']);
    });

    it('removeAxis() vacía las variantes cuando no queda ningún eje', () => {
      component.addAxis();
      expect(component.draft().variants.length).toBe(1);

      component.removeAxis(0);

      expect(component.draft().axes).toEqual([]);
      expect(component.draft().variants).toEqual([]);
    });

    it('addVariant() agrega una variante con ids de precio/stock en null y valores vacíos por eje', () => {
      component.addAxis();
      const countBefore = component.draft().variants.length;

      component.addVariant();

      const variants = component.draft().variants;
      expect(variants.length).toBe(countBefore + 1);
      const nueva = variants[variants.length - 1];
      expect(nueva.sku).toBe('');
      expect(nueva.values).toEqual(['']);
      expect(nueva.ml).toEqual({ price: null, stock: null });
      expect(nueva.tn).toEqual({ price: null, promoPrice: null, stock: null });
      expect(nueva.id).toMatch(/^v\d+$/);
    });

    it('addVariant() genera ids únicos entre llamadas sucesivas', () => {
      component.addVariant();
      component.addVariant();
      const variants = component.draft().variants;
      const ids = variants.map((v) => v.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('removeVariant() quita solo la variante con el id indicado', () => {
      component.addVariant();
      component.addVariant();
      const [first, second] = component.draft().variants;

      component.removeVariant(first.id);

      expect(component.draft().variants.length).toBe(1);
      expect(component.draft().variants[0].id).toBe(second.id);
    });

    it('removeVariant() con un id inexistente no modifica la lista', () => {
      component.addVariant();
      const before = component.draft().variants.length;

      component.removeVariant('no-existe');

      expect(component.draft().variants.length).toBe(before);
    });
  });

  describe('atributos ML: addMlAttribute / removeMlAttribute', () => {
    it('addMlAttribute() agrega un atributo vacío no heredado', () => {
      const before = component.draft().ml.attributes.length;
      component.addMlAttribute();
      const attrs = component.draft().ml.attributes;
      expect(attrs.length).toBe(before + 1);
      expect(attrs[attrs.length - 1]).toEqual({ id: '', name: '', value: '', required: false, inherited: false });
    });

    it('removeMlAttribute() quita el atributo en el índice indicado', () => {
      component.addMlAttribute();
      const before = component.draft().ml.attributes.length;

      component.removeMlAttribute(0);

      expect(component.draft().ml.attributes.length).toBe(before - 1);
    });
  });

  describe('imágenes: addImage / removeImage', () => {
    it('addImage("ml") agrega una imagen a la galería de ML sin afectar la de TN', () => {
      const mlBefore = component.draft().ml.images.length;
      const tnBefore = component.draft().tn.images.length;

      component.addImage('ml');

      expect(component.draft().ml.images.length).toBe(mlBefore + 1);
      expect(component.draft().tn.images.length).toBe(tnBefore);
    });

    it('addImage("tn") agrega una imagen a la galería de TN sin afectar la de ML', () => {
      const mlBefore = component.draft().ml.images.length;
      const tnBefore = component.draft().tn.images.length;

      component.addImage('tn');

      expect(component.draft().tn.images.length).toBe(tnBefore + 1);
      expect(component.draft().ml.images.length).toBe(mlBefore);
    });

    it('removeImage() quita la imagen en el índice indicado del canal correspondiente', () => {
      component.addImage('ml');
      const before = component.draft().ml.images.length;

      component.removeImage('ml', 0);

      expect(component.draft().ml.images.length).toBe(before - 1);
    });
  });

  describe('publish()', () => {
    it('marca publishing en true y limpia publishResults al iniciar', () => {
      component.publish();
      expect(component.publishing()).toBeTrue();
      expect(component.publishResults()).toBeNull();
    });

    it('después de la simulación de red, resuelve con éxito en ambos canales y apaga el flag de publicando', fakeAsync(() => {
      component.publish();
      tick(600);

      expect(component.publishing()).toBeFalse();
      const results = component.publishResults();
      expect(results).not.toBeNull();
      expect(results!.length).toBe(2);
      expect(results!.find((r) => r.channel === 'ml')?.status).toBe('ok');
      expect(results!.find((r) => r.channel === 'tn')?.status).toBe('ok');
    }));
  });

  describe('buildPayloads()', () => {
    it('calcula las dimensiones combinadas de ML cuando están todas presentes', () => {
      const payload = component.buildPayloads();
      const ml = payload.ml as any;
      expect(ml.shipping.dimensions).toBe('30x22x3,480');
    });

    it('deja las dimensiones en null si falta algún dato de medidas', () => {
      component.draft().common.heightCm = null;
      const payload = component.buildPayloads();
      const ml = payload.ml as any;
      expect(ml.shipping.dimensions).toBeNull();
    });

    it('usa el valor efectivo (propio u heredado) para el título y la descripción de ML', () => {
      const payload = component.buildPayloads();
      const ml = payload.ml as any;
      expect(ml.title).toBe(component.draft().ml.title.value);
    });

    it('agrega el SELLER_SKU al final de los atributos de ML con el SKU común', () => {
      const payload = component.buildPayloads();
      const ml = payload.ml as any;
      const last = ml.attributes[ml.attributes.length - 1];
      expect(last).toEqual({ id: 'SELLER_SKU', value_name: component.draft().common.sku });
    });

    it('arma el nombre de TN con el idioma "es" efectivo y "pt" undefined si está vacío', () => {
      component.draft().tn.namePt = '';
      const payload = component.buildPayloads();
      const tn = payload.tn as any;
      expect(tn.name.es).toBe(component.draft().common.baseName);
      expect(tn.name.pt).toBeUndefined();
    });

    it('deja "handle" undefined en TN cuando no se cargó ninguno', () => {
      component.draft().tn.handle = '';
      const payload = component.buildPayloads();
      const tn = payload.tn as any;
      expect(tn.handle).toBeUndefined();
    });

    it('arma "handle" en TN como { es } cuando sí está cargado', () => {
      component.draft().tn.handle = 'mi-handle';
      const payload = component.buildPayloads();
      const tn = payload.tn as any;
      expect(tn.handle).toEqual({ es: 'mi-handle' });
    });

    it('sin variantes, arma un único registro de variante TN a partir de los datos comunes', () => {
      const payload = component.buildPayloads();
      const tn = payload.tn as any;
      expect(tn.variants.length).toBe(1);
      expect(tn.variants[0]).toEqual({
        sku: component.draft().common.sku,
        barcode: component.draft().common.barcode,
        weight: component.draft().common.weightG! / 1000,
        width: component.draft().common.widthCm,
        height: component.draft().common.heightCm,
        depth: component.draft().common.lengthCm
      });
    });

    it('con variantes, arma un registro TN por variante con nombres de eje y valores', () => {
      component.addAxis();
      component.draft().axes[0].name = 'Color';
      component.draft().variants[0].sku = 'CUA-A4-TD-NEGRO';
      component.draft().variants[0].values = ['Negro'];
      component.draft().variants[0].tn = { price: 1000, promoPrice: 900, stock: 5 };

      const payload = component.buildPayloads();
      const tn = payload.tn as any;

      expect(tn.variants.length).toBe(1);
      expect(tn.variants[0].sku).toBe('CUA-A4-TD-NEGRO');
      expect(tn.variants[0].values).toEqual([{ es: 'Color: Negro' }]);
      expect(tn.variants[0].price).toBe(1000);
      expect(tn.variants[0].promotional_price).toBe(900);
      expect(tn.variants[0].stock).toBe(5);
    });

    it('convierte el peso de gramos a kilogramos para TN, o lo deja en null si no hay peso', () => {
      component.draft().common.weightG = null;
      const payload = component.buildPayloads();
      const tn = payload.tn as any;
      expect(tn.variants[0].weight).toBeNull();
    });
  });

  describe('dismissResults() / retry()', () => {
    it('dismissResults() limpia los resultados de publicación', fakeAsync(() => {
      component.publish();
      tick(600);
      expect(component.publishResults()).not.toBeNull();

      component.dismissResults();

      expect(component.publishResults()).toBeNull();
    }));

    it('retry() no hace nada si todavía no hay resultados', () => {
      expect(component.publishResults()).toBeNull();
      component.retry('ml');
      expect(component.publishResults()).toBeNull();
    });

    it('retry("ml") marca el canal ML como ok con el detalle esperado, sin tocar TN', () => {
      const initial: PublishResult[] = [
        { channel: 'ml', status: 'error', detail: 'Error de categoría' },
        { channel: 'tn', status: 'error', detail: 'Error de stock' }
      ];
      component.publishResults.set(initial);

      component.retry('ml');

      const results = component.publishResults()!;
      const ml = results.find((r) => r.channel === 'ml')!;
      const tn = results.find((r) => r.channel === 'tn')!;
      expect(ml.status).toBe('ok');
      expect(ml.detail).toBe('Publicación creada');
      expect(tn.status).toBe('error');
      expect(tn.detail).toBe('Error de stock');
    });

    it('retry("tn") marca el canal TN como ok con el detalle esperado, sin tocar ML', () => {
      const initial: PublishResult[] = [
        { channel: 'ml', status: 'error', detail: 'Error de categoría' },
        { channel: 'tn', status: 'error', detail: 'Error de stock' }
      ];
      component.publishResults.set(initial);

      component.retry('tn');

      const results = component.publishResults()!;
      const ml = results.find((r) => r.channel === 'ml')!;
      const tn = results.find((r) => r.channel === 'tn')!;
      expect(ml.status).toBe('error');
      expect(tn.status).toBe('ok');
      expect(tn.detail).toBe('Producto creado');
    });
  });
});
