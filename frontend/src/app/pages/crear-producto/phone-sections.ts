import { DraftSectionKey, ProductDraft, PublishBlocker, projectionLabel } from './product-draft.model';

/** Cómo se muestra cada sección en el celular (índice de arriba y encabezado de la tarjeta plegable). */
export interface PhoneSectionDef {
  key: DraftSectionKey;
  title: string;
  /** Rótulo corto para el índice. */
  short: string;
  icon: string | null;
  accent: 'ml' | 'tn' | null;
}

export const PHONE_SECTIONS: readonly PhoneSectionDef[] = [
  { key: 'common', title: 'Datos comunes', short: 'Comunes', icon: 'ti-stack-2', accent: null },
  { key: 'ml', title: 'Mercado Libre', short: 'ML', icon: null, accent: 'ml' },
  { key: 'tn', title: 'Tienda Nube', short: 'TN', icon: null, accent: 'tn' },
  { key: 'price', title: 'Precios y ganancia', short: 'Precio', icon: 'ti-calculator', accent: null },
  { key: 'variants', title: 'Variantes', short: 'Variantes', icon: 'ti-layout-grid', accent: null },
  { key: 'alert', title: 'Alerta de stock', short: 'Alerta', icon: 'ti-bell', accent: null },
];

export interface PhoneSectionState {
  missing: number;
  /** Lo primero que falta, si falta algo; si no, el resumen de lo cargado. */
  summary: string;
}

const join = (parts: Array<string | null | undefined | false>) => parts.filter(Boolean).join(' · ');
const fotos = (n: number) => (n === 1 ? '1 foto' : `${n} fotos`);

/**
 * Una línea por sección con lo cargado (para verla cerrada) y cuántos faltantes tiene. Puro: el
 * componente le pasa el borrador, los faltantes del store y el nombre del proveedor elegido.
 */
export function phoneSectionStates(
  d: ProductDraft,
  blockers: readonly PublishBlocker[],
  supplierName: string | null
): Record<DraftSectionKey, PhoneSectionState> {
  const n = d.variants.length;
  const loaded: Record<DraftSectionKey, string> = {
    common: join([
      d.common.baseName.trim() || 'Sin nombre',
      d.common.condition === 'used' ? 'Usado' : 'Nuevo',
      d.common.weightG != null && `${d.common.weightG} g`,
    ]),
    ml: join([
      d.ml.categoryName || 'Sin categoría',
      projectionLabel('ml', d.ml.mappingMode, n),
      fotos(d.ml.images.length),
    ]),
    tn: join([
      d.tn.categories.length === 1 ? '1 categoría' : `${d.tn.categories.length} categorías`,
      projectionLabel('tn', d.tn.mappingMode, n),
      fotos(d.tn.images.length),
    ]),
    price: join([supplierName ?? 'Sin proveedor', `ganancia ${d.cost.marginPct}%`]),
    variants: n
      ? join([`${n} variantes`, d.axes.map((a) => a.name).filter(Boolean).join(' × ')])
      : join(['Producto simple', d.common.sku.trim() && `SKU ${d.common.sku.trim()}`, d.common.baseStock != null && `stock ${d.common.baseStock}`]),
    alert: d.alert.enabled
      ? d.alert.threshold != null
        ? `Avisar con ${d.alert.threshold} o menos`
        : 'Activada'
      : 'Sin alerta',
  };

  const out = {} as Record<DraftSectionKey, PhoneSectionState>;
  for (const { key } of PHONE_SECTIONS) {
    const own = blockers.filter((b) => b.section === key);
    out[key] = { missing: own.length, summary: own.length ? own[0].text : loaded[key] };
  }
  return out;
}
