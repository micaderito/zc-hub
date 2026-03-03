import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { QueryClient, injectQuery, injectMutation } from '@tanstack/angular-query-experimental';
import { SyncService, SyncConfig, SyncAuditRow, PendingReturnRow } from '../../core/services/sync.service';

const SYNC_RETURNS_QUERY_KEY = ['sync', 'returns'] as const;

@Component({
  selector: 'app-sync',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './sync.component.html',
  styleUrl: './sync.component.scss'
})
export class SyncComponent implements OnInit {
  private readonly sync = inject(SyncService);
  private readonly queryClient = inject(QueryClient);

  config: SyncConfig | null = null;
  loading = true;
  savingToggle = false;
  error: string | null = null;

  auditRows: SyncAuditRow[] = [];
  auditTotal = 0;
  auditLoading = true;
  auditError: string | null = null;
  /** Filtro por nº de venta (order_id). */
  auditOrderIdSearch = '';
  /** ID del registro que se está revirtiendo (para deshabilitar solo ese botón). */
  revertingAuditId: number | null = null;
  revertError: string | null = null;

  reprocessOrderId = '';
  reprocessingOrder = false;
  reprocessResult: string | null = null;

  /** Habilita la query de devoluciones cuando hay DB (se setea al cargar config). */
  hasDatabaseForReturns = false;

  returnOrderId = '';
  addingReturn = false;
  fetchResult: string | null = null;
  approvingId: number | null = null;

  registeringWebhooks = false;
  webhooksResult: string | null = null;

  readonly returnsQuery = injectQuery(() => ({
    queryKey: SYNC_RETURNS_QUERY_KEY,
    queryFn: () => firstValueFrom(this.sync.getReturns()),
    enabled: this.hasDatabaseForReturns,
    refetchOnWindowFocus: false,
    staleTime: 2 * 60 * 1000,
    gcTime: 5 * 60 * 1000
  }));

  readonly fetchReturnsMutation = injectMutation(() => ({
    mutationKey: ['sync', 'fetchReturns'],
    mutationFn: () => firstValueFrom(this.sync.fetchReturnsFromMl()),
    onSuccess: () => {
      this.queryClient.invalidateQueries({ queryKey: SYNC_RETURNS_QUERY_KEY });
    }
  }));

  constructor() {}

  ngOnInit(): void {
    this.loadConfig();
    this.loadAudit();
  }

  loadConfig(): void {
    this.loading = true;
    this.error = null;
    this.sync.getConfig().subscribe({
      next: (c) => {
        this.config = c;
        this.loading = false;
        if (c?.hasDatabase) {
          this.hasDatabaseForReturns = true;
          this.fetchReturnsMutation.mutate(undefined, {
            onSettled: () => {
              const r = this.fetchReturnsMutation.data();
              if (r && (r.created > 0 || r.skipped > 0))
                this.fetchResult = `Se revisaron ${r.claimsChecked} reclamos. Se agregaron ${r.created} ítems${r.skipped > 0 ? ` (${r.skipped} ya estaban)` : ''}.`;
            }
          });
        }
      },
      error: (e) => {
        this.error = e.error?.error || e.message || 'Error al cargar.';
        this.loading = false;
      }
    });
  }

  loadAudit(): void {
    this.auditLoading = true;
    this.auditError = null;
    this.revertError = null;
    const orderId = this.auditOrderIdSearch.trim() || undefined;
    this.sync.getAudit(100, 0, orderId).subscribe({
      next: (r) => {
        this.auditRows = r.rows;
        this.auditTotal = r.total;
        this.auditLoading = false;
      },
      error: (e) => {
        this.auditError = e.error?.error || e.message || 'Error al cargar historial.';
        this.auditLoading = false;
      }
    });
  }

  /** Actualizar la lista del historial de sincronización. */
  refreshAudit(): void {
    this.loadAudit();
  }

  /** Buscar en el historial por nº de venta (vuelve a cargar con el filtro). */
  searchAuditByOrderId(): void {
    this.loadAudit();
  }

  /** Limpiar el filtro de búsqueda y cargar el listado completo. */
  clearAuditSearch(): void {
    this.auditOrderIdSearch = '';
    this.loadAudit();
  }

  /** Reintentar sincronización de una venta ML que no se registró (sync estaba off o ítem sin SKU). */
  reprocessOrder(): void {
    const id = this.reprocessOrderId.trim();
    if (!id) return;
    this.reprocessResult = null;
    this.reprocessingOrder = true;
    this.sync.reprocessOrder(id).subscribe({
      next: (r) => {
        this.reprocessingOrder = false;
        this.reprocessResult = r.ok ? `Orden ${r.orderId} sincronizada: ${r.itemsSynced} ítem(s) descontados.` : null;
        if (r.ok) {
          this.reprocessOrderId = '';
          this.loadAudit();
        }
      },
      error: (e) => {
        this.reprocessingOrder = false;
        this.reprocessResult = e.error?.error || e.message || 'Error al reintentar.';
      }
    });
  }

  revertAudit(row: SyncAuditRow): void {
    if (row.revertedAt) return;
    this.revertError = null;
    this.revertingAuditId = row.id;
    this.sync.revertAudit(row.id).subscribe({
      next: () => {
        this.revertingAuditId = null;
        this.loadAudit();
      },
      error: (e) => {
        this.revertingAuditId = null;
        this.revertError = e.error?.error || e.message || 'No se pudo revertir.';
      }
    });
  }

  toggleSync(enabled: boolean): void {
    if (!this.config?.hasDatabase) return;
    this.savingToggle = true;
    this.error = null;
    this.sync.setSyncEnabled(enabled).subscribe({
      next: (r) => {
        if (this.config) this.config.enabled = r.enabled;
        this.savingToggle = false;
      },
      error: (e) => {
        this.error = e.error?.error || e.message || 'No se pudo actualizar.';
        this.savingToggle = false;
      }
    });
  }

  channelLabel(ch: string): string {
    return ch === 'mercadolibre' ? 'Mercado Libre' : 'Tienda Nube';
  }

  /** Clase CSS del chip de estado (colores por tipo de acción). */
  stateChipClass(label: string | null | undefined): string {
    if (!label) return 'state-chip n';
    const n = label.toLowerCase().replace(/\s+/g, '-');
    if (n.includes('venta-ml')) return 'state-chip vml';
    if (n.includes('venta-tn')) return 'state-chip vtn';
    if (n.includes('cancelación') || n.includes('cancelacion')) return 'state-chip can';
    if (n.includes('devolución') || n.includes('devolucion')) return 'state-chip dev';
    return 'state-chip n';
  }

  formatDate(iso: string): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('es-AR', {
      dateStyle: 'short',
      timeStyle: 'short'
    });
  }

  get returnsRows(): PendingReturnRow[] {
    return this.returnsQuery.data()?.rows ?? [];
  }

  get returnsLoading(): boolean {
    return this.returnsQuery.isLoading();
  }

  get returnsError(): string | null {
    if (!this.returnsQuery.isError() || !this.returnsQuery.error()) return null;
    const err = this.returnsQuery.error() as { error?: { error?: string }; message?: string };
    return err?.error?.error ?? err?.message ?? 'Error al cargar devoluciones.';
  }

  get fetchingReturns(): boolean {
    return this.fetchReturnsMutation.isPending();
  }

  /** Actualizar: traer de nuevo desde ML y refrescar la lista. */
  refreshReturns(): void {
    this.fetchResult = null;
    this.fetchReturnsMutation.mutate(undefined, {
      onSuccess: (r) => {
        this.fetchResult = r.created > 0 || r.skipped > 0
          ? `Se revisaron ${r.claimsChecked} reclamos. Se agregaron ${r.created} ítems${r.skipped > 0 ? ` (${r.skipped} ya estaban)` : ''}.`
          : r.claimsChecked === 0
            ? 'No hay reclamos recientes con devolución en ML.'
            : 'Lista actualizada.';
      },
      onError: (e) => {
        this.fetchResult = (e as { error?: { error?: string }; message?: string })?.error?.error ?? (e as Error)?.message ?? 'Error al actualizar.';
      }
    });
  }

  addReturnsByOrder(): void {
    const orderId = this.returnOrderId.trim();
    if (!orderId) return;
    this.addingReturn = true;
    this.fetchResult = null;
    this.sync.addReturnsFromOrder(orderId).subscribe({
      next: (r) => {
        this.returnOrderId = '';
        this.addingReturn = false;
        this.queryClient.invalidateQueries({ queryKey: SYNC_RETURNS_QUERY_KEY });
        this.fetchResult = r.created > 0 ? `Se agregaron ${r.created} ítems de la orden.` : null;
      },
      error: (e) => {
        this.fetchResult = e.error?.error || e.message || 'Error al agregar devoluciones.';
        this.addingReturn = false;
      }
    });
  }

  registerWebhooks(): void {
    this.webhooksResult = null;
    this.registeringWebhooks = true;
    this.sync.registerWebhooks().subscribe({
      next: (r) => {
        this.registeringWebhooks = false;
        this.webhooksResult = r.registered > 0
          ? `Webhooks registrados: ${r.registered} (order/paid, order/created, order/fulfilled, order/cancelled).`
          : 'Ya estaban registrados con la URL actual.';
      },
      error: (e) => {
        this.webhooksResult = e.error?.error || e.message || 'Error al registrar webhooks.';
        this.registeringWebhooks = false;
      }
    });
  }

  approveReturn(row: PendingReturnRow): void {
    this.approvingId = row.id;
    this.sync.approveReturn(row.id).subscribe({
      next: () => {
        this.approvingId = null;
        this.queryClient.invalidateQueries({ queryKey: SYNC_RETURNS_QUERY_KEY });
        this.loadAudit();
      },
      error: (e) => {
        this.fetchResult = e.error?.error || e.message || 'Error al restaurar stock.';
        this.approvingId = null;
      }
    });
  }
}
