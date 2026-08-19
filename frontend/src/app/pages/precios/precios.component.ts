import { Component, computed, inject, signal } from '@angular/core';
import { CurrencyPipe, DatePipe, NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { injectQuery } from '@tanstack/angular-query-experimental';
import { firstValueFrom } from 'rxjs';
import {
  PricingService, PricingConfig, PreviewRow, PreviewRowPack, PricingSettings, MlFeeTier,
  ImportPreview, MappingSuggestion, MlFeesSync, ImportedList,
} from '../../core/services/pricing.service';
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
  discount1: number | null;
  discount2: number | null;
  marginOverride: number | null;
}

function emptyCostForm(): CostForm {
  return {
    sku: '', label: '', mode: 'unit',
    bulkPrice: null, bulkQty: null, unitCost: null,
    discount1: 0, discount2: 0, marginOverride: null,
  };
}

/**
 * Sección de Precios — Opción A "Planilla viva". Del costo del proveedor al precio publicado,
 * en una tabla. Los valores fijos viven en Ajustes; los descuentos y la ganancia se cargan con
 * cada costo. La aplicación masiva encola los cambios (cola durable, sobrevive 429).
 */
@Component({
  selector: 'app-precios',
  standalone: true,
  imports: [CurrencyPipe, DatePipe, FormsModule, NgTemplateOutlet, ProductHistoryDialogComponent],
  templateUrl: './precios.component.html',
  styleUrl: './precios.component.scss',
})
export class PreciosComponent {
  private readonly pricing = inject(PricingService);
  private readonly pdfText = inject(PdfTextService);

  // ── Importación de lista (fase 4) ──
  readonly showImport = signal(false);
  readonly importing = signal(false);
  readonly importPreview = signal<ImportPreview | null>(null);
  readonly importFileName = signal<string | null>(null);
  readonly importFormat = signal<'pdf' | 'csv'>('pdf');
  readonly importLabel = signal('');
  readonly importDiscount1 = signal<number>(25);
  readonly importDiscount2 = signal<number>(5);
  readonly noDiscounts = signal(false);
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
  }));

  readonly rows = computed<PreviewRow[]>(() => this.previewQuery.data()?.rows ?? []);
  readonly config = computed<PricingConfig | undefined>(() => this.configQuery.data());

  // Selección para aplicar. Empieza con todo lo que esté mapeado en al menos un canal.
  readonly selected = signal<Set<string>>(new Set());
  readonly search = signal('');

  readonly filteredRows = computed(() => {
    const q = this.search().trim().toLowerCase();
    if (!q) return this.rows();
    return this.rows().filter(
      (r) => r.sku.toLowerCase().includes(q) || (r.label ?? '').toLowerCase().includes(q),
    );
  });

  readonly selectedCount = computed(() => this.selected().size);
  readonly allSelected = computed(() => {
    const rows = this.filteredRows();
    return rows.length > 0 && rows.every((r) => this.selected().has(r.sku));
  });

  /** Filas agrupadas por pack (mismo precio de compra para todos los modelos) + las sueltas. */
  readonly priceGroups = computed<{ groups: { pack: PreviewRowPack; rows: PreviewRow[] }[]; noPack: PreviewRow[] }>(() => {
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
    const groups = [...byPack.values()].sort((a, b) => a.pack.name.localeCompare(b.pack.name, 'es'));
    return { groups, noPack };
  });

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
    const before = new Map(this.rows().map((r) => [r.sku, { tn: r.tn.effective, ml: r.mlEffective }]));
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
      this.costForm.set({
        sku: row.sku, label: row.label ?? '', mode: row.source === 'list' ? 'bulk' : 'unit',
        bulkPrice: null, bulkQty: null, unitCost: row.unitCost,
        discount1: 0, discount2: 0, marginOverride: null,
      });
    } else {
      this.costForm.set(emptyCostForm());
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
      const payload = f.mode === 'bulk'
        ? { source: 'manual' as const, bulkPrice: f.bulkPrice, bulkQty: f.bulkQty, discount1: f.discount1, discount2: f.discount2, marginOverride: f.marginOverride, label: f.label }
        : { source: 'manual' as const, unitCost: f.unitCost, marginOverride: f.marginOverride, label: f.label };
      await firstValueFrom(this.pricing.saveCost(f.sku.trim(), payload));
      await this.previewQuery.refetch();
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
    this.importFileName.set(null);
    this.importLabel.set('');
    this.mappingChoices.set({});
    this.errorMsg.set(null);
    const c = this.config();
    this.importDiscount1.set(c?.settings.defaultDiscount1 ?? 25);
    this.importDiscount2.set(c?.settings.defaultDiscount2 ?? 5);
    this.noDiscounts.set(false);
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
      this.importFileName.set(file.name);
      if (!this.importLabel()) this.importLabel.set(file.name.replace(/\.(pdf|csv|txt)$/i, ''));
      const preview = await firstValueFrom(this.pricing.previewImport(text, format));
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
      const d1 = this.noDiscounts() ? 0 : Number(this.importDiscount1()) || 0;
      const d2 = this.noDiscounts() ? 0 : Number(this.importDiscount2()) || 0;

      // Primero los mapeos que confirmaste: así el import ya los usa para volcar los costos.
      // Un pack confirmado va a pack_code_map (y de ahí el costo se vuelca a TODOS sus miembros).
      for (const m of this.pendingMappings()) {
        const code = this.mappingChoices()[m.sku];
        if (!code) continue;
        if (m.isPack && m.packId != null) {
          await firstValueFrom(this.pricing.confirmPackMapping(m.packId, code, 'manual'));
        } else {
          await firstValueFrom(this.pricing.confirmMapping(m.sku, code, 'manual'));
        }
      }

      const res = await firstValueFrom(this.pricing.confirmImport({
        label: this.importLabel().trim(),
        sourceFilename: this.importFileName(),
        discount1: d1,
        discount2: d2,
        rows: preview.rows,
      }));

      this.applyResult.set(
        `Lista importada: ${res.autoMapped} mapeos automáticos · ${res.costsUpdated} costos actualizados`,
      );
      // Resalta en la planilla los productos cuyo costo esta lista realmente movió (no todos los
      // que tienen mapeo — algunos pueden haber quedado con el mismo precio que antes).
      this.changedSkus.set(new Set(res.changedSkus ?? []));
      await this.previewQuery.refetch();
      this.showImport.set(false);
    } catch (e) {
      this.errorMsg.set((e as Error)?.message ?? 'No se pudo importar');
    } finally {
      this.saving.set(false);
    }
  }

  matchSourceLabel(source: string): string {
    if (source === 'base') return 'código base';
    if (source === 'group') return 'dentro de un código múltiple';
    if (source === 'text') return 'parecido por descripción';
    return source;
  }

  updateCostForm<K extends keyof CostForm>(key: K, value: CostForm[K]): void {
    this.costForm.update((f) => ({ ...f, [key]: value }));
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
