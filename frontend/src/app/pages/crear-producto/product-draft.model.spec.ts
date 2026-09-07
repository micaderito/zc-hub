import {
  defaultVariantTitle,
  emptyDraft,
  inherited,
  listingTypeLabel,
  normalizeDraft,
  normalizeVariant,
  positiveLimit,
  projectionLabel,
  variantLabel
} from './product-draft.model';

describe('product-draft.model', () => {
  describe('inherited()', () => {
    it('crea un OverrideField marcado como heredado con el valor recibido', () => {
      const field = inherited('Cuaderno A4');
      expect(field).toEqual({ inherited: true, value: 'Cuaderno A4' });
    });

    it('acepta valores de cualquier tipo (genérico), no solo strings', () => {
      const field = inherited(42);
      expect(field.inherited).toBeTrue();
      expect(field.value).toBe(42);
    });

    it('funciona con string vacío como valor', () => {
      const field = inherited('');
      expect(field).toEqual({ inherited: true, value: '' });
    });
  });

  describe('listingTypeLabel()', () => {
    it('traduce "gold_special" a "Clásica"', () => {
      expect(listingTypeLabel('gold_special')).toBe('Clásica');
    });

    it('traduce "gold_pro" a "Premium"', () => {
      expect(listingTypeLabel('gold_pro')).toBe('Premium');
    });

    it('traduce "free" a "Gratuita"', () => {
      expect(listingTypeLabel('free')).toBe('Gratuita');
    });
  });

  describe('projectionLabel()', () => {
    it('ML con 0 variantes y modo single_with_variants muestra "1 publicación" (mínimo 1)', () => {
      expect(projectionLabel('ml', 'single_with_variants', 0)).toBe('1 publicación');
    });

    it('ML con 1 variante y modo single_with_variants muestra "1 publicación" (singular, sin "con N variantes")', () => {
      expect(projectionLabel('ml', 'single_with_variants', 1)).toBe('1 publicación');
    });

    it('ML con varias variantes y modo single_with_variants agrupa en una sola publicación', () => {
      expect(projectionLabel('ml', 'single_with_variants', 3)).toBe('1 publicación con 3 variantes');
    });

    it('ML con 1 variante y modo one_per_variant muestra "1 publicación" (no plural con una sola)', () => {
      expect(projectionLabel('ml', 'one_per_variant', 1)).toBe('1 publicación');
    });

    it('ML con varias variantes y modo one_per_variant genera una publicación por variante', () => {
      expect(projectionLabel('ml', 'one_per_variant', 4)).toBe('4 publicaciones (uno por variante)');
    });

    it('TN con 0 variantes y modo single_with_variants usa la unidad "producto"', () => {
      expect(projectionLabel('tn', 'single_with_variants', 0)).toBe('1 producto');
    });

    it('TN con varias variantes y modo single_with_variants agrupa en un solo producto', () => {
      expect(projectionLabel('tn', 'single_with_variants', 2)).toBe('1 producto con 2 variantes');
    });

    it('TN con varias variantes y modo one_per_variant genera un producto por variante', () => {
      expect(projectionLabel('tn', 'one_per_variant', 5)).toBe('5 productos (uno por variante)');
    });

    it('TN con 1 variante y modo one_per_variant muestra "1 producto" (no plural)', () => {
      expect(projectionLabel('tn', 'one_per_variant', 1)).toBe('1 producto');
    });

    it('un variantCount negativo se trata igual que 0 o 1 (mínimo 1)', () => {
      expect(projectionLabel('ml', 'single_with_variants', -5)).toBe('1 publicación');
    });
  });

  describe('emptyDraft()', () => {
    it('arranca sin axes ni variants', () => {
      const draft = emptyDraft();
      expect(draft.axes).toEqual([]);
      expect(draft.variants).toEqual([]);
    });

    it('inicializa common con strings vacíos, condición "new" y dimensiones/stock en null', () => {
      const draft = emptyDraft();
      expect(draft.common).toEqual({
        baseName: '',
        sku: '',
        brand: '',
        barcode: '',
        condition: 'new',
        weightG: null,
        lengthCm: null,
        widthCm: null,
        heightCm: null,
        seoKeywords: '',
        baseStock: null,
        mpn: '',
        ageGroup: 'adult',
        gender: 'unisex'
      });
    });

    it('mpn/ageGroup/gender (Instagram/Google Shopping de TN) traen default "adult"/"unisex"', () => {
      const draft = emptyDraft();
      expect(draft.common.ageGroup).toBe('adult');
      expect(draft.common.gender).toBe('unisex');
      expect(draft.common.mpn).toBe('');
    });

    it('inicializa ml con mappingMode single_with_variants, título/descripción heredados y listas vacías', () => {
      const draft = emptyDraft();
      expect(draft.ml.mappingMode).toBe('single_with_variants');
      expect(draft.ml.title).toEqual({ inherited: true, value: '' });
      expect(draft.ml.description).toEqual({ inherited: true, value: '' });
      expect(draft.ml.attributes).toEqual([]);
      expect(draft.ml.images).toEqual([]);
      expect(draft.ml.currency).toBe('ARS');
      // Default Clásica (sin cuotas sin interés) y sin garantía.
      expect(draft.ml.listingType).toBe('gold_special');
      expect(draft.ml.warrantyType).toBe('Sin garantía');
      expect(draft.ml.shippingMode).toBe('me2');
      expect(draft.ml.freeShipping).toBeFalse();
      expect(draft.ml.localPickup).toBeFalse();
    });

    it('inicializa tn con mappingMode single_with_variants, nombre/descripción heredados y listas vacías', () => {
      const draft = emptyDraft();
      expect(draft.tn.mappingMode).toBe('single_with_variants');
      expect(draft.tn.nameEs).toEqual({ inherited: true, value: '' });
      expect(draft.tn.description).toEqual({ inherited: true, value: '' });
      expect(draft.tn.images).toEqual([]);
      expect(draft.tn.namePt).toBe('');
      expect(draft.tn.freeShipping).toBeFalse();
    });

    it('devuelve una instancia nueva en cada llamada (no comparte referencias mutables)', () => {
      const a = emptyDraft();
      const b = emptyDraft();
      expect(a).not.toBe(b);
      expect(a.common).not.toBe(b.common);
      expect(a.ml.attributes).not.toBe(b.ml.attributes);

      a.axes.push({ name: 'Color' });
      expect(b.axes).toEqual([]);
    });

    it('inicializa cost en modo bulto con los descuentos y la ganancia por default de la planilla', () => {
      const draft = emptyDraft();
      expect(draft.cost).toEqual({
        mode: 'bulk',
        bulkPrice: null,
        bulkQty: null,
        discount1: 25,
        discount2: 5,
        unitCost: null,
        marginPct: 100
      });
    });
  });

  describe('variantLabel()', () => {
    it('une los valores de eje con un espacio', () => {
      expect(variantLabel(['Negro', 'A4'])).toBe('Negro A4');
    });

    it('descarta valores vacíos y recorta espacios', () => {
      expect(variantLabel([' Negro ', '', 'A4'])).toBe('Negro A4');
    });

    it('devuelve vacío sin valores', () => {
      expect(variantLabel([])).toBe('');
    });
  });

  describe('positiveLimit()', () => {
    it('deja pasar un límite válido', () => {
      expect(positiveLimit(6, 10)).toBe(6);
      expect(positiveLimit('8', 10)).toBe(8);
      expect(positiveLimit(4.7, 10)).toBe(4);
    });

    it('el 0 NO es un límite válido: cae al fallback', () => {
      // Es el bug que hacía que ninguna foto de ML se pudiera seleccionar: ML devuelve 0 en
      // categorías mal configuradas, `??` no lo atrapa, y `0 >= 0` bloqueaba todos los clicks.
      expect(positiveLimit(0, 10)).toBe(10);
    });

    it('null, undefined, NaN y negativos también caen al fallback', () => {
      expect(positiveLimit(null, 10)).toBe(10);
      expect(positiveLimit(undefined, 10)).toBe(10);
      expect(positiveLimit('no es un número', 10)).toBe(10);
      expect(positiveLimit(-3, 10)).toBe(10);
    });
  });

  describe('normalizeVariant()', () => {
    it('rellena una variante sin ml/tn sin romper', () => {
      const v = normalizeVariant({ sku: 'CUA-N' });
      expect(v.ml.pictureIds).toEqual([]);
      expect(v.tn.imageIds).toEqual([]);
      expect(v.barcode).toBe('');
      expect(v.titles.ml).toEqual({ inherited: true, value: '' });
      expect(v.id).toBeTruthy();
    });

    it('migra el `tn.imageId` de una sola foto de los borradores viejos', () => {
      const v = normalizeVariant({ sku: 'X', tn: { imageId: 'img-1' } });
      expect(v.tn.imageIds).toEqual(['img-1']);
    });

    it('conserva lo que ya está bien cargado', () => {
      const v = normalizeVariant({
        id: 'v9', sku: 'X', values: ['Negro'], stock: 3, barcode: '779',
        ml: { price: 100, pictureIds: ['a'] },
        tn: { price: 90, imageIds: ['b'] },
        titles: { ml: { inherited: false, value: 'Propio' }, tn: inherited('') }
      });
      expect(v.id).toBe('v9');
      expect(v.ml.pictureIds).toEqual(['a']);
      expect(v.titles.ml.value).toBe('Propio');
    });
  });

  describe('normalizeDraft()', () => {
    it('un borrador vacío o basura devuelve un draft usable', () => {
      expect(normalizeDraft({}).cost.marginPct).toBe(100);
      expect(normalizeDraft(null).variants).toEqual([]);
      expect(normalizeDraft('basura' as unknown).ml.images).toEqual([]);
    });

    it('un borrador viejo sin `cost` ni `ml.pictureIds` no rompe', () => {
      const d = normalizeDraft({ variants: [{ sku: 'A' }, { sku: 'B', ml: {} }] });
      expect(d.cost.mode).toBe('bulk');
      expect(d.variants.map((v) => v.ml.pictureIds)).toEqual([[], []]);
    });

    it('un borrador viejo sin mpn/ageGroup/gender los completa con el default (adult/unisex)', () => {
      const d = normalizeDraft({ common: { baseName: 'X' } });
      expect(d.common.ageGroup).toBe('adult');
      expect(d.common.gender).toBe('unisex');
      expect(d.common.mpn).toBe('');
    });
  });

  describe('defaultVariantTitle()', () => {
    it('combina el título base con la etiqueta de la variante', () => {
      expect(defaultVariantTitle('Cuaderno A4', ['Negro'])).toBe('Cuaderno A4 - Negro');
    });

    it('usa solo la etiqueta si no hay título base', () => {
      expect(defaultVariantTitle('', ['Negro'])).toBe('Negro');
    });

    it('usa solo el título base si la variante no tiene valores', () => {
      expect(defaultVariantTitle('Cuaderno A4', [])).toBe('Cuaderno A4');
    });
  });
});
