import { Component, computed, input, output, signal } from '@angular/core';
import { SupplierOrder } from '../../core/services/orders.service';
import {
  drawFactorySheet, factorySheetDate, factorySheetFilename, factorySheetHtml, factorySheetRows,
  factorySheetTotalPacks, factorySheetTsv,
} from './factory-sheet';

/**
 * "Vista para la fábrica": la hoja limpia (código · descripción · cantidad · detalle) para sacarle
 * captura, bajarla como imagen o copiarla como tabla. Siempre en fondo blanco.
 */
@Component({
  selector: 'app-factory-sheet-dialog',
  standalone: true,
  template: `
    <div class="backdrop" (click)="closed.emit()">
      <div class="card" (click)="$event.stopPropagation()" role="dialog" aria-modal="true" aria-label="Vista para la fábrica">
        <div class="head">
          <h2><i class="ti ti-file-text" aria-hidden="true"></i> Vista para la fábrica</h2>
          <span class="hint">Lista para sacarle captura — sin precios, alertas ni iconos.</span>
          <button type="button" class="icon-close" (click)="closed.emit()" aria-label="Cerrar"><i class="ti ti-x" aria-hidden="true"></i></button>
        </div>

        <div class="sheet">
          <div class="sheet-head">
            <div>
              <div class="sheet-title">{{ order().name }}</div>
              <div class="sheet-sub">Zona Cuaderno · {{ date() }}</div>
            </div>
            <div class="sheet-sub right">Pedido #{{ order().id }}<br />{{ rows().length }} productos · {{ totalPacks() }} packs</div>
          </div>
          <table>
            <thead><tr><th class="c-code">Código</th><th>Descripción</th><th class="c-qty">Cantidad</th><th>Detalle</th></tr></thead>
            <tbody>
              @for (r of rows(); track $index) {
                <tr><td class="c-code">{{ r.code }}</td><td>{{ r.description }}</td><td class="c-qty"><b>{{ r.qty }}</b></td><td>{{ r.detail }}</td></tr>
              }
            </tbody>
            <tfoot><tr><td></td><td class="right">Total</td><td class="c-qty"><b>{{ totalPacks() }}</b></td><td></td></tr></tfoot>
          </table>
          @if (order().note) { <p class="sheet-note"><b>Nota:</b> {{ order().note }}</p> }
        </div>

        <div class="actions">
          @if (feedback()) { <span class="feedback"><i class="ti ti-check" aria-hidden="true"></i> {{ feedback() }}</span> }
          <span class="spacer"></span>
          <button type="button" class="zc-btn small" (click)="copyTable()"><i class="ti ti-table" aria-hidden="true"></i> Copiar como tabla</button>
          <button type="button" class="zc-btn small primary" (click)="downloadImage()"><i class="ti ti-photo-down" aria-hidden="true"></i> Descargar imagen</button>
        </div>
      </div>
    </div>
  `,
  styles: `
    .backdrop { position: fixed; inset: 0; z-index: 100; display: flex; align-items: flex-start; justify-content: center;
      padding: 4vh 1rem; overflow-y: auto; background: color-mix(in srgb, var(--bg) 60%, transparent); backdrop-filter: blur(2px); }
    .card { width: 100%; max-width: 50rem; background: var(--surface); border: 0.5px solid var(--border-strong);
      border-radius: var(--radius-lg); box-shadow: var(--shadow-pop); padding: 1.1rem 1.25rem; }
    .head { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.8rem; flex-wrap: wrap;
      h2 { font-size: 0.95rem; font-weight: 600; margin: 0; display: flex; align-items: center; gap: 0.4rem; .ti { color: var(--brand); } } }
    .hint { font-size: 0.7rem; color: var(--text-3); }
    .icon-close { margin-left: auto; border: none; background: none; padding: 0.3rem; color: var(--text-3); }
    /* La hoja va SIEMPRE en blanco, sin tokens: es lo que se manda afuera, no parte de la app. */
    .sheet { background: #ffffff; color: #1a1c2e; border: 0.5px solid rgba(20, 22, 40, 0.14); border-radius: var(--radius-sm); padding: 1.4rem 1.5rem; overflow-x: auto; }
    .sheet-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 1rem; margin-bottom: 0.9rem; }
    .sheet-title { font-size: 1.05rem; font-weight: 600; }
    .sheet-sub { font-size: 0.72rem; color: #5d6373; margin-top: 0.15rem; line-height: 1.5; }
    .right { text-align: right; }
    table { width: 100%; border-collapse: collapse; min-width: 34rem; }
    th { font-size: 0.64rem; text-transform: uppercase; letter-spacing: 0.03em; font-weight: 600; color: #5d6373;
      background: #eef0f3; border: 1px solid #c8ccd4; padding: 0.45rem 0.6rem; text-align: left; }
    td { font-size: 0.82rem; color: #1a1c2e; border: 1px solid #c8ccd4; padding: 0.5rem 0.6rem; vertical-align: top; }
    tfoot td { border: none; color: #5d6373; font-size: 0.76rem; }
    .c-code { width: 8rem; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .c-qty { width: 5rem; text-align: center; }
    .sheet-note { font-size: 0.78rem; margin: 0.7rem 0 0; }
    .actions { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.9rem; }
    .spacer { flex: 1; }
    .feedback { font-size: 0.74rem; color: var(--ok); display: inline-flex; align-items: center; gap: 0.25rem; }
  `,
})
export class FactorySheetDialogComponent {
  readonly order = input.required<SupplierOrder>();
  readonly closed = output<void>();

  readonly rows = computed(() => factorySheetRows(this.order()));
  readonly date = computed(() => factorySheetDate(this.order()));
  readonly totalPacks = computed(() => factorySheetTotalPacks(this.order()));
  readonly feedback = signal<string | null>(null);

  /** HTML (para mail) + TSV (para Excel/Sheets) en el mismo portapapeles; si no se puede, solo el TSV. */
  async copyTable(): Promise<void> {
    const order = this.order();
    try {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([factorySheetHtml(order)], { type: 'text/html' }),
          'text/plain': new Blob([factorySheetTsv(order)], { type: 'text/plain' }),
        })]);
      } else {
        await navigator.clipboard.writeText(factorySheetTsv(order));
      }
      this.feedback.set('Tabla copiada — pegala en un mail o en Excel');
    } catch {
      this.feedback.set(null);
    }
  }

  downloadImage(): void {
    const order = this.order();
    drawFactorySheet(order).toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = factorySheetFilename(order);
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.feedback.set('Imagen descargada');
    }, 'image/png');
  }
}
