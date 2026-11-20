import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { injectQuery } from '@tanstack/angular-query-experimental';
import { firstValueFrom } from 'rxjs';
import { ApplyResult, PreviewRow, PreviewRowPack, PricingService, UncostedProduct } from '../../../core/services/pricing.service';
import { BottomSheetComponent } from '../../../shared/components/bottom-sheet/bottom-sheet.component';
import { ProductHistoryDialogComponent } from '../../precio-stock/components/product-history-dialog/product-history-dialog.component';
import { PreciosStore } from '../precios.store';
import { PriceTrend, apiError, isPendingRow, priceTrend } from '../precios.utils';

/** Sección de la lista: hacia dónde va lo pendiente, lo que espera la cola de ML y lo que está al día. */
export type PhoneSection = 'up' | 'down' | 'other' | 'queued' | 'ok';

export const PHONE_SECTIONS: { key: Exclude<PhoneSection, 'ok'>; title: string; icon: string }[] = [
  { key: 'up', title: 'Suben', icon: 'ti-trending-up' },
  { key: 'down', title: 'Bajan', icon: 'ti-trending-down' },
  { key: 'other', title: 'Por aplicar', icon: 'ti-arrows-up-down' },
  { key: 'queued', title: 'En la cola de ML', icon: 'ti-clock' },
];

/** Cómo queda un canal en una tarjeta: hoy → nuevo si falta aplicar, si no el precio publicado. */
export interface ChannelLine {
  pending: boolean;
  queued: boolean;
  /** Publicado hoy (rango en un pack; '' si no se sabe). */
  from: string;
  /** El que se aplica (rango en un pack). */
  to: string;
  trend: PriceTrend | null;
}

/** Una tarjeta: un pack entero o un producto suelto. */
export interface PhoneUnit {
  key: string;
  pack: PreviewRowPack | null;
  rows: PreviewRow[];
  section: PhoneSection;
  tn: ChannelLine;
  ml: ChannelLine;
}

export type ApplyChannels = 'both' | 'tn' | 'ml';

/** "$12.400" / "$12.400–$13.000". */
export function money(values: number[]): string {
  const known = values.filter((v) => v != null && Number.isFinite(v) && v > 0);
  if (!known.length) return '';
  const fmt = (n: number) => `$${Math.round(n).toLocaleString('es-AR')}`;
  const min = Math.min(...known);
  const max = Math.max(...known);
  return min === max ? fmt(min) : `${fmt(min)}–${fmt(max)}`;
}

function channelLine(rows: PreviewRow[], ch: 'tn' | 'ml'): ChannelLine {
  const next = (r: PreviewRow) => (ch === 'tn' ? r.tn.effective : r.mlEffective);
  const current = (r: PreviewRow) => (ch === 'tn' ? r.currentTn : r.currentMl);
  const pendingRows = rows.filter((r) => (ch === 'tn' ? r.pendingTn : r.pendingMl && !r.mlQueued));
  const shown = pendingRows.length ? pendingRows : rows;
  return {
    pending: pendingRows.length > 0,
    queued: ch === 'ml' && rows.some((r) => r.mlQueued),
    from: money(shown.map((r) => current(r) ?? 0)),
    to: money(shown.map(next)),
    trend: priceTrend(pendingRows.map((r) => ({ current: current(r), next: next(r) }))),
  };
}

/** Sube si todo lo pendiente sube, baja si todo baja; si no (o no se sabe lo publicado), "por aplicar". */
function sectionOf(rows: PreviewRow[], tn: ChannelLine, ml: ChannelLine): PhoneSection {
  if (rows.some(isPendingRow)) {
    const dirs = [tn, ml].filter((c) => c.pending).map((c) => c.trend?.dir ?? 'unknown');
    if (dirs.every((d) => d === 'up')) return 'up';
    if (dirs.every((d) => d === 'down')) return 'down';
    return 'other';
  }
  return rows.some((r) => r.mlQueued) ? 'queued' : 'ok';
}

/** Filas → tarjetas: un pack es una sola tarjeta; los sueltos, una cada uno. */
export function buildPhoneUnits(rows: PreviewRow[]): PhoneUnit[] {
  const units: PhoneUnit[] = [];
  const byPack = new Map<number, PreviewRow[]>();
  for (const r of rows) {
    if (!r.pack) { units.push(unitOf(`sku:${r.sku}`, null, [r])); continue; }
    if (!byPack.has(r.pack.packId)) byPack.set(r.pack.packId, []);
    byPack.get(r.pack.packId)!.push(r);
  }
  for (const [packId, packRows] of byPack) units.push(unitOf(`pack:${packId}`, packRows[0].pack, packRows));
  return units.sort((a, b) => unitTitle(a).localeCompare(unitTitle(b), 'es'));
}

function unitOf(key: string, pack: PreviewRowPack | null, rows: PreviewRow[]): PhoneUnit {
  const tn = channelLine(rows, 'tn');
  const ml = channelLine(rows, 'ml');
  return { key, pack, rows, tn, ml, section: sectionOf(rows, tn, ml) };
}

export function unitTitle(u: PhoneUnit): string {
  return u.pack?.name ?? u.rows[0].name ?? u.rows[0].label ?? u.rows[0].sku;
}

/** SKUs a mandar para un canal (o los dos): solo lo que falta aplicar ahí. */
export function pendingSkus(rows: PreviewRow[], channels: ApplyChannels): string[] {
  return rows
    .filter((r) => (channels !== 'ml' && r.pendingTn) || (channels !== 'tn' && r.pendingMl && !r.mlQueued))
    .map((r) => r.sku);
}

/** El precio que guarda un ajuste: nada si es igual al calculado (o vacío). */
function overrideOf(value: number | null, calculated: number): number | null {
  return value != null && Number.isFinite(value) && value > 0 && value !== calculated ? value : null;
}

/**
 * La planilla en el celular (opción B de `docs/prototype/precios-mobile.html`): tres números arriba
 * (por aplicar, en la cola de ML, fallaron en la última aplicación), la lista separada en
 * Suben / Bajan con hoy → nuevo por canal, y un botón fijo para aplicar todo lo pendiente (con una
 * hoja de confirmación). Tocar una tarjeta abre una hoja para retocar el precio. Lo que se tilda,
 * asigna o quita en masa sigue siendo de la compu.
 */
@Component({
  selector: 'zc-planilla-phone',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, BottomSheetComponent, ProductHistoryDialogComponent],
  templateUrl: './planilla-phone.component.html',
  styleUrl: './planilla-phone.component.scss',
})
export class PlanillaPhoneComponent {
  protected readonly store = inject(PreciosStore);
  private readonly pricing = inject(PricingService);

  readonly sectionDefs = PHONE_SECTIONS;
  readonly title = unitTitle;

  readonly search = signal('');
  /** Tocar un número filtra la lista. */
  readonly filter = signal<'pending' | 'queued' | null>(null);
  readonly showOk = signal(false);
  readonly showUncosted = signal(false);
  readonly errorMsg = signal<string | null>(null);
  readonly applyFailures = signal<ApplyResult['results']>([]);
  readonly historySku = signal<string | null>(null);

  /** La última aplicación, para el número "Fallaron" (misma query que la pestaña Aplicaciones). */
  readonly runsQuery = injectQuery(() => ({
    queryKey: ['pricing', 'apply-runs', 1],
    queryFn: () => firstValueFrom(this.pricing.listApplyRuns(20, 0)),
  }));
  readonly lastRunFailed = computed(() => {
    const run = this.runsQuery.data()?.runs[0];
    return run ? (run.counts.ml.failed ?? 0) + (run.counts.tn.failed ?? 0) : 0;
  });

  readonly units = computed(() => {
    const q = this.search().trim().toLowerCase();
    const rows = q
      ? this.store.rows().filter((r) => [r.sku, r.label, r.name, r.pack?.name, r.pack?.sku].some((f) => (f ?? '').toLowerCase().includes(q)))
      : this.store.rows();
    return buildPhoneUnits(rows);
  });

  readonly pendingUnits = computed(() => this.units().filter((u) => u.rows.some(isPendingRow)));
  readonly counts = computed(() => {
    const rows = this.units().flatMap((u) => u.rows);
    return { pending: rows.filter(isPendingRow).length, queued: rows.filter((r) => r.mlQueued).length };
  });

  readonly sections = computed(() => {
    const f = this.filter();
    return PHONE_SECTIONS
      .filter((s) => (f === 'queued' ? s.key === 'queued' : f === 'pending' ? s.key !== 'queued' : true))
      .map((s) => ({ ...s, units: this.units().filter((u) => u.section === s.key) }))
      .filter((s) => s.units.length);
  });
  readonly okUnits = computed(() => (this.filter() ? [] : this.units().filter((u) => u.section === 'ok')));

  readonly uncosted = computed(() => {
    const q = this.search().trim().toLowerCase();
    const all = this.filter() ? [] : this.store.uncosted();
    return q ? all.filter((u) => [u.sku, u.name, u.pack?.name].some((f) => (f ?? '').toLowerCase().includes(q))) : all;
  });

  constructor() {
    // Una pestaña de proveedor nueva arranca sin filtro.
    effect(() => {
      this.store.activeSupplierTab();
      untracked(() => this.filter.set(null));
    }, { allowSignalWrites: true });
  }

  toggleFilter(f: 'pending' | 'queued'): void {
    this.filter.update((cur) => (cur === f ? null : f));
  }

  pct(v: number): string {
    return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('es-AR')}%`;
  }

  trendText(t: PriceTrend | null): string {
    if (!t) return '';
    return t.minPct === t.maxPct ? this.pct(t.minPct) : `${this.pct(t.minPct)} a ${this.pct(t.maxPct)}`;
  }

  subtitle(u: PhoneUnit): string {
    if (u.pack) return [`pack de ${u.pack.unitCount} u.`, u.pack.sku, `${u.rows.length} modelo${u.rows.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
    return u.rows[0].sku;
  }

  /** El costo sale de otro proveedor que el de la pestaña. */
  otherVigente(u: PhoneUnit): string | null {
    const sup = this.store.currentSupplier();
    const other = u.rows.find((r) => sup && r.supplierKey && r.supplierKey !== sup.key);
    return other ? this.store.supplierName(other.supplierKey) : null;
  }

  unpublished(u: PhoneUnit): number {
    return u.rows.filter((r) => !r.mappedMl && !r.mappedTn).length;
  }

  // ── Hoja de precio (un pack o un producto) ──

  private readonly openKey = signal<string | null>(null);
  readonly open = computed<PhoneUnit | null>(() => {
    const key = this.openKey();
    if (!key) return null;
    const unit = this.units().find((u) => u.key === key);
    if (unit) return unit;
    // Un modelo de un pack, abierto desde la hoja del pack.
    const row = key.startsWith('sku:') ? this.store.rows().find((r) => r.sku === key.slice(4)) : null;
    return row ? unitOf(key, null, [row]) : null;
  });
  /** El modelo abierto pertenece a un pack (para el subtítulo y volver). */
  readonly openParentPack = computed(() => {
    const u = this.open();
    return u && !u.pack ? u.rows[0].pack : null;
  });
  readonly tnDraft = signal<number | null>(null);
  readonly mlDraft = signal<number | null>(null);
  private initial = { tn: null as number | null, ml: null as number | null };
  readonly saving = signal(false);
  readonly showAllModels = signal(false);

  openUnit(u: PhoneUnit | string): void {
    const key = typeof u === 'string' ? u : u.key;
    this.openKey.set(key);
    this.showAllModels.set(false);
    const unit = this.open();
    if (!unit) return;
    const same = (vals: number[]) => (vals.every((v) => v === vals[0]) ? vals[0] : null);
    this.initial = { tn: same(unit.rows.map((r) => r.tn.effective)), ml: same(unit.rows.map((r) => r.mlEffective)) };
    this.tnDraft.set(this.initial.tn);
    this.mlDraft.set(this.initial.ml);
  }

  closeUnit(): void {
    this.openKey.set(null);
  }

  dirty(): boolean {
    return toNum(this.tnDraft()) !== this.initial.tn || toNum(this.mlDraft()) !== this.initial.ml;
  }

  /** Guarda el ajuste de los canales que cambiaron (en un pack, el mismo para todos sus modelos). */
  async savePrices(u: PhoneUnit): Promise<void> {
    this.saving.set(true);
    this.errorMsg.set(null);
    try {
      for (const ch of ['tn', 'ml'] as const) {
        const value = toNum(ch === 'tn' ? this.tnDraft() : this.mlDraft());
        if (value === this.initial[ch]) continue;
        const items = u.rows.map((r) => ({ sku: r.sku, value: overrideOf(value, ch === 'tn' ? r.tn.list : r.ml) }));
        await firstValueFrom(this.pricing.saveOverrides(ch, items));
      }
      await this.store.previewQuery.refetch();
      this.openUnit(u.key);
    } catch (e) {
      this.errorMsg.set(apiError(e, 'No se pudo guardar el precio'));
    } finally {
      this.saving.set(false);
    }
  }

  editCost(u: PhoneUnit): void {
    this.closeUnit();
    if (u.rows.length === 1) {
      this.store.open({ kind: 'cost', row: u.rows[0] });
      return;
    }
    const bulkLabels: Record<string, string | null> = {};
    for (const r of u.rows) bulkLabels[r.sku] = r.label;
    const supplierKey = this.store.currentSupplier()?.key ?? u.rows[0].supplierKey;
    this.store.open({ kind: 'cost', row: null, prefill: { skus: Object.keys(bulkLabels), label: null, supplierKey, bulkLabels } });
  }

  shownModels(u: PhoneUnit): { rows: PreviewRow[]; hidden: number } {
    if (this.showAllModels() || u.rows.length <= 4) return { rows: u.rows, hidden: 0 };
    return { rows: u.rows.slice(0, 3), hidden: u.rows.length - 3 };
  }

  // ── Aplicar ──

  readonly confirming = signal(false);
  readonly excluded = signal<Set<string>>(new Set());
  readonly channels = signal<ApplyChannels>('both');
  readonly applying = signal(false);

  readonly confirmUnits = computed(() => this.pendingUnits().filter((u) => !this.excluded().has(u.key)));
  readonly confirmCounts = computed(() => {
    const rows = this.confirmUnits().flatMap((u) => u.rows);
    return { tn: pendingSkus(rows, 'tn').length, ml: pendingSkus(rows, 'ml').length };
  });
  readonly confirmSkus = computed(() => pendingSkus(this.confirmUnits().flatMap((u) => u.rows), this.channels()));

  openConfirm(): void {
    this.excluded.set(new Set());
    this.channels.set('both');
    this.confirming.set(true);
  }

  toggleExcluded(u: PhoneUnit): void {
    this.excluded.update((s) => {
      const n = new Set(s);
      if (n.has(u.key)) n.delete(u.key); else n.add(u.key);
      return n;
    });
  }

  async apply(skus: string[], channels: ApplyChannels = 'both'): Promise<void> {
    if (!skus.length) return;
    this.applying.set(true);
    this.store.notice.set(null);
    this.errorMsg.set(null);
    this.applyFailures.set([]);
    try {
      const res = await firstValueFrom(this.pricing.apply(skus, { ml: channels !== 'tn', tn: channels !== 'ml' }));
      const parts = [];
      if (channels !== 'tn') parts.push(`${res.enqueuedMl} en cola para ML`);
      if (channels !== 'ml') parts.push(`${res.appliedTn} aplicados en TN`);
      if (res.failed > 0) parts.push(`${res.failed} con problemas`);
      this.store.notice.set(parts.join(' · '));
      this.applyFailures.set(res.results.filter((r) => !r.ok));
      this.confirming.set(false);
      this.closeUnit();
      await Promise.all([this.store.previewQuery.refetch(), this.runsQuery.refetch()]);
    } catch (e) {
      this.errorMsg.set(apiError(e, 'No se pudo aplicar'));
    } finally {
      this.applying.set(false);
    }
  }

  /** "Aplicar a ML y TN" desde la hoja: lo pendiente de ese pack o producto. */
  applyUnit(u: PhoneUnit): Promise<void> {
    return this.apply(pendingSkus(u.rows, 'both'));
  }

  // ── Sin costo ──

  loadCost(u: UncostedProduct): void {
    const skus = u.pack ? this.store.uncosted().filter((x) => x.pack?.packId === u.pack!.packId).map((x) => x.sku) : [u.sku];
    const supplierKey = this.store.currentSupplier()?.key ?? u.suppliers[0] ?? null;
    this.store.open({ kind: 'cost', row: null, prefill: { skus, label: u.pack?.name ?? u.name ?? null, supplierKey } });
  }

  /** Lo sin costo, un renglón por pack (se carga el mismo bulto a sus modelos). */
  readonly uncostedLines = computed(() => {
    const seen = new Set<number>();
    const lines: { item: UncostedProduct; label: string; count: number }[] = [];
    for (const u of this.uncosted()) {
      if (u.pack) {
        if (seen.has(u.pack.packId)) continue;
        seen.add(u.pack.packId);
        const count = this.uncosted().filter((x) => x.pack?.packId === u.pack!.packId).length;
        lines.push({ item: u, label: u.pack.name, count });
      } else {
        lines.push({ item: u, label: u.name || u.sku, count: 1 });
      }
    }
    return lines;
  });
}

function toNum(v: number | string | null): number | null {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
