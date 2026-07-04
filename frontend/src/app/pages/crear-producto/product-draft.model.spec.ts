import { emptyDraft, inherited, listingTypeLabel, projectionLabel } from './product-draft.model';

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

    it('inicializa common con strings vacíos, condición "new" y dimensiones en null', () => {
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
        seoKeywords: ''
      });
    });

    it('inicializa ml con mappingMode single_with_variants, título/descripción heredados y listas vacías', () => {
      const draft = emptyDraft();
      expect(draft.ml.mappingMode).toBe('single_with_variants');
      expect(draft.ml.title).toEqual({ inherited: true, value: '' });
      expect(draft.ml.description).toEqual({ inherited: true, value: '' });
      expect(draft.ml.attributes).toEqual([]);
      expect(draft.ml.images).toEqual([]);
      expect(draft.ml.currency).toBe('ARS');
      expect(draft.ml.listingType).toBe('gold_special');
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
  });
});
