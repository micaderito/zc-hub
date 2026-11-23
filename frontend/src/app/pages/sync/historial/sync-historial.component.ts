import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuditSource, SyncAuditRow, SyncService } from '../../../core/services/sync.service';
import { SessionService } from '../../../core/services/session.service';
import { SearchBarComponent } from '../../../shared/components/search-bar/search-bar.component';
import { PaginationComponent } from '../../../shared/components/pagination/pagination.component';
import { ConfirmDialogComponent } from '../../../shared/components/confirm-dialog/confirm-dialog.component';
import { CanWriteDirective } from '../../../shared/directives/can-write.directive';
import { SyncStore } from '../sync.store';
import { auditSourceLabel, canRevertAudit, errorMessage, formatDate, revertTitle } from '../sync.utils';

/** Pestaña Historial: cada cambio de stock, con búsqueda, filtro por origen, revertir y reintentar una venta. */
@Component({
  selector: 'zc-sync-historial',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tab-panel' },
  imports: [CanWriteDirective, FormsModule, SearchBarComponent, PaginationComponent, ConfirmDialogComponent],
  templateUrl: './sync-historial.component.html',
  styleUrl: './sync-historial.component.scss'
})
export class SyncHistorialComponent {
  readonly session = inject(SessionService);
  readonly store = inject(SyncStore);
  private readonly sync = inject(SyncService);

  /** Opciones del filtro de origen, en el orden en que se muestran. */
  readonly auditSourceOptions: { key: AuditSource | ''; label: string }[] = [
    { key: '', label: 'Todos' },
    { key: 'venta', label: 'Ventas' },
    { key: 'manual', label: 'Manuales' },
    { key: 'cancelacion', label: 'Cancelaciones' },
    { key: 'devolucion', label: 'Devoluciones' },
    { key: 'externo', label: 'Externos' },
  ];

  readonly revertingAuditId = signal<number | null>(null);

  readonly reprocessOrderId = signal('');
  readonly reprocessingOrder = signal(false);
  readonly reprocessResult = signal<string | null>(null);
  /** Nro de venta pendiente de confirmación por reintentar (ya estaba en el historial). */
  readonly confirmReprocessId = signal<string | null>(null);

  readonly formatDate = formatDate;

  reprocessOrder(): void {
    const id = this.reprocessOrderId().trim();
    if (!id) return;
    this.reprocessResult.set(null);
    this.reprocessingOrder.set(true);
    this.sync.getAudit(50, 0, id).subscribe({
      next: (r) => {
        const alreadySynced = r.rows.some(row => !row.revertedAt && (row.orderId === id || row.packId === id));
        if (alreadySynced) {
          this.reprocessingOrder.set(false);
          this.confirmReprocessId.set(id);
          return;
        }
        this.submitReprocess(id);
      },
      error: () => this.submitReprocess(id)
    });
  }

  confirmReprocess(): void {
    const id = this.confirmReprocessId();
    if (!id) return;
    this.confirmReprocessId.set(null);
    this.reprocessingOrder.set(true);
    this.submitReprocess(id);
  }

  cancelReprocess(): void {
    this.confirmReprocessId.set(null);
  }

  private submitReprocess(id: string): void {
    this.sync.reprocessOrder(id).subscribe({
      next: (r) => {
        this.reprocessingOrder.set(false);
        this.reprocessResult.set(r.ok ? `Orden ${r.orderId} sincronizada: ${r.itemsSynced} ítem(s) descontados.` : null);
        if (r.ok) {
          this.reprocessOrderId.set('');
          this.store.loadAudit();
        }
      },
      error: (e) => {
        this.reprocessingOrder.set(false);
        this.reprocessResult.set(errorMessage(e, 'Error al reintentar.'));
      }
    });
  }

  revertAudit(row: SyncAuditRow): void {
    if (row.revertedAt) return;
    this.store.revertError.set(null);
    this.revertingAuditId.set(row.id);
    this.sync.revertAudit(row.id).subscribe({
      next: () => {
        this.revertingAuditId.set(null);
        this.store.loadAudit();
      },
      error: (e) => {
        this.revertingAuditId.set(null);
        this.store.revertError.set(errorMessage(e, 'No se pudo revertir.'));
      }
    });
  }

  readonly revertTitle = revertTitle;
  readonly canRevert = canRevertAudit;
  readonly auditSourceLabel = auditSourceLabel;

  stateChipClass(label: string | null | undefined): string {
    if (!label) return 'state-chip n';
    const n = label.toLowerCase().replace(/\s+/g, '-');
    if (n.includes('venta-ml')) return 'state-chip vml';
    if (n.includes('venta-tn')) return 'state-chip vtn';
    if (n.includes('cancelación') || n.includes('cancelacion')) return 'state-chip can';
    if (n.includes('devolución') || n.includes('devolucion')) return 'state-chip dev';
    return 'state-chip n';
  }
}
