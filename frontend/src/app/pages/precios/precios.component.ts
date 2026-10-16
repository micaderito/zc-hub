import { Component, computed, inject, signal } from '@angular/core';
import { CurrencyPipe, DatePipe, NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { QueryClient, injectQuery } from '@tanstack/angular-query-experimental';
import { firstValueFrom } from 'rxjs';
import {
  PricingService, PricingConfig, PreviewRow, PreviewRowPack, PricingSettings, MlFeeTier,
  ImportPreview, MappingSuggestion, MlFeesSync, ImportedList, ImportResult,
  Supplier, DiscountProfile, PricingTarget, RowDiscount,
} from '../../core/services/pricing.service';
import { TabsComponent, TabDef } from '../../shared/components/tabs/tabs.component';
import { MapeoProveedorComponent } from './mapeo/mapeo-proveedor.component';

type PreciosTab = 'precios' | 'mapeo';

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

function range(values: number[]): { min: number; max: number } {
  return { min: Math.min(...values), max: Math.max(...values) };
}

/** "−25% −5%" / "sin descuento". */
export function discountPcts(d: Pick<RowDiscount, 'discount1' | 'discount2'>): string {
  const parts = [d.discount1, d.discount2].filter((v) => v > 0).map((v) => `−${v}%`);
  return parts.length ? parts.join(' ') : 'sin descuento';
}

/** Config de un pack: la de sus modelos si todos comparten la misma, si no "mixto". */
function groupDiscountLabel(rows: PreviewRow[]): string | null {
  const names = new Set(rows.filter((r) => r.discount).map((r) => r.discount!.name ?? 'Sin proveedor'));
  if (names.size === 0) return null;
  return names.size === 1 ? [...names][0] : 'mixto';
}
import { PdfTextService } from '../../core/services/pdf-text.service';
import { ProductHistoryDialogComponent } from '../precio-stock/components/product-history-dialog/product-history-dialog.component';

/** Estado del formulario de carga manual de costo. */
interface CostForm {
  sku: string;
  label: string;
  mode: 'bulk' | 'unit';
  bulkPrice: number | null;
  bulkQty: number | null;
  unitCost: number | null;
  marginOverride: number | null;
  /** Proveedor vigente (`''` = sin proveedor: sin descuento). */
  supplierKey: string;
  /** Config propia del SKU (`null` = la del pack o la default del proveedor). */
  profileId: number | null;
}

function emptyCostForm(supplierKey = ''): CostForm {
  return {
    sku: '', label: '', mode: 'unit',
    bulkPrice: null, bulkQty: null, unitCost: null,
    marginOverride: null, supplierKey, profileId: null,
  };
}

/** Formulario de una config de descuento (nueva si no tiene `id`). */
interface ProfileForm {
  id: number | null;
  supplierKey: string;
  name: string;
  discount1: number | null;
  discount2: number | null;
}

/** Formulario de alta / renombre de proveedor. */
interface SupplierForm {
  key: string | null;
  name: string;
  discount1: number | null;
  discount2: number | null;
}

/**
 * Sección de Precios — Opción A "Planilla viva". Del costo del proveedor al precio publicado,
 * en una tabla. Los valores fijos viven en Ajustes; el descuento sale de la configuración del
 * proveedor (la del producto, la del pack o la default) y la ganancia se carga con cada costo. Una
 * pestaña por proveedor filtra la planilla y muestra sus configuraciones. La aplicación masiva
 * encola los cambios (cola durable, sobrevive 429).
 */
@Component({
  selector: 'app-precios',
  standalone: true,
  imports: [CurrencyPipe, DatePipe, FormsModule, NgTemplateOutlet, ProductHistoryDialogComponent, TabsComponent, MapeoProveedorComponent],
  templateUrl: './precios.component.html',
  styleUrl: './precios.component.scss',
})
export class PreciosComponent {
  private readonly pricing = inject(PricingService);
  private readonly pdfText = inject(PdfTextService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly queryClient = inject(QueryClient);

  // ── Vista: planilla de precios / mapeo con el proveedor (vive en ?tab=mapeo) ──
  readonly tabs: TabDef[] = [
    { key: 'precios', label: 'Planilla' },
    { key: 'mapeo', label: 'Mapeo con el proveedor' },
  ];
  readonly tab = signal<PreciosTab>(this.route.snapshot.queryParamMap.get('tab') === 'mapeo' ? 'mapeo' : 'precios');

  setTab(key: string): void {
    const tab: PreciosTab = key === 'mapeo' ? 'mapeo' : 'precios';
    this.tab.set(tab);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab: tab === 'mapeo' ? 'mapeo' : null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  // ── Importación de lista (fase 4) ──
  readonly showImport = signal(false);
  readonly importing = signal(false);
  readonly importPreview = signal<ImportPreview | null>(null);
  readonly importFileName = signal<string | null>(null);
  readonly importFormat = signal<'pdf' | 'csv'>('pdf');
  readonly importLabel = signal('');
  /** Proveedor de la lista y config de descuento para lo que no tiene una propia (null = la default). */
  readonly importSupplier = signal<string>('');
  readonly importProfileId = signal<number | null>(null);
  /** Texto del último archivo leído: cambiar de proveedor rehace el preview con sus códigos. */
  private importText: string | null = null;
  /** Confirmaciones de mapeo que hizo el usuario en este import: sku → código. */
  readonly mappingChoices = signal<Record<string, string>>({});
  /** SKUs cuyo precio efectivo cambió con el ÚLTIMO cambio (import de lista o Ajustes), para resaltar la fila. */
  readonly changedSkus = signal<Set<string>>(new Set());

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

  readonly allRows = computed<PreviewRow[]>(() => this.previewQuery.data()?.rows ?? []);
  readonly config = computed<PricingConfig | undefined>(() => this.configQuery.data());

  // ── Pestañas por proveedor (vive en ?proveedor=) ──
  readonly suppliers = computed<Supplier[]>(() => this.config()?.suppliers ?? []);
  readonly supplierTab = signal<string>(this.route.snapshot.queryParamMap.get('proveedor') || ALL_SUPPLIERS);
  /** El proveedor de la pestaña (null en "Todos" o si la pestaña ya no existe). */
  readonly currentSupplier = computed<Supplier | null>(
    () => this.suppliers().find((s) => s.key === this.supplierTab()) ?? null,
  );
  readonly supplierTabs = computed<TabDef[]>(() => {
    const rows = this.allRows();
    return [
      { key: ALL_SUPPLIERS, label: 'Todos', count: rows.length },
      ...this.suppliers().map((s) => ({ key: s.key, label: s.name, count: rows.filter((r) => r.suppliers?.includes(s.key)).length })),
    ];
  });
  /** Pestaña efectiva: si el proveedor de la URL no existe (borrado), "Todos". */
  readonly activeSupplierTab = computed(() => this.currentSupplier()?.key ?? ALL_SUPPLIERS);

  setSupplierTab(key: string): void {
    this.supplierTab.set(key);
    this.selected.set(new Set());
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { proveedor: key === ALL_SUPPLIERS ? null : key },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  supplierName(key: string | null | undefined): string {
    if (!key) return 'Sin proveedor';
    return this.suppliers().find((s) => s.key === key)?.name ?? key;
  }

  /** Filas de la planilla: las del proveedor de la pestaña (todas en "Todos"). */
  readonly rows = computed<PreviewRow[]>(() => {
    const sup = this.currentSupplier();
    const all = this.allRows();
    return sup ? all.filter((r) => r.suppliers?.includes(sup.key)) : all;
  });

  // Selección para aplicar. Empieza con todo lo que esté mapeado en al menos un canal.
  readonly selected = signal<Set<string>>(new Set());
  readonly search = signal('');
  /** Mostrar solo lo que falta aplicar (precio calculado ≠ publicado). */
  readonly onlyPending = signal(false);

  /** ¿Falta aplicar en algún canal? Lo que ya está en la cola de ML no cuenta como pendiente. */
  isPending(r: PreviewRow): boolean {
    return (r.pendingMl && !r.mlQueued) || r.pendingTn;
  }

  readonly pendingCount = computed(() => this.rows().filter((r) => this.isPending(r)).length);

  readonly filteredRows = computed(() => {
    const q = this.search().trim().toLowerCase();
    const base = this.onlyPending() ? this.rows().filter((r) => this.isPending(r)) : this.rows();
    if (!q) return base;
    return base.filter(
      (r) => r.sku.toLowerCase().includes(q)
        || (r.label ?? '').toLowerCase().includes(q)
        || (r.name ?? '').toLowerCase().includes(q)
        || (r.pack?.name ?? '').toLowerCase().includes(q),
    );
  });

  readonly selectedCount = computed(() => this.selected().size);
  readonly allSelected = computed(() => {
    const rows = this.filteredRows();
    return rows.length > 0 && rows.every((r) => this.selected().has(r.sku));
  });

  /** Filas agrupadas por pack (mismo precio de compra para todos los modelos) + las sueltas. */
  readonly priceGroups = computed<{ groups: PriceGroup[]; noPack: PreviewRow[] }>(() => {
    const byPack = new Map<number, { pack: PreviewRowPack; rows: PreviewRow[] }>();
    const noPack: PreviewRow[] = [];
    for (const r of this.filteredRows()) {
      if (r.pack) {
        let g = byPack.get(r.pack.packId);
        if (!g) { g = { pack: r.pack, rows: [] }; byPack.set(r.pack.packId, g); }
        g.rows.push(r);
      } else {
        noPack.push(r);
      }
    }
    const groups = [...byPack.values()]
      .sort((a, b) => a.pack.name.localeCompare(b.pack.name, 'es'))
      .map((g) => ({
        ...g,
        tn: range(g.rows.map((r) => r.tn.effective)),
        ml: range(g.rows.map((r) => r.mlEffective)),
        unpublished: g.rows.filter((r) => !r.mappedMl && !r.mappedTn).length,
        pending: g.rows.filter((r) => this.isPending(r)).length,
        discountLabel: groupDiscountLabel(g.rows),
      }));
    return { groups, noPack };
  });

  // ── Packs plegables ──
  /** Packs desplegados. Arrancan plegados: con muchos packs la planilla se hacía eterna. */
  readonly expandedPacks = signal<Set<number>>(new Set());

  /** Con una búsqueda o "solo pendientes" se muestran abiertos: si no, lo filtrado quedaría escondido. */
  isPackExpanded(packId: number): boolean {
    return !!this.search().trim() || this.onlyPending() || this.expandedPacks().has(packId);
  }

  /** Selecciona exactamente lo que falta aplicar (dentro de lo filtrado por la búsqueda). */
  selectPending(): void {
    this.selected.set(new Set(this.filteredRows().filter((r) => this.isPending(r)).map((r) => r.sku)));
  }

  togglePack(packId: number): void {
    this.expandedPacks.update((set) => {
      const next = new Set(set);
      if (next.has(packId)) next.delete(packId); else next.add(packId);
      return next;
    });
  }

  setAllPacksExpanded(open: boolean): void {
    this.expandedPacks.set(open ? new Set(this.priceGroups().groups.map((g) => g.pack.packId)) : new Set());
  }

  /** ¿Alguna fila del pack se movió con el último cambio? (para marcar el grupo plegado) */
  groupChanged(g: PriceGroup): boolean {
    const changed = this.changedSkus();
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

  // ── Modales ──
  readonly showSettings = signal(false);
  readonly showCostForm = signal(false);
  readonly costForm = signal<CostForm>(emptyCostForm());
  readonly settingsDraft = signal<PricingSettings | null>(null);
  readonly tiersDraft = signal<MlFeeTier[]>([]);

  readonly saving = signal(false);
  readonly applying = signal(false);
  readonly applyResult = signal<string | null>(null);
  readonly errorMsg = signal<string | null>(null);

  toggleRow(sku: string): void {
    this.selected.update((set) => {
      const next = new Set(set);
      if (next.has(sku)) next.delete(sku); else next.add(sku);
      return next;
    });
  }

  toggleAll(): void {
    const rows = this.filteredRows();
    if (this.allSelected()) {
      this.selected.set(new Set());
    } else {
      this.selected.set(new Set(rows.map((r) => r.sku)));
    }
  }

  delta(current: number | null, next: number): { pct: number; dir: 'up' | 'down' | 'same' } | null {
    if (current == null || current === 0) return null;
    const pct = ((next - current) / current) * 100;
    return { pct: Math.round(pct * 10) / 10, dir: pct > 0.05 ? 'up' : pct < -0.05 ? 'down' : 'same' };
  }

  // ── Ajustes ──
  openSettings(): void {
    const c = this.config();
    if (!c) return;
    this.settingsDraft.set({ ...c.settings });
    this.tiersDraft.set(c.tiers.map((t) => ({ ...t })));
    this.errorMsg.set(null);
    this.feesSync.set(null);
    this.showSettings.set(true);
  }

  // ── Sincronizar comisiones con ML (fase 5) ──
  readonly syncingFees = signal(false);
  readonly feesSync = signal<MlFeesSync | null>(null);

  /** Trae de la API de ML la comisión y los tramos reales, para compararlos con lo cargado. */
  async fetchMlFees(): Promise<void> {
    this.syncingFees.set(true);
    this.errorMsg.set(null);
    this.feesSync.set(null);
    try {
      this.feesSync.set(await firstValueFrom(this.pricing.syncMlFees(false)));
    } catch (e) {
      this.errorMsg.set(`No se pudo consultar ML: ${(e as { error?: { error?: string } })?.error?.error ?? (e as Error)?.message ?? e}`);
    } finally {
      this.syncingFees.set(false);
    }
  }

  /** Vuelca a los campos del formulario la comisión y los tramos que trajo ML. */
  applyMlFeesToDraft(): void {
    const sync = this.feesSync();
    if (!sync) return;
    if (sync.remote.commissionPct != null) this.updateSettingsDraft('commissionPct', sync.remote.commissionPct);
    if (sync.remote.tiers?.length) this.tiersDraft.set(sync.remote.tiers.map((t) => ({ ...t })));
    this.feesSync.set(null);
  }

  async saveSettings(): Promise<void> {
    const draft = this.settingsDraft();
    if (!draft) return;
    this.saving.set(true);
    this.errorMsg.set(null);
    // Ajustes es global: cambia la fórmula para TODOS los productos, así que el "afectado" acá se
    // decide comparando el precio que se ve en cada fila (el efectivo — el ajustado a mano, si hay
    // uno, no se mueve solo porque cambió la fórmula) antes y después de guardar.
    const before = new Map(this.allRows().map((r) => [r.sku, { tn: r.tn.effective, ml: r.mlEffective }]));
    try {
      await firstValueFrom(this.pricing.saveConfig({ ...draft, tiers: this.tiersDraft() }));
      // Se lee el resultado que devuelve el propio refetch (no el signal this.rows()) porque no hay
      // garantía de que el signal ya haya propagado el dato nuevo en el mismo tick del await.
      const [, previewResult] = await Promise.all([this.configQuery.refetch(), this.previewQuery.refetch()]);
      const changed = new Set<string>();
      for (const row of previewResult.data?.rows ?? []) {
        const prev = before.get(row.sku);
        if (!prev || Math.abs(prev.tn - row.tn.effective) > 0.01 || Math.abs(prev.ml - row.mlEffective) > 0.01) {
          changed.add(row.sku);
        }
      }
      this.changedSkus.set(changed);
      this.showSettings.set(false);
    } catch (e) {
      this.errorMsg.set((e as Error)?.message ?? 'No se pudo guardar');
    } finally {
      this.saving.set(false);
    }
  }

  // ── Carga manual de costo ──
  openCostForm(row?: PreviewRow): void {
    if (row) {
      const byBulk = row.bulkPrice != null && row.bulkQty != null;
      this.costForm.set({
        sku: row.sku, label: row.label ?? '', mode: byBulk ? 'bulk' : 'unit',
        bulkPrice: row.bulkPrice, bulkQty: row.bulkQty, unitCost: byBulk ? null : row.unitCost,
        marginOverride: null,
        supplierKey: row.supplierKey ?? '',
        profileId: row.discount?.level === 'sku' ? row.discount.profileId : null,
      });
    } else {
      this.costForm.set(emptyCostForm(this.currentSupplier()?.key ?? this.suppliers()[0]?.key ?? ''));
    }
    this.errorMsg.set(null);
    this.showCostForm.set(true);
  }

  async saveCost(): Promise<void> {
    const f = this.costForm();
    if (!f.sku.trim()) { this.errorMsg.set('El SKU es obligatorio'); return; }
    this.saving.set(true);
    this.errorMsg.set(null);
    try {
      const supplier = { supplierKey: f.supplierKey || null };
      const payload = f.mode === 'bulk'
        ? { source: 'manual' as const, bulkPrice: f.bulkPrice, bulkQty: f.bulkQty, marginOverride: f.marginOverride, label: f.label, ...supplier, ...(f.supplierKey ? { profileId: f.profileId } : {}) }
        : { source: 'manual' as const, unitCost: f.unitCost, marginOverride: f.marginOverride, label: f.label, ...supplier };
      await firstValueFrom(this.pricing.saveCost(f.sku.trim(), payload));
      await Promise.all([this.previewQuery.refetch(), this.configQuery.refetch()]);
      this.showCostForm.set(false);
    } catch (e) {
      this.errorMsg.set((e as Error)?.message ?? 'No se pudo guardar el costo');
    } finally {
      this.saving.set(false);
    }
  }

  async removeCost(sku: string): Promise<void> {
    try {
      await firstValueFrom(this.pricing.deleteCost(sku));
      this.selected.update((s) => { const n = new Set(s); n.delete(sku); return n; });
      await this.previewQuery.refetch();
    } catch (e) {
      this.errorMsg.set((e as Error)?.message ?? 'No se pudo borrar');
    }
  }

  // ── Ajuste manual de precio publicado (por canal) ──
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
      await this.previewQuery.refetch();
    } catch (e) {
      this.errorMsg.set((e as Error)?.message ?? 'No se pudo guardar el ajuste');
    }
  }

  // ── Historial ──
  readonly historySku = signal<string | null>(null);
  readonly showLists = signal(false);

  readonly listsQuery = injectQuery(() => ({
    queryKey: ['pricing', 'lists'],
    queryFn: () => firstValueFrom(this.pricing.getLists()),
    enabled: this.showLists(),
    staleTime: 30_000,
  }));

  readonly importedLists = computed<ImportedList[]>(() => this.listsQuery.data()?.lists ?? []);

  openLists(): void {
    this.showLists.set(true);
  }

  /** Lista con el "¿Borrar?" abierto (confirmación en línea). */
  readonly confirmDeleteListId = signal<number | null>(null);
  readonly deletingList = signal(false);
  readonly listDeleteError = signal<string | null>(null);

  /**
   * Borra una lista importada: sus ítems y los códigos que ya no estén en ninguna lista. Sirve para
   * sacar una importación mal leída antes de volver a importarla. Los costos ya cargados quedan.
   */
  async deleteList(list: ImportedList): Promise<void> {
    this.deletingList.set(true);
    this.listDeleteError.set(null);
    try {
      await firstValueFrom(this.pricing.deleteList(list.id));
      this.confirmDeleteListId.set(null);
      await Promise.all([
        this.listsQuery.refetch(),
        this.queryClient.invalidateQueries({ queryKey: ['pricing', 'mapping'] }),
      ]);
    } catch (e) {
      this.listDeleteError.set(`No se pudo borrar "${list.label}": ${(e as Error)?.message ?? e}`);
    } finally {
      this.deletingList.set(false);
    }
  }

  openHistory(sku: string): void {
    this.historySku.set(sku);
  }

  dismissChanged(): void {
    this.changedSkus.set(new Set());
  }

  // ── Aplicar masivo ──
  async apply(): Promise<void> {
    const skus = [...this.selected()];
    if (skus.length === 0) return;
    this.applying.set(true);
    this.applyResult.set(null);
    this.errorMsg.set(null);
    try {
      const res = await firstValueFrom(this.pricing.apply(skus));
      const parts = [`${res.enqueuedMl} en cola para ML`, `${res.appliedTn} aplicados en TN`];
      if (res.failed > 0) parts.push(`${res.failed} con problemas`);
      this.applyResult.set(parts.join(' · '));
      await this.previewQuery.refetch();
    } catch (e) {
      this.errorMsg.set((e as Error)?.message ?? 'No se pudo aplicar');
    } finally {
      this.applying.set(false);
    }
  }

  // ── Importación de lista ──────────────────────────────────────────────────

  openImport(): void {
    this.importPreview.set(null);
    this.importResult.set(null);
    this.importFileName.set(null);
    this.importLabel.set('');
    this.mappingChoices.set({});
    this.errorMsg.set(null);
    this.importText = null;
    const sup = this.currentSupplier() ?? this.suppliers()[0] ?? null;
    this.importSupplier.set(sup?.key ?? '');
    this.importProfileId.set(defaultProfile(sup)?.id ?? null);
    this.showImport.set(true);
  }

  /** Lee el archivo (PDF o CSV), extrae el texto y pide el preview al backend. */
  async onFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.importing.set(true);
    this.errorMsg.set(null);
    try {
      const { text, format } = await this.pdfText.extract(file);
      this.importFormat.set(format);
      this.importResult.set(null);
      this.mappingChoices.set({});
      this.importFileName.set(file.name);
      if (!this.importLabel()) this.importLabel.set(file.name.replace(/\.(pdf|csv|txt)$/i, ''));
      this.importText = text;
      const preview = await firstValueFrom(this.pricing.previewImport(text, format, this.importSupplier() || undefined));
      this.importPreview.set(preview);
    } catch (e) {
      this.errorMsg.set(`No se pudo leer el archivo: ${(e as Error)?.message ?? e}`);
      this.importPreview.set(null);
    } finally {
      this.importing.set(false);
      input.value = ''; // permite volver a elegir el mismo archivo
    }
  }

  /** Confirma (o descarta) la sugerencia de mapeo de un SKU dentro del import. */
  chooseMapping(sku: string, code: string | null): void {
    this.mappingChoices.update((m) => {
      const next = { ...m };
      if (code) next[sku] = code; else delete next[sku];
      return next;
    });
  }

  /** Resultado del último import: el modal pasa a mostrar qué tomó precio de la lista y qué no. */
  readonly importResult = signal<ImportResult | null>(null);

  readonly pendingMappings = computed<MappingSuggestion[]>(
    () => this.importPreview()?.mapping.review ?? [],
  );
  readonly confirmedCount = computed(() => Object.keys(this.mappingChoices()).length);

  /** Guarda la lista, los mapeos confirmados a mano y actualiza los costos. */
  async confirmImport(): Promise<void> {
    const preview = this.importPreview();
    if (!preview || !this.importLabel().trim()) {
      this.errorMsg.set('Falta el nombre de la lista');
      return;
    }
    this.saving.set(true);
    this.errorMsg.set(null);
    try {
      const supplierKey = this.importSupplier();
      // Primero los mapeos que confirmaste: así el import ya los usa para volcar los costos.
      // Un pack confirmado va a pack_code_map (y de ahí el costo se vuelca a TODOS sus miembros).
      for (const m of this.pendingMappings()) {
        const code = this.mappingChoices()[m.sku];
        if (!code) continue;
        if (m.isPack && m.packId != null) {
          await firstValueFrom(this.pricing.confirmPackMapping(m.packId, code, 'manual', supplierKey));
        } else {
          await firstValueFrom(this.pricing.confirmMapping(m.sku, code, 'manual', supplierKey));
        }
      }

      const res = await firstValueFrom(this.pricing.confirmImport({
        label: this.importLabel().trim(),
        sourceFilename: this.importFileName(),
        supplierKey,
        profileId: this.importProfileId(),
        rows: preview.rows,
      }));

      const sinCodigo = res.summary?.unmatched.length ?? 0;
      this.applyResult.set(
        `Lista "${this.importLabel().trim()}": ${res.autoMapped} producto${res.autoMapped === 1 ? '' : 's'} con precio de esta lista`
        + ` · ${res.costsUpdated} costo${res.costsUpdated === 1 ? '' : 's'} actualizado${res.costsUpdated === 1 ? '' : 's'}`
        + (sinCodigo > 0 ? ` · ${sinCodigo} sin código` : ''),
      );
      // Resalta en la planilla los productos cuyo costo esta lista realmente movió (no todos los
      // que tienen mapeo — algunos pueden haber quedado con el mismo precio que antes).
      this.changedSkus.set(new Set(res.changedSkus ?? []));
      await Promise.all([this.previewQuery.refetch(), this.configQuery.refetch()]);
      // El modal no se cierra: muestra el resumen (qué tomó precio, qué no tiene código).
      this.importResult.set(res);
    } catch (e) {
      this.errorMsg.set((e as Error)?.message ?? 'No se pudo importar');
    } finally {
      this.saving.set(false);
    }
  }

  /** Desde el resumen del import: cerrar e ir a la pestaña de mapeo para asignar lo que falta. */
  goToMapping(): void {
    this.showImport.set(false);
    this.setTab('mapeo');
  }

  /** Lo que cambió desde la pestaña de mapeo (código asignado a mano) se resalta en la planilla. */
  onMappingCostsChanged(skus: string[]): void {
    this.changedSkus.set(new Set(skus));
    void this.previewQuery.refetch();
  }

  briefName(b: { name: string | null; sku: string }): string {
    return b.name || b.sku;
  }

  matchSourceLabel(source: string): string {
    if (source === 'base') return 'código base';
    if (source === 'group') return 'dentro de un código múltiple';
    if (source === 'text') return 'parecido por descripción';
    return source;
  }

  updateCostForm<K extends keyof CostForm>(key: K, value: CostForm[K]): void {
    // Cambiar de proveedor saca la config propia elegida: las configs son de cada proveedor.
    this.costForm.update((f) => ({ ...f, [key]: value, ...(key === 'supplierKey' ? { profileId: null } : {}) }));
  }

  /** Configs del proveedor elegido en el formulario de costo. */
  readonly costFormProfiles = computed<DiscountProfile[]>(
    () => this.suppliers().find((s) => s.key === this.costForm().supplierKey)?.profiles ?? [],
  );

  // ── Proveedores y configuraciones de descuento ──────────────────────────────

  readonly discountPcts = discountPcts;

  /** Configs del proveedor elegido al importar. */
  readonly importProfiles = computed<DiscountProfile[]>(
    () => this.suppliers().find((s) => s.key === this.importSupplier())?.profiles ?? [],
  );

  /** Cambiar el proveedor del import: precarga su default y rehace el preview con sus códigos. */
  async setImportSupplier(key: string): Promise<void> {
    this.importSupplier.set(key);
    this.importProfileId.set(defaultProfile(this.suppliers().find((s) => s.key === key) ?? null)?.id ?? null);
    if (!this.importText) return;
    this.importing.set(true);
    try {
      this.importPreview.set(await firstValueFrom(this.pricing.previewImport(this.importText, this.importFormat(), key)));
    } catch (e) {
      this.errorMsg.set(apiError(e, 'No se pudo leer la lista'));
    } finally {
      this.importing.set(false);
    }
  }

  /** Detalle de cómo se llega al costo unitario (tooltip de la columna Descuento). */
  discountChain(r: PreviewRow): string {
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

  readonly supplierForm = signal<SupplierForm | null>(null);
  readonly profileForm = signal<ProfileForm | null>(null);
  readonly confirmDeleteSupplier = signal(false);
  readonly confirmDeleteProfileId = signal<number | null>(null);
  readonly supplierError = signal<string | null>(null);

  openNewSupplier(): void {
    this.supplierError.set(null);
    this.supplierForm.set({ key: null, name: '', discount1: 0, discount2: 0 });
  }

  openRenameSupplier(s: Supplier): void {
    this.supplierError.set(null);
    this.supplierForm.set({ key: s.key, name: s.name, discount1: null, discount2: null });
  }

  updateSupplierForm<K extends keyof SupplierForm>(key: K, value: SupplierForm[K]): void {
    this.supplierForm.update((f) => (f ? { ...f, [key]: value } : f));
  }

  async saveSupplier(): Promise<void> {
    const f = this.supplierForm();
    if (!f) return;
    if (!f.name.trim()) { this.supplierError.set('Poné el nombre del proveedor'); return; }
    this.saving.set(true);
    this.supplierError.set(null);
    try {
      if (f.key) {
        await firstValueFrom(this.pricing.renameSupplier(f.key, f.name.trim()));
      } else {
        const { key } = await firstValueFrom(this.pricing.createSupplier({
          name: f.name.trim(), discount1: Number(f.discount1) || 0, discount2: Number(f.discount2) || 0,
        }));
        this.setSupplierTab(key);
      }
      await this.configQuery.refetch();
      this.supplierForm.set(null);
    } catch (e) {
      this.supplierError.set(apiError(e, 'No se pudo guardar el proveedor'));
    } finally {
      this.saving.set(false);
    }
  }

  async deleteSupplier(s: Supplier): Promise<void> {
    this.supplierError.set(null);
    try {
      await firstValueFrom(this.pricing.deleteSupplier(s.key));
      this.confirmDeleteSupplier.set(false);
      this.setSupplierTab(ALL_SUPPLIERS);
      await this.configQuery.refetch();
    } catch (e) {
      this.supplierError.set(apiError(e, 'No se pudo borrar el proveedor'));
    }
  }

  openProfileForm(supplierKey: string, profile?: DiscountProfile): void {
    this.supplierError.set(null);
    this.profileForm.set(profile
      ? { id: profile.id, supplierKey, name: profile.name, discount1: profile.discount1, discount2: profile.discount2 }
      : { id: null, supplierKey, name: '', discount1: 0, discount2: 0 });
  }

  updateProfileForm<K extends keyof ProfileForm>(key: K, value: ProfileForm[K]): void {
    this.profileForm.update((f) => (f ? { ...f, [key]: value } : f));
  }

  /** Guarda la config; los precios de todo lo que la usa se recalculan y se marcan los que cambiaron. */
  async saveProfile(): Promise<void> {
    const f = this.profileForm();
    if (!f) return;
    if (!f.name.trim()) { this.supplierError.set('Poné un nombre a la configuración'); return; }
    this.saving.set(true);
    this.supplierError.set(null);
    const body = { name: f.name.trim(), discount1: Number(f.discount1) || 0, discount2: Number(f.discount2) || 0 };
    try {
      if (f.id != null) await firstValueFrom(this.pricing.updateProfile(f.id, body));
      else await firstValueFrom(this.pricing.createProfile(f.supplierKey, body));
      await this.refreshMarkingChanges();
      this.profileForm.set(null);
    } catch (e) {
      this.supplierError.set(apiError(e, 'No se pudo guardar la configuración'));
    } finally {
      this.saving.set(false);
    }
  }

  async makeDefaultProfile(p: DiscountProfile): Promise<void> {
    try {
      await firstValueFrom(this.pricing.updateProfile(p.id, { isDefault: true }));
      await this.refreshMarkingChanges();
    } catch (e) {
      this.supplierError.set(apiError(e, 'No se pudo cambiar la default'));
    }
  }

  async deleteProfile(p: DiscountProfile): Promise<void> {
    try {
      await firstValueFrom(this.pricing.deleteProfile(p.id));
      this.confirmDeleteProfileId.set(null);
      await this.refreshMarkingChanges();
    } catch (e) {
      this.supplierError.set(apiError(e, 'No se pudo borrar la configuración'));
    }
  }

  /** Refresca config + planilla y resalta las filas cuyo precio efectivo se movió. */
  private async refreshMarkingChanges(): Promise<void> {
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

  // ── Asignación masiva (barra de acción) ──

  /**
   * Lo seleccionado como destinos: un pack con TODOS sus modelos seleccionados va como pack (la
   * config queda en el pack y la toman también los modelos que se agreguen después); el resto, por SKU.
   */
  selectionTargets(): PricingTarget[] {
    const sel = this.selected();
    const targets: PricingTarget[] = [];
    const covered = new Set<string>();
    const rowsByPack = new Map<number, PreviewRow[]>();
    for (const r of this.rows()) {
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

  /** Modal de asignación: `discount` = config de descuento, `vigente` = cambiar de proveedor. */
  readonly assignMode = signal<'discount' | 'vigente' | null>(null);
  readonly assignSupplier = signal<string>('');
  readonly assignProfileId = signal<number | null>(null);
  readonly assignResult = signal<string | null>(null);

  readonly assignProfiles = computed<DiscountProfile[]>(
    () => this.suppliers().find((s) => s.key === this.assignSupplier())?.profiles ?? [],
  );

  openAssign(mode: 'discount' | 'vigente'): void {
    const firstSelected = this.allRows().find((r) => this.selected().has(r.sku));
    const key = this.currentSupplier()?.key ?? firstSelected?.supplierKey ?? this.suppliers()[0]?.key ?? '';
    this.assignSupplier.set(key);
    this.assignProfileId.set(defaultProfile(this.suppliers().find((s) => s.key === key) ?? null)?.id ?? null);
    this.assignResult.set(null);
    this.errorMsg.set(null);
    this.assignMode.set(mode);
  }

  setAssignSupplier(key: string): void {
    this.assignSupplier.set(key);
    this.assignProfileId.set(defaultProfile(this.suppliers().find((s) => s.key === key) ?? null)?.id ?? null);
  }

  async confirmAssign(): Promise<void> {
    const mode = this.assignMode();
    const supplierKey = this.assignSupplier();
    const targets = this.selectionTargets();
    if (!mode || !supplierKey || targets.length === 0) return;
    this.saving.set(true);
    this.errorMsg.set(null);
    try {
      if (mode === 'discount') {
        await firstValueFrom(this.pricing.assignDiscount(supplierKey, targets, this.assignProfileId()));
        await this.refreshMarkingChanges();
        this.assignMode.set(null);
      } else {
        const res = await firstValueFrom(this.pricing.setVigente(supplierKey, targets));
        await this.refreshMarkingChanges();
        if (res.withoutPrice.length > 0) {
          // Sin precio de lista de ese proveedor: el costo quedó como estaba, hay que cargarlo.
          this.assignResult.set(
            `${res.withoutPrice.length} producto${res.withoutPrice.length === 1 ? '' : 's'} sin precio de ${this.supplierName(supplierKey)}: `
            + `quedó el costo que tenía${res.withoutPrice.length === 1 ? '' : 'n'}. Cargalo a mano o importá su lista.`,
          );
        } else {
          this.assignMode.set(null);
        }
      }
    } catch (e) {
      this.errorMsg.set(apiError(e, 'No se pudo asignar'));
    } finally {
      this.saving.set(false);
    }
  }

  updateSettingsDraft<K extends keyof PricingSettings>(key: K, value: PricingSettings[K]): void {
    this.settingsDraft.update((s) => (s ? { ...s, [key]: value } : s));
  }

  updateTier(i: number, field: 'maxPrice' | 'fixedFee', value: number | null): void {
    this.tiersDraft.update((tiers) => tiers.map((t, idx) => (idx === i ? { ...t, [field]: value } : t)));
  }

  tierLabel(t: MlFeeTier): string {
    return t.maxPrice == null ? 'sin tope' : `hasta ${t.maxPrice.toLocaleString('es-AR')}`;
  }
}

/** La config default de un proveedor. */
function defaultProfile(s: Supplier | null): DiscountProfile | null {
  return s?.profiles.find((p) => p.isDefault) ?? s?.profiles[0] ?? null;
}

/** Mensaje de error de la API (`{ error }`) o el genérico. */
function apiError(e: unknown, fallback: string): string {
  return (e as { error?: { error?: string } })?.error?.error ?? (e as Error)?.message ?? fallback;
}
