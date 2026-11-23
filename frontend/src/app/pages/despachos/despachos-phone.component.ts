import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { DispatchPackage } from '../../core/services/dispatch.service';
import { BottomSheetComponent } from '../../shared/components/bottom-sheet/bottom-sheet.component';
import { ProductThumbComponent } from '../../shared/components/product-thumb/product-thumb.component';
import type { ChannelFilter, DispatchSection, DispatchTab } from './despachos.component';
import * as fmt from './despachos.format';

/** Lo que filtran los números de arriba. "Atrasados" es Hoy mostrando solo la sección de atrasados. */
export type PhoneView = 'overdue' | 'today' | 'upcoming';

export interface PhoneCounts {
  overdue: number;
  today: number;
  upcoming: number;
  toPrepare: number;
  prepared: number;
}

/**
 * Para despachar en el celular: una fila por paquete (foto, comprador / producto, cuántos) con el
 * tilde Preparado a la derecha, y una hoja con el detalle (productos en grande, notas, link a la
 * venta, Marcar preparado). Todo el estado —pestaña, canal, tildes— vive en `DespachosComponent`:
 * acá solo se pinta y se avisa qué tocó la usuaria.
 */
@Component({
  selector: 'zc-despachos-phone',
  standalone: true,
  imports: [BottomSheetComponent, ProductThumbComponent],
  templateUrl: './despachos-phone.component.html',
  styleUrl: './despachos-phone.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DespachosPhoneComponent {
  readonly sections = input.required<DispatchSection[]>();
  /** Cancelados a mostrar arriba (vacío si no corresponde a la pestaña). */
  readonly cancelled = input<DispatchPackage[]>([]);
  readonly counts = input.required<PhoneCounts>();
  readonly tab = input.required<DispatchTab>();
  readonly channel = input.required<ChannelFilter>();
  readonly hidePrepared = input(false);
  readonly showDispatched = input(false);
  /** `YYYY-MM-DD` de hoy según el backend, y el reloj de la página (cuenta regresiva). */
  readonly today = input('');
  /**
   * Hay una búsqueda activa (vive en la página): las secciones ya vienen filtradas y de todas las
   * fechas, los números cuentan lo encontrado y ningún número queda marcado. Tocar uno borra la
   * búsqueda (`tabChange`, la página la limpia) y vuelve a la lista normal.
   */
  readonly searching = input(false);

  readonly tabChange = output<DispatchTab>();
  readonly channelChange = output<ChannelFilter>();
  readonly hidePreparedChange = output<boolean>();
  readonly showDispatchedChange = output<boolean>();
  readonly togglePrepared = output<DispatchPackage>();
  readonly dismissCancelled = output<DispatchPackage>();

  /** Atrasados es un filtro propio del celu adentro de Hoy. */
  readonly onlyOverdue = signal(false);

  readonly view = computed<PhoneView | null>(() =>
    this.searching() ? null : this.tab() === 'upcoming' ? 'upcoming' : this.onlyOverdue() ? 'overdue' : 'today');

  readonly visibleSections = computed(() =>
    this.view() === 'overdue' ? this.sections().filter((s) => s.key === 'overdue') : this.sections());

  /** Sin nada que mostrar. Buscando, el "no hay resultados" lo dice la página. */
  readonly empty = computed(() => !this.searching() && !this.visibleSections().some((s) => !s.collapsible) && !this.cancelled().length);

  /** Avance del día: cuántos de Hoy (atrasados incluidos) ya están tildados. */
  readonly progress = computed(() => {
    const c = this.counts();
    return { done: c.prepared, total: c.today, pct: c.today ? Math.round((c.prepared / c.today) * 100) : 0 };
  });

  pick(v: PhoneView): void {
    if (this.searching()) {
      this.onlyOverdue.set(v === 'overdue');
      this.tabChange.emit(v === 'upcoming' ? 'upcoming' : 'today');
      return;
    }
    if (v === 'upcoming') {
      this.onlyOverdue.set(false);
      this.tabChange.emit('upcoming');
      return;
    }
    // Tocar Atrasados de nuevo lo apaga (vuelve a todo Hoy).
    this.onlyOverdue.set(v === 'overdue' && this.view() !== 'overdue');
    if (this.tab() !== 'today') this.tabChange.emit('today');
  }

  isCollapsed(s: DispatchSection): boolean {
    return !!s.collapsible && !this.showDispatched();
  }

  /** A la derecha del título de sección: la cuenta regresiva si la hay; si no, cuántos paquetes. */
  sectionAside(s: DispatchSection): string {
    return s.hint?.startsWith('faltan') ? s.hint : String(s.packages.length);
  }

  /* ── Hoja de detalle ── */

  private readonly openKey = signal<string | null>(null);
  readonly openPackage = computed(() => {
    const k = this.openKey();
    if (!k) return null;
    for (const s of this.sections()) {
      const p = s.packages.find((x) => this.key(x) === k);
      if (p) return p;
    }
    return null;
  });

  open(p: DispatchPackage): void {
    this.openKey.set(this.key(p));
  }

  close(): void {
    this.openKey.set(null);
  }

  /** Desde la hoja: tilda (o destilda) y cierra, para seguir con el próximo paquete. */
  prepareFromSheet(p: DispatchPackage): void {
    this.togglePrepared.emit(p);
    this.close();
  }

  /* ── Textos ── */

  key(p: Pick<DispatchPackage, 'channel' | 'saleId'>): string {
    return `${p.channel}:${p.saleId}`;
  }

  /** Un producto: su nombre. Varios: quién compró y cuántos. */
  rowTitle(p: DispatchPackage): string {
    if (p.items.length === 1) return p.items[0].title;
    return `${fmt.buyerLabel(p) || fmt.saleLabel(p)} · ${fmt.units(p)} productos`;
  }

  /** Con un solo producto el comprador va en la segunda línea (en el título no entró). */
  rowWho(p: DispatchPackage): string {
    const who = p.items.length === 1 ? fmt.buyerLabel(p) : null;
    return [who, p.city].filter(Boolean).join(' · ');
  }

  /** Unidades de un paquete de un solo producto (la de varios ya lo dice el título). */
  singleQty(p: DispatchPackage): number {
    return p.items.length === 1 ? p.items[0].qty : 0;
  }

  /** Fotos de más, sobre la miniatura ("+2"). */
  extraItems(p: DispatchPackage): number {
    return p.items.length - 1;
  }

  firstPhoto(p: DispatchPackage): string | null {
    const it = p.items[0];
    return it ? (it.thumb || it.pictures[0] || null) : null;
  }

  overdue(p: DispatchPackage): string | null {
    const l = fmt.overdueLabel(p, this.today());
    return l && l.replace(/^Venció hoy /, 'venció ');
  }

  itemsText(p: DispatchPackage): string {
    return p.items.map((it) => `${it.title} ×${it.qty}`).join(', ');
  }

  readonly saleLabel = fmt.saleLabel;
  readonly buyerLabel = fmt.buyerLabel;
  readonly saleUrl = fmt.saleUrl;
  readonly shippingLabel = fmt.shippingLabel;
  readonly dateTime = fmt.dateTime;
  readonly units = fmt.units;

  purchased(p: DispatchPackage): string | null {
    return fmt.purchasedLabel(p, this.today());
  }

  /** "Despachar" en la hoja: el horario de ML, la fecha de Próximos días o el estado de TN. */
  when(p: DispatchPackage): string {
    if (p.bucket === 'dispatched') return p.state.label;
    if (p.bucket === 'overdue') return this.overdue(p) ?? 'Atrasado';
    if (p.bucket === 'upcoming') {
      const day = p.bufferedDay ?? p.deadlineDay;
      return day ? `el ${fmt.dayLabel(day)}` : 'fecha a confirmar';
    }
    if (p.deadline && p.deadlineHasTime) return `antes de las ${fmt.timeAr(p.deadline)}`;
    return p.channel === 'tn' ? 'sin horario límite' : 'hoy';
  }
}
