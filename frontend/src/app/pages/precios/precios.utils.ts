import { DiscountProfile, PreviewRow, PreviewRowPack, RowDiscount, Supplier } from '../../core/services/pricing.service';

/** Pestaña de proveedor "Todos". */
export const ALL_SUPPLIERS = 'all';

/** Un pack de la planilla: sus filas + el resumen que se ve con el grupo plegado. */
export interface PriceGroup {
  pack: PreviewRowPack;
  rows: PreviewRow[];
  /** Rango de precios efectivos de los modelos (iguales casi siempre: mismo costo de compra). */
  tn: { min: number; max: number };
  ml: { min: number; max: number };
  /** Modelos cuyo SKU no aparece en ML ni en TN. */
  unpublished: number;
  /** Modelos con precio sin aplicar. */
  pending: number;
  /** Config de descuento del pack (la misma en todos sus modelos), o "mixto". */
  discountLabel: string | null;
}

/** ¿Falta aplicar en algún canal? Lo que ya está en la cola de ML no cuenta como pendiente. */
export function isPendingRow(r: PreviewRow): boolean {
  return (r.pendingMl && !r.mlQueued) || r.pendingTn;
}

/** Filas agrupadas por pack (mismo precio de compra para todos los modelos) + las sueltas. */
export function buildPriceGroups(rows: PreviewRow[]): { groups: PriceGroup[]; noPack: PreviewRow[] } {
  const byPack = new Map<number, { pack: PreviewRowPack; rows: PreviewRow[] }>();
  const noPack: PreviewRow[] = [];
  for (const r of rows) {
    if (!r.pack) { noPack.push(r); continue; }
    let g = byPack.get(r.pack.packId);
    if (!g) { g = { pack: r.pack, rows: [] }; byPack.set(r.pack.packId, g); }
    g.rows.push(r);
  }
  const groups = [...byPack.values()]
    .sort((a, b) => a.pack.name.localeCompare(b.pack.name, 'es'))
    .map((g) => ({
      ...g,
      tn: range(g.rows.map((r) => r.tn.effective)),
      ml: range(g.rows.map((r) => r.mlEffective)),
      unpublished: g.rows.filter((r) => !r.mappedMl && !r.mappedTn).length,
      pending: g.rows.filter(isPendingRow).length,
      discountLabel: groupDiscountLabel(g.rows),
    }));
  return { groups, noPack };
}

function range(values: number[]): { min: number; max: number } {
  return { min: Math.min(...values), max: Math.max(...values) };
}

/** Config de un pack: la de sus modelos si todos comparten la misma, si no "mixto". */
function groupDiscountLabel(rows: PreviewRow[]): string | null {
  const names = new Set(rows.filter((r) => r.discount).map((r) => r.discount!.name ?? 'Sin proveedor'));
  if (names.size === 0) return null;
  return names.size === 1 ? [...names][0] : 'mixto';
}

/** "−25% −5%" / "sin descuento". */
export function discountPcts(d: Pick<RowDiscount, 'discount1' | 'discount2'>): string {
  const parts = [d.discount1, d.discount2].filter((v) => v > 0).map((v) => `−${v}%`);
  return parts.length ? parts.join(' ') : 'sin descuento';
}

/** Detalle de cómo se llega al costo unitario (tooltip de la columna Descuento). */
export function discountChain(r: PreviewRow): string {
  if (r.bulkPrice == null || !r.bulkQty || !r.discount) return '';
  const fmt = (n: number) => `$${Math.round(n).toLocaleString('es-AR')}`;
  let net = r.bulkPrice;
  const steps = [`Lista ${fmt(net)}`];
  for (const d of [r.discount.discount1, r.discount.discount2]) {
    if (!(d > 0)) continue;
    net = net * (1 - d / 100);
    steps.push(`−${d}% ${fmt(net)}`);
  }
  steps.push(`÷ ${r.bulkQty} u. = ${fmt(net / r.bulkQty)}`);
  const origin = r.discount.level === 'sku' ? 'config del producto'
    : r.discount.level === 'pack' ? 'config del pack'
      : r.discount.level === 'default' ? 'default del proveedor' : 'sin proveedor';
  return `${steps.join(' → ')} (${origin})`;
}

/** La config default de un proveedor. */
export function defaultProfile(s: Supplier | null | undefined): DiscountProfile | null {
  return s?.profiles.find((p) => p.isDefault) ?? s?.profiles[0] ?? null;
}

/** Mensaje de error de la API (`{ error }`) o el genérico. */
export function apiError(e: unknown, fallback: string): string {
  return (e as { error?: { error?: string } })?.error?.error ?? (e as Error)?.message ?? fallback;
}
