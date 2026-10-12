import { Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { HubProductsService, HubVariantRow, LinkCandidate } from '../../../core/services/hub-products.service';
import { SearchBarComponent } from '../../../shared/components/search-bar/search-bar.component';
import { ProductThumbComponent } from '../../../shared/components/product-thumb/product-thumb.component';

/**
 * "Vincular": a una variante que está en un solo canal le busca su par en el otro (entre las que
 * tampoco tienen par) y les pone el mismo SKU a las dos. El mapeo ES el SKU: no se guarda nada aparte.
 */
@Component({
  selector: 'zc-link-variant-dialog',
  standalone: true,
  imports: [FormsModule, SearchBarComponent, ProductThumbComponent],
  styleUrl: './link-variant-dialog.component.scss',
  template: `
    <div class="lk-backdrop" (click)="closed.emit()">
      <div class="lk-card" (click)="$event.stopPropagation()" role="dialog" aria-modal="true" aria-labelledby="lk-title">
        <header>
          <h2 id="lk-title">Vincular "{{ ownLabel() }}" con {{ otherChannel() === 'tn' ? 'Tienda Nube' : 'Mercado Libre' }}</h2>
          <p>Elegí la variante que corresponde. Te mostramos las que todavía no tienen par.</p>
        </header>

        <zc-search-bar [value]="search()" (valueChange)="onSearch($event)" placeholder="Buscar por nombre o SKU…" />

        <div class="lk-list" role="listbox" aria-label="Variantes sin par">
          @if (loading()) {
            <p class="lk-msg">Buscando…</p>
          } @else if (candidates().length === 0) {
            <p class="lk-msg">No hay variantes sin par{{ search() ? ' que coincidan' : '' }} en {{ otherChannel() === 'tn' ? 'Tienda Nube' : 'Mercado Libre' }}.</p>
          } @else {
            @for (c of candidates(); track candidateId(c)) {
              <button type="button" class="lk-opt" role="option" [class.on]="selectedId() === candidateId(c)"
                      [attr.aria-selected]="selectedId() === candidateId(c)" (click)="select(c)">
                <span class="lk-radio" aria-hidden="true"></span>
                <zc-product-thumb [src]="c.thumbnail" />
                <span class="lk-opt-main">
                  <span class="lk-opt-name">{{ c.name }}@if (c.variant) { · {{ c.variant }} }</span>
                  <span class="lk-opt-sub">
                    @if (c.sku) { <code>{{ c.sku }}</code> } @else { <span class="lk-nosku">Sin SKU</span> }
                    <span>{{ c.stock }} u.</span>
                  </span>
                </span>
              </button>
            }
          }
        </div>

        @if (selected()) {
          <label class="lk-sku">
            <span>SKU para las dos</span>
            <input class="zc-input" [ngModel]="sku()" (ngModelChange)="sku.set($event)" placeholder="Ej. LED-A4-CUA" />
          </label>
          <p class="lk-result">
            Al confirmar, las dos variantes quedan con el SKU <code>{{ sku().trim() || '…' }}</code>.
            Desde ahí una venta en un canal descuenta el stock del otro.
          </p>
        }

        @if (error()) { <p class="lk-error" role="alert">{{ error() }}</p> }

        <footer>
          <button type="button" class="zc-btn" (click)="closed.emit()">Cancelar</button>
          <button type="button" class="zc-btn primary" [disabled]="!canConfirm()" (click)="confirm()">
            <i class="ti ti-link" aria-hidden="true"></i> {{ saving() ? 'Vinculando…' : 'Vincular' }}
          </button>
        </footer>
      </div>
    </div>
  `,
})
export class LinkVariantDialogComponent {
  private readonly hub = inject(HubProductsService);

  /** La variante que está sola: tiene `ml` o `tn`, no las dos. */
  readonly row = input.required<HubVariantRow>();
  readonly linked = output<{ sku: string; pendingMl: boolean }>();
  readonly closed = output<void>();

  readonly search = signal('');
  readonly candidates = signal<LinkCandidate[]>([]);
  readonly loading = signal(false);
  readonly selected = signal<LinkCandidate | null>(null);
  readonly sku = signal('');
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  readonly otherChannel = computed<'ml' | 'tn'>(() => (this.row().ml ? 'tn' : 'ml'));
  readonly ownLabel = computed(() => {
    const r = this.row();
    if (r.ml) return r.ml.variationName ? `${r.ml.title} · ${r.ml.variationName}` : r.ml.title;
    // Sin valores de variante, el snapshot de TN pone el SKU como nombre: ahí va el del producto.
    const t = r.tn!;
    return t.variantName && t.variantName !== t.sku ? `${t.productName} · ${t.variantName}` : t.productName;
  });
  readonly selectedId = computed(() => (this.selected() ? this.candidateId(this.selected()!) : null));
  readonly canConfirm = computed(() => !!this.selected() && !!this.sku().trim() && !this.saving());

  private searchTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    effect(() => {
      this.otherChannel();
      void this.load('');
    }, { allowSignalWrites: true });
  }

  candidateId(c: LinkCandidate): string {
    return c.channel === 'ml' ? `${c.itemId}/${c.variationId ?? ''}` : `${c.productId}/${c.variantId}`;
  }

  onSearch(v: string): void {
    this.search.set(v);
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => void this.load(v.trim()), 250);
  }

  private async load(q: string): Promise<void> {
    this.loading.set(true);
    try {
      this.candidates.set(await this.hub.linkCandidates(this.otherChannel(), q));
    } catch {
      this.candidates.set([]);
      this.error.set('No pudimos traer las variantes. Probá de nuevo.');
    } finally {
      this.loading.set(false);
    }
  }

  select(c: LinkCandidate): void {
    this.selected.set(c);
    this.error.set(null);
    // El SKU por defecto es el que ya tenga alguna de las dos puntas (prioridad: la variante de ML).
    const r = this.row();
    const mlSku = r.ml ? r.ml.sku : c.sku;
    const tnSku = r.tn ? r.tn.sku : c.sku;
    this.sku.set(mlSku || tnSku || '');
  }

  async confirm(): Promise<void> {
    const c = this.selected();
    if (!c || !this.canConfirm()) return;
    const r = this.row();
    const ml = r.ml ? { itemId: r.ml.itemId, variationId: r.ml.variationId } : { itemId: c.itemId!, variationId: c.variationId ?? null };
    const tn = r.tn ? { productId: r.tn.productId, variantId: r.tn.variantId } : { productId: c.productId!, variantId: c.variantId! };
    this.saving.set(true);
    this.error.set(null);
    try {
      const res = await this.hub.link({ sku: this.sku().trim(), ml, tn });
      this.linked.emit({ sku: res.sku, pendingMl: res.pendingMl });
    } catch (e) {
      const msg = e instanceof HttpErrorResponse ? e.error?.error : null;
      this.error.set(msg || 'No se pudo vincular. Probá de nuevo.');
    } finally {
      this.saving.set(false);
    }
  }
}
