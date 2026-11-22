import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { UnwatchedProduct } from '../../../core/services/alerts.service';
import { SessionService } from '../../../core/services/session.service';
import { SearchBarComponent } from '../../../shared/components/search-bar/search-bar.component';
import { ProductThumbComponent } from '../../../shared/components/product-thumb/product-thumb.component';
import { PHONE_QUERY, mediaSignal } from '../../../shared/utils/media-signal';
import { ThresholdSheetComponent, ThresholdTarget } from '../threshold-sheet/threshold-sheet.component';

/**
 * Pestaña "Sin alertas": productos con el mismo SKU en ML y TN que todavía no se vigilan. Se tildan
 * varios y se les crea la misma alerta de una (`zc-threshold-sheet` con `items`: hoja en el celu,
 * diálogo en tablet y compu). En la compu cada fila tiene además su atajo para uno solo.
 */
@Component({
  selector: 'zc-alertas-sin-alerta',
  standalone: true,
  imports: [SearchBarComponent, ProductThumbComponent, ThresholdSheetComponent],
  templateUrl: './alertas-sin-alerta.component.html',
  styleUrl: './alertas-sin-alerta.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlertasSinAlertaComponent {
  readonly session = inject(SessionService);

  readonly products = input.required<UnwatchedProduct[]>();
  readonly loading = input(false);

  readonly phone = mediaSignal(PHONE_QUERY);
  readonly search = signal('');

  readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    const rows = this.products();
    if (!q) return rows;
    return rows.filter((r) =>
      r.sku.toLowerCase().includes(q) ||
      (r.productLabel || '').toLowerCase().includes(q) ||
      (r.pack?.name || '').toLowerCase().includes(q));
  });

  /* ── Selección (por SKU: sobrevive a cambiar la búsqueda) ── */

  readonly selected = signal<Set<string>>(new Set());

  /** Solo los tildados que siguen en la lista (al crear la alerta salen solos). */
  readonly selectedProducts = computed(() => this.products().filter((p) => this.selected().has(p.sku)));
  readonly selectedCount = computed(() => this.selectedProducts().length);

  readonly allFilteredSelected = computed(() => {
    const rows = this.filtered();
    return rows.length > 0 && rows.every((p) => this.selected().has(p.sku));
  });
  readonly someFilteredSelected = computed(() => this.filtered().some((p) => this.selected().has(p.sku)));

  isSelected(p: UnwatchedProduct): boolean {
    return this.selected().has(p.sku);
  }

  toggle(p: UnwatchedProduct): void {
    if (this.session.isReadOnly()) return;
    this.selected.update((s) => {
      const next = new Set(s);
      next.has(p.sku) ? next.delete(p.sku) : next.add(p.sku);
      return next;
    });
  }

  /** Tilda (o destilda, si ya estaban todos) lo que se ve con la búsqueda actual. */
  toggleAllFiltered(): void {
    const rows = this.filtered();
    const all = this.allFilteredSelected();
    this.selected.update((s) => {
      const next = new Set(s);
      for (const p of rows) all ? next.delete(p.sku) : next.add(p.sku);
      return next;
    });
  }

  clearSelection(): void {
    this.selected.set(new Set());
  }

  /* ── Hoja / diálogo ── */

  readonly target = signal<ThresholdTarget | null>(null);
  /** El diálogo se abrió para la selección (al guardar se limpia) o para una fila suelta. */
  private targetIsSelection = false;

  configureSelected(): void {
    const items = this.selectedProducts().map(toItem);
    if (!items.length) return;
    this.targetIsSelection = true;
    this.target.set({ sku: '', label: '', stockMl: null, stockTn: null, threshold: null, items });
  }

  configureOne(p: UnwatchedProduct): void {
    this.targetIsSelection = false;
    this.target.set({ sku: '', label: '', stockMl: null, stockTn: null, threshold: null, items: [toItem(p)] });
  }

  onSaved(): void {
    if (this.targetIsSelection) this.clearSelection();
    else {
      // Una fila suelta que además estaba tildada: ya tiene alerta, sale de la selección.
      const sku = this.target()?.items?.[0]?.sku;
      if (sku) this.selected.update((s) => { const next = new Set(s); next.delete(sku); return next; });
    }
  }

  label(p: UnwatchedProduct): string {
    return p.productLabel ?? p.sku;
  }
}

function toItem(p: UnwatchedProduct): { sku: string; label: string; thumbnail: string | null } {
  return { sku: p.sku, label: p.productLabel ?? p.sku, thumbnail: p.thumbnail };
}
