import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import {
  ConflictAnalysis,
  MlRow,
  TnRow,
  mlLabel,
  tnLabel,
  matchSearchByTokens,
} from '../../../core/services/conflicts.service';
import { BottomSheetComponent } from '../../../shared/components/bottom-sheet/bottom-sheet.component';
import { ProductThumbComponent } from '../../../shared/components/product-thumb/product-thumb.component';
import { CanWriteDirective } from '../../../shared/directives/can-write.directive';

export type Channel = 'mercadolibre' | 'tiendanube';
/** Lo que hay que resolver, por problema; `matched` = la lista de lo que ya coincide. */
export type ConflictBucket = 'unpaired' | 'nosku' | 'dup' | 'matched';

export type ConflictItem =
  | { kind: 'row'; bucket: 'unpaired' | 'nosku'; channel: Channel; row: MlRow | TnRow; key: string }
  | { kind: 'dup'; bucket: 'dup'; channel: Channel; sku: string; items: (MlRow | TnRow)[]; key: string }
  | { kind: 'pair'; bucket: 'matched'; pair: { ml: MlRow; tn: TnRow; sku?: string }; key: string };

export const TILES: { key: Exclude<ConflictBucket, 'matched'>; label: string; title: string; tone: 'warn' | 'err' }[] = [
  { key: 'unpaired', label: 'Sin par', title: 'Sin par en el otro canal', tone: 'warn' },
  { key: 'nosku', label: 'Sin SKU', title: 'Sin SKU', tone: 'warn' },
  { key: 'dup', label: 'Duplicados', title: 'SKU duplicado', tone: 'err' },
];

/** De a cuántos se muestran los pares que coinciden (pueden ser cientos). */
const MATCHED_PAGE = 50;

const mlKey = (r: MlRow) => `ml:${r.itemId}:${r.variationId ?? ''}`;
const tnKey = (r: TnRow) => `tn:${r.productId}:${r.variantId}`;

/**
 * Vincular SKUs en el celular: tres números que filtran (Sin par / Sin SKU / Duplicados), la lista
 * separada por problema y "N pares coinciden" al final. Tocar algo abre una hoja con sus acciones,
 * que se resuelven con los mismos formularios de `ConflictsComponent` (por eso solo emite).
 * Recibe el análisis completo (pestaña `resumen`, sin paginar) y busca en el navegador.
 */
@Component({
  selector: 'zc-conflicts-phone',
  standalone: true,
  imports: [NgTemplateOutlet, BottomSheetComponent, ProductThumbComponent, CanWriteDirective],
  templateUrl: './conflicts-phone.component.html',
  styleUrl: './conflicts-phone.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConflictsPhoneComponent {
  readonly analysis = input.required<ConflictAnalysis>();

  readonly editSku = output<{ channel: Channel; row: MlRow | TnRow }>();
  readonly editBothSku = output<{ ml: MlRow; tn: TnRow }>();
  readonly linkFromMl = output<MlRow>();
  readonly linkFromTn = output<TnRow>();
  readonly bulkEditSku = output<{ channel: Channel; sku: string; items: MlRow[] | TnRow[] }>();

  readonly tiles = TILES;
  readonly filter = signal<ConflictBucket | null>(null);
  readonly search = signal('');
  readonly matchedShown = signal(MATCHED_PAGE);

  readonly mlLabel = mlLabel;
  readonly tnLabel = tnLabel;

  private readonly allItems = computed<ConflictItem[]>(() => {
    const a = this.analysis();
    const row = (bucket: 'unpaired' | 'nosku', channel: Channel, r: MlRow | TnRow): ConflictItem => ({
      kind: 'row', bucket, channel, row: r, key: channel === 'mercadolibre' ? mlKey(r as MlRow) : tnKey(r as TnRow),
    });
    return [
      ...a.onlyML.map((r) => row('unpaired', 'mercadolibre', r)),
      ...a.onlyTN.map((r) => row('unpaired', 'tiendanube', r)),
      ...a.noSkuML.map((r) => row('nosku', 'mercadolibre', r)),
      ...a.noSkuTN.map((r) => row('nosku', 'tiendanube', r)),
      ...a.duplicateSkuML.map((d): ConflictItem => ({ kind: 'dup', bucket: 'dup', channel: 'mercadolibre', sku: d.sku, items: d.items, key: `dup:ml:${d.sku}` })),
      ...a.duplicateSkuTN.map((d): ConflictItem => ({ kind: 'dup', bucket: 'dup', channel: 'tiendanube', sku: d.sku, items: d.items, key: `dup:tn:${d.sku}` })),
      ...a.matched.map((p): ConflictItem => ({ kind: 'pair', bucket: 'matched', pair: p, key: `pair:${mlKey(p.ml)}:${tnKey(p.tn)}` })),
    ];
  });

  /** Lo que coincide con la búsqueda (sin el filtro de los números, que se cuentan sobre esto). */
  private readonly searched = computed(() => {
    const q = this.search().trim();
    return q ? this.allItems().filter((i) => matchSearchByTokens(q, this.searchText(i))) : this.allItems();
  });

  readonly counts = computed(() => {
    const c: Record<ConflictBucket, number> = { unpaired: 0, nosku: 0, dup: 0, matched: 0 };
    for (const i of this.searched()) c[i.bucket]++;
    return c;
  });

  readonly pending = computed(() => this.counts().unpaired + this.counts().nosku + this.counts().dup);

  readonly sections = computed(() => {
    const f = this.filter();
    if (f === 'matched') return [];
    return TILES.filter((t) => !f || t.key === f)
      .map((t) => ({ ...t, items: this.searched().filter((i) => i.bucket === t.key) }))
      .filter((s) => s.items.length);
  });

  readonly matched = computed(() => this.searched().filter((i) => i.bucket === 'matched'));

  toggle(b: ConflictBucket): void {
    this.filter.update((cur) => (cur === b ? null : b));
    this.matchedShown.set(MATCHED_PAGE);
  }

  showMore(): void {
    this.matchedShown.update((n) => n + MATCHED_PAGE);
  }

  /* ── Hoja ── */

  readonly open = signal<ConflictItem | null>(null);

  close(): void {
    this.open.set(null);
  }

  doEdit(i: ConflictItem): void {
    this.close();
    if (i.kind === 'row') this.editSku.emit({ channel: i.channel, row: i.row });
    else if (i.kind === 'pair') this.editBothSku.emit({ ml: i.pair.ml, tn: i.pair.tn });
    else this.bulkEditSku.emit({ channel: i.channel, sku: i.sku, items: i.items as MlRow[] | TnRow[] });
  }

  doLink(i: ConflictItem): void {
    if (i.kind !== 'row') return;
    this.close();
    if (i.channel === 'mercadolibre') this.linkFromMl.emit(i.row as MlRow);
    else this.linkFromTn.emit(i.row as TnRow);
  }

  /* ── Textos ── */

  label(channel: Channel, r: MlRow | TnRow): string {
    return channel === 'mercadolibre' ? mlLabel(r as MlRow) : tnLabel(r as TnRow);
  }

  short(channel: Channel): string {
    return channel === 'mercadolibre' ? 'ML' : 'TN';
  }

  title(i: ConflictItem): string {
    if (i.kind === 'row') return this.label(i.channel, i.row);
    if (i.kind === 'pair') return mlLabel(i.pair.ml);
    return `SKU ${i.sku} en ${i.items.length} ${i.channel === 'mercadolibre' ? 'publicaciones' : 'variantes'}`;
  }

  sku(i: ConflictItem): string | null {
    if (i.kind === 'row') return i.row.sku;
    if (i.kind === 'pair') return i.pair.sku || i.pair.ml.sku || i.pair.tn.sku;
    return i.sku;
  }

  thumb(i: ConflictItem): string | null {
    if (i.kind === 'row') return i.row.thumbnail ?? null;
    if (i.kind === 'pair') return i.pair.ml.thumbnail ?? i.pair.tn.thumbnail ?? null;
    return i.items[0]?.thumbnail ?? null;
  }

  subtitle(i: ConflictItem): string {
    if (i.kind === 'row') {
      const where = i.channel === 'mercadolibre' ? 'Mercado Libre' : 'Tienda Nube';
      return i.bucket === 'nosku' ? `Sin SKU en ${where}` : `Solo en ${where}${i.row.sku ? ' · SKU ' + i.row.sku : ''}`;
    }
    if (i.kind === 'pair') return `Coinciden · SKU ${this.sku(i) ?? '—'}`;
    return i.channel === 'mercadolibre' ? 'Repetido en Mercado Libre' : 'Repetido en Tienda Nube';
  }

  explain(i: ConflictItem): string {
    if (i.kind === 'row' && i.bucket === 'nosku') return 'Sin SKU no se puede emparejar con el otro canal. Asignale uno, o vinculalo directamente con su par.';
    if (i.kind === 'row') {
      const other = i.channel === 'mercadolibre' ? 'Tienda Nube' : 'Mercado Libre';
      return `No hay nada en ${other} con este SKU. Vinculalo con su par, o corregí el SKU si está mal escrito.`;
    }
    if (i.kind === 'dup') return 'Un SKU tiene que ser único en cada canal. Dale uno distinto a cada uno.';
    return 'Mismo SKU en los dos canales: el stock y los precios ya se sincronizan.';
  }

  private searchText(i: ConflictItem): string {
    if (i.kind === 'row') return [this.label(i.channel, i.row), i.row.sku].filter(Boolean).join(' ');
    if (i.kind === 'pair') return [mlLabel(i.pair.ml), tnLabel(i.pair.tn), this.sku(i)].filter(Boolean).join(' ');
    return [i.sku, ...i.items.map((r) => this.label(i.channel, r))].join(' ');
  }
}
