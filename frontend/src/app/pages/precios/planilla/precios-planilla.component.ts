import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { CurrencyPipe, NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { PreviewRow, PricingService, PricingTarget } from '../../../core/services/pricing.service';
import { ProductHistoryDialogComponent } from '../../precio-stock/components/product-history-dialog/product-history-dialog.component';
import { AssignDialogComponent, AssignMode } from '../dialogs/assign-dialog.component';
import { PreciosStore } from '../precios.store';
import { PriceGroup, apiError, buildPriceGroups, discountChain, discountPcts, isPendingRow } from '../precios.utils';

/**
 * La planilla de precios: resumen de Ajustes, búsqueda / "solo pendientes", la tabla agrupada por
 * pack y la barra de acción (asignar descuento, proveedor vigente, aplicar a ML y TN). La
 * selección, los filtros y los packs abiertos son de acá; las filas salen del store (ya
 * filtradas por la pestaña de proveedor).
 */
@Component({
  selector: 'zc-precios-planilla',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CurrencyPipe, FormsModule, NgTemplateOutlet, ProductHistoryDialogComponent, AssignDialogComponent],
  templateUrl: './precios-planilla.component.html',
  styleUrl: './precios-planilla.component.scss',
})
export class PreciosPlanillaComponent {
  protected readonly store = inject(PreciosStore);
  private readonly pricing = inject(PricingService);

  readonly discountPcts = discountPcts;
  readonly discountChain = discountChain;
  readonly isPending = isPendingRow;

  readonly search = signal('');
  /** Mostrar solo lo que falta aplicar (precio calculado ≠ publicado). */
  readonly onlyPending = signal(false);
  readonly selected = signal<Set<string>>(new Set());
  /** Packs desplegados. Arrancan plegados: con muchos packs la planilla se hacía eterna. */
  readonly expandedPacks = signal<Set<number>>(new Set());
  readonly applying = signal(false);
  readonly errorMsg = signal<string | null>(null);
  readonly historySku = signal<string | null>(null);
  readonly assignMode = signal<AssignMode | null>(null);

  constructor() {
    // La selección es de la pestaña: al cambiar de proveedor se empieza de cero.
    effect(() => {
      this.store.activeSupplierTab();
      untracked(() => this.selected.set(new Set()));
    }, { allowSignalWrites: true });
  }

  readonly pendingCount = computed(() => this.store.rows().filter(isPendingRow).length);

  readonly filteredRows = computed(() => {
    const q = this.search().trim().toLowerCase();
    const base = this.onlyPending() ? this.store.rows().filter(isPendingRow) : this.store.rows();
    if (!q) return base;
    return base.filter(
      (r) => r.sku.toLowerCase().includes(q)
        || (r.label ?? '').toLowerCase().includes(q)
        || (r.name ?? '').toLowerCase().includes(q)
        || (r.pack?.name ?? '').toLowerCase().includes(q),
    );
  });

  readonly priceGroups = computed(() => buildPriceGroups(this.filteredRows()));
  readonly selectedCount = computed(() => this.selected().size);
  readonly allSelected = computed(() => {
    const rows = this.filteredRows();
    const sel = this.selected();
    return rows.length > 0 && rows.every((r) => sel.has(r.sku));
  });

  /** Con una búsqueda o "solo pendientes" se muestran abiertos: si no, lo filtrado quedaría escondido. */
  isPackExpanded(packId: number): boolean {
    return !!this.search().trim() || this.onlyPending() || this.expandedPacks().has(packId);
  }

  togglePack(packId: number): void {
    this.expandedPacks.update((set) => toggled(set, packId));
  }

  setAllPacksExpanded(open: boolean): void {
    this.expandedPacks.set(open ? new Set(this.priceGroups().groups.map((g) => g.pack.packId)) : new Set());
  }

  /** ¿Alguna fila del pack se movió con el último cambio? (para marcar el grupo plegado) */
  groupChanged(g: PriceGroup): boolean {
    const changed = this.store.changedSkus();
    return g.rows.some((r) => changed.has(r.sku));
  }

  groupSelection(g: PriceGroup): 'all' | 'some' | 'none' {
    const sel = this.selected();
    const n = g.rows.filter((r) => sel.has(r.sku)).length;
    return n === 0 ? 'none' : n === g.rows.length ? 'all' : 'some';
  }

  toggleGroup(g: PriceGroup): void {
    const selectAll = this.groupSelection(g) !== 'all';
    this.selected.update((set) => {
      const next = new Set(set);
      for (const r of g.rows) {
        if (selectAll) next.add(r.sku); else next.delete(r.sku);
      }
      return next;
    });
  }

  toggleRow(sku: string): void {
    this.selected.update((set) => toggled(set, sku));
  }

  toggleAll(): void {
    this.selected.set(this.allSelected() ? new Set() : new Set(this.filteredRows().map((r) => r.sku)));
  }

  /** Selecciona exactamente lo que falta aplicar (dentro de lo filtrado por la búsqueda). */
  selectPending(): void {
    this.selected.set(new Set(this.filteredRows().filter(isPendingRow).map((r) => r.sku)));
  }

  delta(current: number | null, next: number): { pct: number; dir: 'up' | 'down' | 'same' } | null {
    if (current == null || current === 0) return null;
    const pct = ((next - current) / current) * 100;
    return { pct: Math.round(pct * 10) / 10, dir: pct > 0.05 ? 'up' : pct < -0.05 ? 'down' : 'same' };
  }

  /**
   * Lo seleccionado como destinos: un pack con TODOS sus modelos seleccionados va como pack (la
   * config queda en el pack y la toman también los modelos que se agreguen después); el resto, por SKU.
   */
  selectionTargets(): PricingTarget[] {
    const sel = this.selected();
    const targets: PricingTarget[] = [];
    const covered = new Set<string>();
    const rowsByPack = new Map<number, PreviewRow[]>();
    for (const r of this.store.rows()) {
      if (!r.pack) continue;
      if (!rowsByPack.has(r.pack.packId)) rowsByPack.set(r.pack.packId, []);
      rowsByPack.get(r.pack.packId)!.push(r);
    }
    for (const [packId, rows] of rowsByPack) {
      if (rows.length > 0 && rows.every((r) => sel.has(r.sku))) {
        targets.push({ type: 'pack', id: packId });
        for (const r of rows) covered.add(r.sku);
      }
    }
    for (const sku of sel) if (!covered.has(sku)) targets.push({ type: 'sku', id: sku });
    return targets;
  }

  /** Tooltip del proveedor en "Todos": todos a los que se le compra y cuál es el vigente. */
  suppliersTitle(r: PreviewRow): string | null {
    if (r.suppliers.length <= 1) return null;
    const names = r.suppliers.map((k) => this.store.supplierName(k)).join(', ');
    return `Proveedores: ${names} (vigente: ${this.store.supplierName(r.supplierKey)})`;
  }

  /** Proveedor con el que abre el diálogo de asignar: el de la pestaña, si no el vigente de lo seleccionado. */
  assignDefaultSupplier(): string {
    const firstSelected = this.store.allRows().find((r) => this.selected().has(r.sku));
    return this.store.currentSupplier()?.key ?? firstSelected?.supplierKey ?? this.store.suppliers()[0]?.key ?? '';
  }

  /**
   * Guarda (o saca) el ajuste manual de un canal. Si el valor tipeado coincide con el calculado no
   * hace falta guardar nada — es lo mismo que no tener override.
   */
  async updateOverride(row: PreviewRow, channel: 'ml' | 'tn', value: number | string | null): Promise<void> {
    const calculated = channel === 'tn' ? row.tn.list : row.ml;
    const num = value === '' || value == null ? null : Number(value);
    const toSave = num != null && Number.isFinite(num) && num !== calculated ? num : null;
    try {
      await firstValueFrom(this.pricing.saveOverride(row.sku, channel, toSave));
      await this.store.previewQuery.refetch();
    } catch (e) {
      this.errorMsg.set(apiError(e, 'No se pudo guardar el ajuste'));
    }
  }

  async removeCost(sku: string): Promise<void> {
    try {
      await firstValueFrom(this.pricing.deleteCost(sku));
      this.selected.update((s) => { const n = new Set(s); n.delete(sku); return n; });
      await this.store.refreshAll();
    } catch (e) {
      this.errorMsg.set(apiError(e, 'No se pudo borrar'));
    }
  }

  async apply(): Promise<void> {
    const skus = [...this.selected()];
    if (skus.length === 0) return;
    this.applying.set(true);
    this.store.notice.set(null);
    this.errorMsg.set(null);
    try {
      const res = await firstValueFrom(this.pricing.apply(skus));
      const parts = [`${res.enqueuedMl} en cola para ML`, `${res.appliedTn} aplicados en TN`];
      if (res.failed > 0) parts.push(`${res.failed} con problemas`);
      this.store.notice.set(parts.join(' · '));
      await this.store.previewQuery.refetch();
    } catch (e) {
      this.errorMsg.set(apiError(e, 'No se pudo aplicar'));
    } finally {
      this.applying.set(false);
    }
  }
}

function toggled<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value); else next.add(value);
  return next;
}
