import { Injectable, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { injectQuery } from '@tanstack/angular-query-experimental';
import { firstValueFrom } from 'rxjs';
import { DiscountProfile, PreviewRow, PricingConfig, PricingService, Supplier, UncostedProduct } from '../../core/services/pricing.service';
import { TabDef } from '../../shared/components/tabs/tabs.component';
import { ALL_SUPPLIERS } from './precios.utils';

export type PreciosView = 'precios' | 'mapeo' | 'aplicaciones';

const VIEWS: PreciosView[] = ['precios', 'mapeo', 'aplicaciones'];

function toView(key: string | null): PreciosView {
  return VIEWS.includes(key as PreciosView) ? (key as PreciosView) : 'precios';
}

/**
 * Costo nuevo abierto desde Mapeo con el proveedor: los SKUs a los que se le carga (un pack con
 * código propio son todos sus modelos), el nombre y el proveedor de la pestaña.
 */
export interface CostPrefill {
  skus: string[];
  label: string | null;
  supplierKey: string | null;
  /**
   * Carga masiva (varios productos tildados en la planilla): el nombre de cada SKU se conserva
   * (no se le pone a todos el mismo) y la config de descuento arranca en "mantener la de cada uno".
   */
  bulkLabels?: Record<string, string | null>;
}

/** El diálogo abierto de la página (uno a la vez) con lo que necesita. */
export type PreciosDialog =
  | { kind: 'settings' }
  | { kind: 'import' }
  | { kind: 'lists' }
  | { kind: 'cost'; row: PreviewRow | null; prefill?: CostPrefill }
  | { kind: 'supplier'; supplier: Supplier | null }
  | { kind: 'profile'; supplierKey: string; profile: DiscountProfile | null };

/**
 * Estado compartido de "Actualizar precios": las queries (config + planilla), la pestaña de
 * proveedor y la vista (en la URL), qué cambió con la última acción y qué diálogo está abierto.
 * Se provee en PreciosComponent, así cada visita a la página arranca con un estado limpio y los
 * componentes hijos lo inyectan en vez de pasar todo por inputs/outputs.
 */
@Injectable()
export class PreciosStore {
  private readonly pricing = inject(PricingService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly configQuery = injectQuery(() => ({
    queryKey: ['pricing', 'config'],
    queryFn: () => firstValueFrom(this.pricing.getConfig()),
    staleTime: 60_000,
  }));

  readonly previewQuery = injectQuery(() => ({
    queryKey: ['pricing', 'preview'],
    queryFn: () => firstValueFrom(this.pricing.getPreview()),
    staleTime: 15_000,
    // Mientras haya precios en la cola de ML, se refresca solo para que "en cola" pase a aplicado.
    refetchInterval: (q: { state: { data?: { rows: PreviewRow[] } } }) =>
      q.state.data?.rows.some((r) => r.mlQueued) ? 10_000 : false,
  }));

  readonly config = computed<PricingConfig | undefined>(() => this.configQuery.data());
  readonly allRows = computed<PreviewRow[]>(() => this.previewQuery.data()?.rows ?? []);
  /** Productos con proveedor y sin costo (no están en la planilla hasta que se les cargue uno). */
  readonly allUncosted = computed<UncostedProduct[]>(() => this.previewQuery.data()?.uncosted ?? []);
  readonly suppliers = computed<Supplier[]>(() => this.config()?.suppliers ?? []);

  // ── Pestaña de proveedor (?proveedor=) ──
  private readonly supplierTab = signal<string>(this.route.snapshot.queryParamMap.get('proveedor') || ALL_SUPPLIERS);
  /** El proveedor de la pestaña (null en "Todos" o si la pestaña ya no existe). */
  readonly currentSupplier = computed<Supplier | null>(
    () => this.suppliers().find((s) => s.key === this.supplierTab()) ?? null,
  );
  /** Pestaña efectiva: si el proveedor de la URL no existe (borrado), "Todos". */
  readonly activeSupplierTab = computed(() => this.currentSupplier()?.key ?? ALL_SUPPLIERS);
  readonly supplierTabs = computed<TabDef[]>(() => {
    const rows = this.allRows();
    const uncosted = this.allUncosted();
    // Cuenta también lo que todavía no tiene costo: si no, un proveedor recién asignado decía "0".
    const count = (key: string) => rows.filter((r) => r.suppliers?.includes(key)).length
      + uncosted.filter((u) => u.suppliers.includes(key)).length;
    return [
      { key: ALL_SUPPLIERS, label: 'Todos', count: rows.length + uncosted.length },
      ...this.suppliers().map((s) => ({ key: s.key, label: s.name, count: count(s.key) })),
    ];
  });
  /** Filas de la planilla: las del proveedor de la pestaña (todas en "Todos"). */
  readonly rows = computed<PreviewRow[]>(() => {
    const sup = this.currentSupplier();
    const all = this.allRows();
    return sup ? all.filter((r) => r.suppliers?.includes(sup.key)) : all;
  });

  /** Productos sin costo de la pestaña (todos en "Todos"). */
  readonly uncosted = computed<UncostedProduct[]>(() => {
    const sup = this.currentSupplier();
    const all = this.allUncosted();
    return sup ? all.filter((u) => u.suppliers.includes(sup.key)) : all;
  });

  setSupplierTab(key: string): void {
    this.supplierTab.set(key);
    this.navigate({ proveedor: key === ALL_SUPPLIERS ? null : key });
  }

  // ── Vista: planilla / mapeo con el proveedor / aplicaciones (?tab=mapeo|aplicaciones) ──
  readonly view = signal<PreciosView>(toView(this.route.snapshot.queryParamMap.get('tab')));

  setView(key: string): void {
    const view = toView(key);
    this.view.set(view);
    this.navigate({ tab: view === 'precios' ? null : view });
  }

  private navigate(queryParams: Record<string, string | null>): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams, queryParamsHandling: 'merge', replaceUrl: true });
  }

  supplierName(key: string | null | undefined): string {
    if (!key) return 'Sin proveedor';
    return this.suppliers().find((s) => s.key === key)?.name ?? key;
  }

  // ── Lo que cambió con la última acción (import, Ajustes, configs) ──
  /** SKUs cuyo precio efectivo cambió con el ÚLTIMO cambio, para resaltar la fila. */
  readonly changedSkus = signal<Set<string>>(new Set());
  /** Mensaje de la última acción ("12 en cola para ML · …"). */
  readonly notice = signal<string | null>(null);

  markChanged(skus: Iterable<string>): void {
    this.changedSkus.set(new Set(skus));
  }

  /** Refresca config + planilla y resalta las filas cuyo costo o precio efectivo se movió. */
  async refreshMarkingChanges(): Promise<void> {
    const before = new Map(this.allRows().map((r) => [r.sku, { tn: r.tn.effective, ml: r.mlEffective, cost: r.unitCost }]));
    const [, preview] = await Promise.all([this.configQuery.refetch(), this.previewQuery.refetch()]);
    const changed = new Set<string>();
    for (const row of preview.data?.rows ?? []) {
      const prev = before.get(row.sku);
      if (!prev || Math.abs(prev.cost - row.unitCost) > 0.01 || Math.abs(prev.tn - row.tn.effective) > 0.01 || Math.abs(prev.ml - row.mlEffective) > 0.01) {
        changed.add(row.sku);
      }
    }
    this.changedSkus.set(changed);
  }

  async refreshAll(): Promise<void> {
    await Promise.all([this.configQuery.refetch(), this.previewQuery.refetch()]);
  }

  // ── Diálogos ──
  readonly dialog = signal<PreciosDialog | null>(null);

  open(dialog: PreciosDialog): void {
    this.dialog.set(dialog);
  }

  close(): void {
    this.dialog.set(null);
  }
}
