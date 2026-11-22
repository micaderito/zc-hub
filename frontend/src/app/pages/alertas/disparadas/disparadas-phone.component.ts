import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { CatalogMember, CatalogUnit, OrderSupplier } from '../../../core/services/orders.service';
import { StockAlertRule } from '../../../core/services/alerts.service';
import { BottomSheetComponent } from '../../../shared/components/bottom-sheet/bottom-sheet.component';
import { CanWriteDirective } from '../../../shared/directives/can-write.directive';
import { ThresholdSheetComponent, ThresholdTarget } from '../threshold-sheet/threshold-sheet.component';
import { ProductThumbComponent } from '../../../shared/components/product-thumb/product-thumb.component';

/** Sección de la lista por urgencia. Lo que ya está en un pedido pendiente va aparte, aunque esté en 0. */
export type Bucket = 'out' | 'low' | 'ordered';

export const BUCKETS: { key: Bucket; title: string; tile: string; icon: string }[] = [
  { key: 'out', title: 'Sin stock', tile: 'Agotados', icon: 'ti-alert-octagon' },
  { key: 'low', title: 'Stock bajo', tile: 'Bajos', icon: 'ti-alert-triangle' },
  { key: 'ordered', title: 'Ya pedido', tile: 'En camino', icon: 'ti-truck' },
];

export function bucketOf(u: CatalogUnit): Bucket {
  if (u.pendingOrder) return 'ordered';
  return u.members.some((m) => m.alertState === 'out') ? 'out' : 'low';
}

export function isActiveMember(m: CatalogMember): boolean {
  return m.alertState === 'out' || m.alertState === 'still-low';
}

/** Foto de la unidad: la del primer modelo con alerta que tenga foto, si no la de cualquiera. */
export function unitThumb(u: CatalogUnit): string | null {
  return u.members.find((m) => isActiveMember(m) && m.thumbnail)?.thumbnail
    ?? u.members.find((m) => m.thumbnail)?.thumbnail
    ?? null;
}

/** Todas las fotos de los modelos (sin repetir), para recorrerlas en el zoom: primero los con alerta. */
export function unitPhotos(u: CatalogUnit): string[] {
  const ordered = [...u.members.filter(isActiveMember), ...u.members.filter((m) => !isActiveMember(m))];
  return [...new Set(ordered.map((m) => m.thumbnail).filter((t): t is string => !!t))];
}

/**
 * Disparadas en el celular: tres números arriba (se tocan para filtrar), la lista separada por
 * urgencia y una hoja con el detalle de cada unidad. Recibe la lista ya buscada/filtrada por
 * proveedor y ordenada (la peor primero) por `AlertasDisparadasComponent`.
 */
@Component({
  selector: 'zc-disparadas-phone',
  standalone: true,
  imports: [DatePipe, RouterLink, BottomSheetComponent, CanWriteDirective, ThresholdSheetComponent, ProductThumbComponent],
  templateUrl: './disparadas-phone.component.html',
  styleUrl: './disparadas-phone.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DisparadasPhoneComponent {
  readonly units = input.required<CatalogUnit[]>();
  readonly suppliers = input<OrderSupplier[]>([]);
  readonly rules = input<StockAlertRule[]>([]);

  readonly buckets = BUCKETS;
  readonly unitThumb = unitThumb;
  readonly unitPhotos = unitPhotos;
  readonly bucketFilter = signal<Bucket | null>(null);

  readonly counts = computed(() => {
    const c: Record<Bucket, number> = { out: 0, low: 0, ordered: 0 };
    for (const u of this.units()) c[bucketOf(u)]++;
    return c;
  });

  readonly sections = computed(() => {
    const only = this.bucketFilter();
    return BUCKETS
      .filter((b) => !only || b.key === only)
      .map((b) => ({ ...b, units: this.units().filter((u) => bucketOf(u) === b.key) }))
      .filter((s) => s.units.length);
  });

  toggleBucket(b: Bucket): void {
    this.bucketFilter.update((cur) => (cur === b ? null : b));
  }

  /* ── Hoja de detalle ── */

  private readonly openKey = signal<string | null>(null);
  readonly openUnit = computed(() => this.units().find((u) => u.key === this.openKey()) ?? null);
  readonly showAllMembers = signal(false);

  open(u: CatalogUnit): void {
    this.showAllMembers.set(false);
    this.openKey.set(u.key);
  }

  close(): void {
    this.openKey.set(null);
  }

  /** Los modelos con alerta primero; el resto se despliega a pedido. */
  sortedMembers(u: CatalogUnit): { shown: CatalogMember[]; hidden: number } {
    const active = u.members.filter(isActiveMember);
    const rest = u.members.filter((m) => !isActiveMember(m));
    if (this.showAllMembers() || rest.length <= 1) return { shown: [...active, ...rest], hidden: 0 };
    return { shown: active, hidden: rest.length };
  }

  /* ── Hoja de umbral ── */

  readonly thresholdTarget = signal<ThresholdTarget | null>(null);

  editThreshold(m: CatalogMember): void {
    this.thresholdTarget.set({
      sku: m.sku,
      label: m.label,
      stockMl: m.stockMl,
      stockTn: m.stockTn,
      threshold: m.threshold,
      thumbnail: m.thumbnail ?? null,
      mutedUntil: this.rules().find((r) => r.sku === m.sku)?.mutedUntil ?? null,
    });
  }

  /* ── Textos ── */

  isMulti(u: CatalogUnit): boolean {
    return u.members.length > 1;
  }

  title(u: CatalogUnit): string {
    return this.isMulti(u) ? u.name : u.members[0].label;
  }

  activeCount(u: CatalogUnit): number {
    return u.members.filter(isActiveMember).length;
  }

  subtitle(u: CatalogUnit): string {
    const id = u.code ?? (this.isMulti(u) ? null : u.members[0].sku);
    const sup = u.suppliers.map((k) => this.suppliers().find((s) => s.key === k)?.name ?? k).join(', ');
    return [id, sup || 'sin proveedor'].filter(Boolean).join(' · ');
  }

  bucket(u: CatalogUnit): Bucket {
    return bucketOf(u);
  }

  stateClass(m: CatalogMember): string {
    return m.alertState === 'out' ? 'err' : m.alertState === 'still-low' ? 'warn' : 'plain';
  }
}
