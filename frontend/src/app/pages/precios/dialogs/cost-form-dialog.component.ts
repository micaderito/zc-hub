import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { QueryClient, injectQuery } from '@tanstack/angular-query-experimental';
import { firstValueFrom } from 'rxjs';
import { DiscountProfile, PRODUCT_SUPPLIERS_QUERY_KEY, PreviewRow, PricingService } from '../../../core/services/pricing.service';
import { CostPrefill, PreciosStore } from '../precios.store';
import { apiError, discountPcts } from '../precios.utils';

/** Estado del formulario de carga manual de costo. */
export interface CostForm {
  sku: string;
  label: string;
  mode: 'bulk' | 'unit';
  bulkPrice: number | null;
  bulkQty: number | null;
  unitCost: number | null;
  marginOverride: number | null;
  /** Proveedor vigente (`''` = sin proveedor: sin descuento). */
  supplierKey: string;
  /**
   * Config propia del SKU (`null` = la del pack o la default del proveedor; `'keep'` = en una
   * carga masiva, no tocar la que ya tiene cada uno).
   */
  profileId: number | null | 'keep';
}

/**
 * Qué config toma un SKU SIN config propia para un proveedor: la del pack si el pack tiene una
 * elegida para ese proveedor, si no la default del proveedor (mismo orden que `discountResolver.js`).
 */
export function inheritedDiscountLabel(profiles: DiscountProfile[], packProfileId: number | null | undefined): string {
  const pack = packProfileId != null ? profiles.find((p) => p.id === packProfileId) : null;
  if (pack) return `La del pack (${pack.name} · ${discountPcts(pack)})`;
  const def = profiles.find((p) => p.isDefault) ?? profiles[0];
  if (def) return `La default del proveedor (${def.name} · ${discountPcts(def)})`;
  return 'Sin descuento (el proveedor no tiene configs)';
}

/** Alta / edición manual del costo de un SKU (por bulto o unitario), con proveedor y config. */
@Component({
  selector: 'zc-cost-form-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  templateUrl: './cost-form-dialog.component.html',
  styleUrl: './cost-form-dialog.component.scss',
})
export class CostFormDialogComponent implements OnInit {
  protected readonly store = inject(PreciosStore);
  private readonly pricing = inject(PricingService);
  private readonly queryClient = inject(QueryClient);

  /** Fila a editar; `null` = costo nuevo. */
  readonly row = input<PreviewRow | null>(null);
  /** Desde Mapeo: a qué SKUs se le carga (todos los modelos de un pack), nombre y proveedor. */
  readonly prefill = input<CostPrefill | null>(null);

  /** SKUs a los que se guarda el costo: los del prefill, o el del formulario. */
  readonly targetSkus = computed(() => this.prefill()?.skus ?? [this.form().sku.trim()].filter(Boolean));
  /** Varios productos tildados: el mismo costo para todos, cada uno con su nombre. */
  readonly bulk = computed(() => !!this.prefill()?.bulkLabels);

  readonly discountPcts = discountPcts;
  readonly form = signal<CostForm>(emptyCostForm());
  readonly saving = signal(false);
  readonly errorMsg = signal<string | null>(null);

  /** Configs del proveedor elegido. */
  readonly profiles = computed<DiscountProfile[]>(
    () => this.store.suppliers().find((s) => s.key === this.form().supplierKey)?.profiles ?? [],
  );

  /** Pack de cada SKU y config de cada pack (el mismo dato que usa Productos). */
  private readonly overviewQuery = injectQuery(() => ({
    queryKey: PRODUCT_SUPPLIERS_QUERY_KEY,
    queryFn: () => firstValueFrom(this.pricing.getProductSuppliers()),
    // Se refresca al abrir: en Precios se cambian configs y asignaciones sin invalidar esta query.
    staleTime: 0,
    refetchOnWindowFocus: false,
  }));

  /**
   * Rótulo de la opción "sin config propia": cuál se aplica en concreto ("La del pack (Agendas ·
   * −30% −5%)" / "La default del proveedor (General · −25% −5%)"). Mientras carga, el genérico.
   */
  readonly inheritedLabel = computed(() => {
    const ov = this.overviewQuery.data();
    if (!ov) return 'La del pack o la default';
    const key = this.form().supplierKey;
    const packId = this.row()?.pack?.packId ?? ov.packBySku?.[this.targetSkus()[0] ?? ''];
    const packProfileId = packId != null ? ov.byPack[packId]?.find((a) => a.supplierKey === key)?.profileId : null;
    return inheritedDiscountLabel(this.profiles(), packProfileId);
  });

  ngOnInit(): void {
    const row = this.row();
    const prefill = this.prefill();
    if (prefill) {
      // Lo de la lista del proveedor se carga por bulto (es lo que lleva descuento).
      const base = row ? fromRow(row) : { ...emptyCostForm(), mode: 'bulk' as const };
      this.form.set({
        ...base,
        sku: prefill.skus[0] ?? '',
        label: prefill.label ?? base.label,
        supplierKey: row ? base.supplierKey : (prefill.supplierKey ?? ''),
        ...(prefill.bulkLabels ? { profileId: 'keep' as const } : {}),
      });
      return;
    }
    if (!row) {
      this.form.set(emptyCostForm(this.store.currentSupplier()?.key ?? this.store.suppliers()[0]?.key ?? ''));
      return;
    }
    this.form.set(fromRow(row));
  }

  update<K extends keyof CostForm>(key: K, value: CostForm[K]): void {
    // Cambiar de proveedor saca la config propia elegida: las configs son de cada proveedor.
    const reset = this.bulk() ? 'keep' as const : null;
    this.form.update((f) => ({ ...f, [key]: value, ...(key === 'supplierKey' ? { profileId: reset } : {}) }));
  }

  async save(): Promise<void> {
    const f = this.form();
    if (!f.sku.trim()) { this.errorMsg.set('El SKU es obligatorio'); return; }
    this.saving.set(true);
    this.errorMsg.set(null);
    try {
      const supplier = { supplierKey: f.supplierKey || null };
      // Sin `profileId` el backend no toca la config del SKU ("mantener la de cada uno").
      const profile = f.supplierKey && f.profileId !== 'keep' ? { profileId: f.profileId } : {};
      const payload = f.mode === 'bulk'
        ? { source: 'manual' as const, bulkPrice: f.bulkPrice, bulkQty: f.bulkQty, marginOverride: f.marginOverride, label: f.label, ...supplier, ...profile }
        : { source: 'manual' as const, unitCost: f.unitCost, marginOverride: f.marginOverride, label: f.label, ...supplier };
      const skus = this.targetSkus();
      const labels = this.prefill()?.bulkLabels;
      for (const sku of skus) {
        await firstValueFrom(this.pricing.saveCost(sku, labels ? { ...payload, label: labels[sku] ?? null } : payload));
      }
      this.store.markChanged(skus);
      await Promise.all([
        this.store.refreshAll(),
        // Mapeo con el proveedor muestra si cada producto ya tiene costo.
        this.queryClient.invalidateQueries({ queryKey: ['pricing', 'mapping'] }),
      ]);
      this.store.close();
    } catch (e) {
      this.errorMsg.set(apiError(e, 'No se pudo guardar el costo'));
    } finally {
      this.saving.set(false);
    }
  }
}

function fromRow(row: PreviewRow): CostForm {
  const byBulk = row.bulkPrice != null && row.bulkQty != null;
  return {
    sku: row.sku, label: row.label ?? '', mode: byBulk ? 'bulk' : 'unit',
    bulkPrice: row.bulkPrice, bulkQty: row.bulkQty, unitCost: byBulk ? null : row.unitCost,
    marginOverride: null,
    supplierKey: row.supplierKey ?? '',
    profileId: row.discount?.level === 'sku' ? row.discount.profileId : null,
  };
}

function emptyCostForm(supplierKey = ''): CostForm {
  return {
    sku: '', label: '', mode: 'unit',
    bulkPrice: null, bulkQty: null, unitCost: null,
    marginOverride: null, supplierKey, profileId: null,
  };
}
