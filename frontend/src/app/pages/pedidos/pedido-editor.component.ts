import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { CurrencyPipe, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { injectQuery } from '@tanstack/angular-query-experimental';
import {
  OrdersService, ORDERS_CATALOG_QUERY_KEY, CatalogUnit, CatalogMember, OrderLine, SupplierOrder,
  computeOrderTotals, lineFromCatalogUnit, lineKey, orderStatusLabel,
} from '../../core/services/orders.service';
import { matchSearchByTokens } from '../../core/services/conflicts.service';
import { SearchBarComponent } from '../../shared/components/search-bar/search-bar.component';
import { ConfirmDialogComponent } from '../../shared/components/confirm-dialog/confirm-dialog.component';
import { FactorySheetDialogComponent } from './factory-sheet-dialog.component';

/** Cuánto esperar sin cambios antes de autoguardar un borrador. */
const AUTOSAVE_MS = 700;

/**
 * Un pedido al proveedor. Si es borrador se edita (autoguardado) y abajo está el catálogo para
 * sumar packs —con o sin alerta—; si está pendiente se registra qué llegó; si ya se recibió es de
 * solo lectura. Siempre se puede abrir la vista para la fábrica.
 */
@Component({
  selector: 'app-pedido-editor',
  standalone: true,
  imports: [CurrencyPipe, DatePipe, FormsModule, RouterLink, SearchBarComponent, ConfirmDialogComponent, FactorySheetDialogComponent],
  templateUrl: './pedido-editor.component.html',
  styleUrl: './pedido-editor.component.scss',
})
export class PedidoEditorComponent implements OnDestroy {
  private readonly orders = inject(OrdersService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly statusLabel = orderStatusLabel;

  readonly order = signal<SupplierOrder | null>(null);
  readonly loadError = signal<string | null>(null);
  readonly actionError = signal<string | null>(null);
  readonly flash = signal<string | null>(null);
  readonly busy = signal(false);

  readonly isDraft = computed(() => this.order()?.status === 'borrador');
  readonly isPending = computed(() => this.order()?.status === 'pendiente');
  readonly totals = computed(() => {
    const o = this.order();
    return o ? computeOrderTotals(o) : null;
  });

  constructor() {
    this.route.paramMap.subscribe((params) => this.load(Number(params.get('id'))));
  }

  ngOnDestroy(): void {
    // Lo que quedó sin guardar al salir de la página se manda igual (sin esperar).
    if (this.saveTimer) { clearTimeout(this.saveTimer); void this.saveNow(); }
  }

  private async load(id: number): Promise<void> {
    this.order.set(null);
    this.loadError.set(null);
    this.receiving.set(false);
    try {
      this.order.set(await this.orders.get(id));
    } catch (e: unknown) {
      const err = e as { status?: number };
      this.loadError.set(err?.status === 404 ? 'Ese pedido no existe (o se borró).' : 'No se pudo cargar el pedido.');
    }
  }

  private async run(fn: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.actionError.set(null);
    try {
      await fn();
    } catch (e: unknown) {
      const err = e as { error?: { error?: string }; message?: string };
      this.actionError.set(err?.error?.error || err?.message || 'No se pudo completar la acción.');
    } finally {
      this.busy.set(false);
    }
  }

  private showFlash(msg: string): void {
    this.flash.set(msg);
    setTimeout(() => { if (this.flash() === msg) this.flash.set(null); }, 4000);
  }

  // ══════════════════════ Autoguardado del borrador ══════════════════════

  readonly saveState = signal<'saved' | 'pending' | 'saving' | 'error'>('saved');
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  /** Aplica un cambio al borrador (copia nueva, para que los computed se enteren) y agenda el guardado. */
  private edit(fn: (o: SupplierOrder) => SupplierOrder): void {
    const o = this.order();
    if (!o || o.status !== 'borrador') return;
    this.order.set(fn(o));
    this.saveState.set('pending');
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.saveNow(), AUTOSAVE_MS);
  }

  private editLine(index: number, patch: Partial<OrderLine>): void {
    this.edit((o) => ({ ...o, lines: o.lines.map((l, i) => (i === index ? { ...l, ...patch } : l)) }));
  }

  /** Guarda ya lo pendiente (también antes de marcar como pedido, para no mandar algo viejo). */
  async saveNow(): Promise<void> {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    const o = this.order();
    if (!o || o.status !== 'borrador' || this.saveState() === 'saved') return;
    this.saveState.set('saving');
    try {
      const saved = await this.orders.saveDraft(o.id, {
        name: o.name.trim() || 'Pedido sin nombre', note: o.note, discount1: o.discount1, discount2: o.discount2, lines: o.lines,
      });
      // Si mientras tanto hubo otro cambio, no se pisa lo que la usuaria está tipeando: solo se
      // toman los ids de línea nuevos (la recepción los necesita) cuando el contenido no cambió.
      if (this.order() === o) this.order.set(saved);
      this.saveState.set(this.saveTimer ? 'pending' : 'saved');
    } catch {
      this.saveState.set('error');
    }
  }

  setName(name: string): void { this.edit((o) => ({ ...o, name })); }
  setNote(note: string): void { this.edit((o) => ({ ...o, note })); }

  setDiscount(field: 'discount1' | 'discount2', value: number | string | null): void {
    const n = Math.min(100, Math.max(0, Number(value) || 0));
    this.edit((o) => ({ ...o, [field]: n }));
  }

  setLineText(index: number, field: 'code' | 'description' | 'detail', value: string): void {
    this.editLine(index, { [field]: value });
  }

  setLineQty(index: number, value: number | string | null): void {
    const n = Math.floor(Number(value));
    if (Number.isFinite(n) && n >= 1) this.editLine(index, { qty: n });
  }

  /** Pisar el precio de una línea del catálogo la marca como "editada" (solo para este pedido). */
  setLinePrice(index: number, value: number | string | null): void {
    const line = this.order()?.lines[index];
    if (!line) return;
    const price = value === '' || value === null || value === undefined ? null : Number(value);
    if (price != null && (!Number.isFinite(price) || price < 0)) return;
    this.editLine(index, { unitPrice: price, priceSource: 'manual' });
  }

  /** Vuelve al precio de Precios. */
  revertLinePrice(index: number): void {
    const line = this.order()?.lines[index];
    if (!line) return;
    this.editLine(index, { unitPrice: this.catalogPrice(line), priceSource: 'precios' });
  }

  removeLine(index: number): void {
    this.edit((o) => ({ ...o, lines: o.lines.filter((_, i) => i !== index) }));
  }

  addFreeItem(): void {
    this.edit((o) => ({
      ...o,
      lines: [...o.lines, {
        kind: 'free', packId: null, sku: null, code: '', description: '', detail: '', qty: 1,
        unitPrice: null, priceSource: 'manual', unitsPerPack: null, origin: 'libre', receivedQty: null,
      }],
    }));
  }

  // ══════════════════════ Catálogo para agregar ══════════════════════

  readonly catalogQuery = injectQuery(() => ({
    queryKey: ORDERS_CATALOG_QUERY_KEY,
    queryFn: () => this.orders.catalog(),
    staleTime: 60_000,
  }));

  readonly catalogLoading = computed(() => this.catalogQuery.isLoading());
  readonly catalogUnits = computed<CatalogUnit[]>(() => this.catalogQuery.data()?.units ?? []);
  readonly catalogByKey = computed(() => new Map(this.catalogUnits().map((u) => [u.key, u])));
  readonly catalogFilter = signal<'alert' | 'all'>('alert');
  readonly catalogSearch = signal('');
  /** Packs desplegados (se ven sus modelos). Los que avisaron arrancan abiertos. */
  private readonly toggledPacks = signal<Set<string>>(new Set());

  readonly alertedCount = computed(() => this.catalogUnits().filter((u) => u.alerted).length);

  readonly visibleUnits = computed(() => {
    const onlyAlerted = this.catalogFilter() === 'alert';
    const q = this.catalogSearch();
    return this.catalogUnits().filter((u) =>
      (!onlyAlerted || u.alerted) &&
      matchSearchByTokens(q, `${u.name} ${u.code ?? ''} ${u.description} ${u.members.map((m) => `${m.sku} ${m.label}`).join(' ')}`)
    );
  });

  /** Cantidad de cada unidad que ya está en el pedido (por clave de catálogo). */
  readonly qtyInOrder = computed(() => {
    const map = new Map<string, number>();
    for (const l of this.order()?.lines ?? []) {
      const k = lineKey(l);
      if (k) map.set(k, (map.get(k) ?? 0) + l.qty);
    }
    return map;
  });

  isPackOpen(unit: CatalogUnit): boolean {
    return unit.alerted !== this.toggledPacks().has(unit.key);
  }

  togglePack(unit: CatalogUnit): void {
    this.toggledPacks.update((s) => {
      const next = new Set(s);
      next.has(unit.key) ? next.delete(unit.key) : next.add(unit.key);
      return next;
    });
  }

  addUnit(unit: CatalogUnit, event?: Event): void {
    event?.stopPropagation();
    this.edit((o) => ({ ...o, lines: [...o.lines, lineFromCatalogUnit(unit, unit.suggestedQty ?? 1)] }));
  }

  removeUnit(unit: CatalogUnit, event?: Event): void {
    event?.stopPropagation();
    this.edit((o) => ({ ...o, lines: o.lines.filter((l) => lineKey(l) !== unit.key) }));
  }

  /** Suma la sugerencia de cada unidad con alerta activa que todavía no está en el pedido. */
  addAllSuggested(): void {
    const inOrder = this.qtyInOrder();
    const toAdd = this.catalogUnits().filter((u) => u.alerted && !inOrder.has(u.key));
    if (!toAdd.length) { this.showFlash('Todas las alertas ya están en el pedido.'); return; }
    this.edit((o) => ({ ...o, lines: [...o.lines, ...toAdd.map((u) => lineFromCatalogUnit(u, u.suggestedQty ?? 1))] }));
    this.showFlash(`${toAdd.length} sugerencia${toAdd.length === 1 ? '' : 's'} agregada${toAdd.length === 1 ? '' : 's'} — sacá las que no vayas a pedir.`);
  }

  catalogPrice(line: OrderLine): number | null {
    const k = lineKey(line);
    return k ? this.catalogByKey().get(k)?.price ?? null : null;
  }

  /** Nombre del producto/pack del hub y unidades, debajo de la descripción del proveedor. */
  lineSource(line: OrderLine): string {
    const k = lineKey(line);
    const unit = k ? this.catalogByKey().get(k) : undefined;
    const units = line.unitsPerPack ?? unit?.unitsPerPack;
    return [unit?.name, units ? `${units} u.` : null].filter(Boolean).join(' · ');
  }

  memberAlertLabel(m: CatalogMember): { text: string; cls: string } | null {
    switch (m.alertState) {
      case 'out': return { text: 'Sin stock', cls: 'err' };
      case 'still-low': return { text: `Bajo · umbral ${m.threshold}`, cls: 'warn' };
      case 'restocked': return { text: 'Ya repuesto', cls: 'ok' };
      case 'watching': return { text: 'ok', cls: 'plain' };
      default: return null;
    }
  }

  unitStockSummary(unit: CatalogUnit): { out: number; low: number; fine: number } {
    let out = 0, low = 0;
    for (const m of unit.members) {
      if (m.alertState === 'out') out++;
      else if (m.alertState === 'still-low') low++;
    }
    return { out, low, fine: unit.members.length - out - low };
  }

  // ══════════════════════ Marcar como pedido / borrar ══════════════════════

  readonly showPlaceConfirm = signal(false);
  openSheetAfterPlace = true;
  readonly linesWithoutCode = computed(() => (this.order()?.lines ?? []).filter((l) => !l.code.trim()).length);

  async place(): Promise<void> {
    const o = this.order();
    if (!o) return;
    this.showPlaceConfirm.set(false);
    await this.run(async () => {
      await this.saveNow();
      if (this.saveState() === 'error') throw new Error('No se pudo guardar el borrador antes de marcarlo como pedido.');
      this.order.set(await this.orders.place(o.id));
      if (this.openSheetAfterPlace) this.showSheet.set(true);
      this.showFlash('Pedido marcado como pedido. Queda pendiente hasta que registres qué llegó.');
    });
  }

  readonly showDeleteConfirm = signal(false);

  async deleteDraft(): Promise<void> {
    const o = this.order();
    if (!o) return;
    this.showDeleteConfirm.set(false);
    await this.run(async () => {
      if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
      this.saveState.set('saved');
      await this.orders.delete(o.id);
      this.router.navigate(['/pedidos']);
    });
  }

  async duplicate(mode: 'all' | 'missing' = 'all'): Promise<void> {
    const o = this.order();
    if (!o) return;
    await this.run(async () => {
      await this.saveNow();
      const created = await this.orders.duplicate(o.id, { mode });
      this.router.navigate(['/pedidos', created.id]);
    });
  }

  readonly showSheet = signal(false);

  async openSheet(): Promise<void> {
    await this.saveNow();
    this.showSheet.set(true);
  }

  // ══════════════════════ Recepción ══════════════════════

  readonly receiving = signal(false);
  /** lineId → packs que llegaron (lo que se va anotando antes de cerrar). */
  readonly received = signal<Record<number, number | null>>({});
  readonly showCloseReceive = signal(false);
  createMissingDraft = true;

  startReceiving(): void {
    const map: Record<number, number | null> = {};
    for (const l of this.order()?.lines ?? []) if (l.id != null) map[l.id] = l.receivedQty;
    this.received.set(map);
    this.receiving.set(true);
  }

  setReceived(line: OrderLine, value: number | string | null): void {
    if (line.id == null) return;
    const n = value === '' || value === null || value === undefined ? null : Math.max(0, Math.min(line.qty, Math.floor(Number(value))));
    this.received.update((m) => ({ ...m, [line.id as number]: Number.isFinite(n as number) || n === null ? n : null }));
  }

  fillReceived(line: OrderLine): void {
    this.setReceived(line, line.qty);
  }

  allArrived(): void {
    const map: Record<number, number | null> = {};
    for (const l of this.order()?.lines ?? []) if (l.id != null) map[l.id] = l.qty;
    this.received.set(map);
  }

  /** Líneas que llegaron cortas según lo anotado (sin dato = no llegó). */
  readonly shortLines = computed(() => {
    const rec = this.received();
    return (this.order()?.lines ?? [])
      .map((l) => ({ line: l, got: (l.id != null ? rec[l.id] : null) ?? 0 }))
      .filter((x) => x.got < x.line.qty);
  });

  /** Guarda lo anotado sin cerrar (para seguir otro día). */
  async saveReceiving(): Promise<void> {
    const o = this.order();
    if (!o) return;
    await this.run(async () => {
      this.order.set(await this.orders.receive(o.id, this.received()));
      this.receiving.set(false);
      this.showFlash('Recepción guardada. Podés seguir anotando después.');
    });
  }

  async closeReceiving(): Promise<void> {
    const o = this.order();
    if (!o) return;
    this.showCloseReceive.set(false);
    await this.run(async () => {
      const updated = await this.orders.receive(o.id, this.received(), true);
      this.order.set(updated);
      this.receiving.set(false);
      if (updated.partial && this.createMissingDraft) {
        const draft = await this.orders.duplicate(o.id, { mode: 'missing' });
        this.missingDraftId.set(draft.id);
      }
      this.showFlash(updated.partial ? 'Pedido recibido incompleto.' : 'Pedido recibido completo.');
    });
  }

  /** Borrador con los faltantes, recién creado al cerrar la recepción (para linkearlo). */
  readonly missingDraftId = signal<number | null>(null);

  receivedClass(line: OrderLine): string {
    if (line.receivedQty == null) return '';
    if (line.receivedQty === 0) return 'miss';
    return line.receivedQty < line.qty ? 'part' : '';
  }
}
