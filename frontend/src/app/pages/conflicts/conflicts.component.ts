import { Component, OnInit, ChangeDetectorRef, inject, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  ConflictsService,
  CONFLICTS_ANALYSIS_QUERY_KEY,
  ConflictAnalysis,
  MlRow,
  TnRow,
  mlLabel,
  tnLabel,
  matchSearchByTokens
} from '../../core/services/conflicts.service';
import { injectQuery } from '@tanstack/angular-query-experimental';
import {
  ResumenTabComponent,
  CoincidenciasTabComponent,
  SoloMlTabComponent,
  SoloTnTabComponent,
  SinSkuTabComponent,
  DuplicadosTabComponent
} from './tabs';
import { CurrencyInputDirective } from '../../directives/currency-input.directive';
import { from, timer, concatMap } from 'rxjs';

export type Tab = 'resumen' | 'coincidencias' | 'solo-ml' | 'solo-tn' | 'sin-sku' | 'duplicados';

@Component({
  selector: 'app-conflicts',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    CurrencyInputDirective,
    ResumenTabComponent,
    CoincidenciasTabComponent,
    SoloMlTabComponent,
    SoloTnTabComponent,
    SinSkuTabComponent,
    DuplicadosTabComponent
  ],
  templateUrl: './conflicts.component.html',
  styleUrl: './conflicts.component.scss'
})
export class ConflictsComponent implements OnInit {
  analysis: ConflictAnalysis | null = null;
  loading = true;
  /** true cuando hay refetch en segundo plano (ej. tras editar SKU) */
  fetching = false;
  error: string | null = null;
  tab: Tab = 'resumen';
  searchQuery = '';

  showLinkModal = false;
  linkMl: MlRow | null = null;
  linkTn: TnRow | null = null;
  linkSku = '';
  linkPriceML: number | null = 0;
  linkPriceTN: number | null = 0;
  savingLink = false;
  linkSearchQuery = '';
  /** Error al guardar el vínculo (se muestra dentro del modal). */
  linkError: string | null = null;

  showEditSkuModal = false;
  editSkuTarget: { channel: 'mercadolibre' | 'tiendanube'; row: MlRow | TnRow } | null = null;
  editSkuValue = '';
  savingSku = false;

  showEditBothSkuModal = false;
  editBothPair: { ml: MlRow; tn: TnRow } | null = null;
  editBothSkuML = '';
  editBothSkuTN = '';
  savingEditBoth = false;

  showBulkEditSkuModal = false;
  bulkEditChannel: 'mercadolibre' | 'tiendanube' | null = null;
  bulkEditSku = '';
  bulkEditItems: (MlRow | TnRow)[] = [];
  bulkEditNewSkus: string[] = [];
  savingBulkSku = false;
  bulkEditError: string | null = null;

  protected mlLabel = mlLabel;
  protected tnLabel = tnLabel;

  private readonly conflicts = inject(ConflictsService);
  private readonly cdr = inject(ChangeDetectorRef);

  readonly analysisQuery = injectQuery(() => ({
    queryKey: CONFLICTS_ANALYSIS_QUERY_KEY,
    queryFn: () => this.conflicts.getAnalysisPromise(),
    refetchOnWindowFocus: false,
    /** No refetch al entrar si los datos son recientes. Tras 1 h se consideran viejos y puede refetchear al volver. */
    staleTime: 60 * 60 * 1000
  }));

  constructor() {
    effect(() => {
      this.analysis = this.analysisQuery.data() ?? null;
      this.loading = this.analysisQuery.isLoading();
      this.fetching = this.analysisQuery.isFetching();
      const err = this.analysisQuery.error();
      this.error = this.analysisQuery.isError() && err
        ? (err as { error?: { error?: string }; message?: string })?.error?.error ?? (err as Error)?.message ?? null
        : null;
      this.cdr.markForCheck();
    });
  }

  ngOnInit() {}

  refreshAnalysis(): void {
    this.conflicts.invalidateAnalysis();
  }

  openLinkFromMl(ml: MlRow) {
    this.linkMl = ml;
    this.linkTn = null;
    this.linkSku = ml.sku || '';
    this.linkPriceML = 0;
    this.linkPriceTN = 0;
    this.linkSearchQuery = '';
    this.linkError = null;
    this.showLinkModal = true;
  }

  openLinkFromTn(tn: TnRow) {
    this.linkTn = tn;
    this.linkMl = null;
    this.linkSku = tn.sku || '';
    this.linkPriceML = 0;
    this.linkPriceTN = 0;
    this.linkSearchQuery = '';
    this.linkError = null;
    this.showLinkModal = true;
  }

  chooseTnForLink(tn: TnRow) {
    this.linkTn = tn;
    this.linkSku = (tn.sku && tn.sku.trim()) ? tn.sku.trim() : (this.linkMl?.sku?.trim() || '');
    this.cdr.detectChanges();
  }

  chooseMlForLink(ml: MlRow) {
    this.linkMl = ml;
    this.linkSku = (ml.sku && ml.sku.trim()) ? ml.sku.trim() : (this.linkTn?.sku?.trim() || '');
    this.cdr.detectChanges();
  }

  saveLink() {
    if (!this.linkMl || !this.linkTn || !this.linkSku.trim()) {
      this.linkError = 'Seleccioná una publicación de ML, una variante de TN y un SKU.';
      return;
    }
    this.savingLink = true;
    this.linkError = null;
    this.error = null;
    this.conflicts.linkManually({
      sku: this.linkSku.trim(),
      mercadolibre: {
        itemId: this.linkMl.itemId,
        variationId: this.linkMl.variationId || undefined
      },
      tiendanube: { productId: this.linkTn.productId, variantId: this.linkTn.variantId },
      priceML: this.linkPriceML ?? 0,
      priceTN: this.linkPriceTN ?? 0
    }).subscribe({
      next: (res) => {
        this.savingLink = false;
        const p = res?.persisted;
        if (p && (p.ml === false || p.tn === false)) {
          const parts = [];
          if (p.ml === false) parts.push('Mercado Libre');
          if (p.tn === false) parts.push('Tienda Nube');
          this.linkError = `No se pudo actualizar el SKU en: ${parts.join(' y ')}. Revisá que la publicación esté activa.`;
          this.error = this.linkError;
          return;
        }
        this.linkError = null;
        this.showLinkModal = false;
        this.conflicts.invalidateAnalysis();
      },
      error: e => {
        const msg = e.error?.error || e.error?.message || e.message;
        this.linkError = msg || 'No se pudo vincular. Revisá que la publicación de ML esté activa.';
        this.error = this.linkError;
        this.savingLink = false;
      }
    });
  }

  closeLinkModal() {
    this.showLinkModal = false;
    this.linkMl = null;
    this.linkTn = null;
    this.linkSearchQuery = '';
    this.linkError = null;
  }

  openEditSku(channel: 'mercadolibre' | 'tiendanube', row: MlRow | TnRow) {
    this.editSkuTarget = { channel, row };
    this.editSkuValue = row.sku || '';
    this.showEditSkuModal = true;
  }

  onEditSku(event: { channel: 'mercadolibre' | 'tiendanube'; row: MlRow | TnRow }) {
    this.openEditSku(event.channel, event.row);
  }

  openEditBothSkuModal(pair: { ml: MlRow; tn: TnRow }) {
    this.editBothPair = pair;
    this.editBothSkuML = pair.ml.sku || '';
    this.editBothSkuTN = pair.tn.sku || '';
    this.showEditBothSkuModal = true;
  }

  closeEditBothSkuModal() {
    this.showEditBothSkuModal = false;
    this.editBothPair = null;
  }

  saveEditBothSku() {
    if (!this.editBothPair) return;
    const hasML = this.editBothSkuML.trim().length > 0;
    const hasTN = this.editBothSkuTN.trim().length > 0;
    if (!hasML && !hasTN) return;
    this.savingEditBoth = true;
    this.error = null;
    const { ml, tn } = this.editBothPair;
    const doSave = () => {
      const mlPayload = hasML
        ? this.conflicts.updateSku('mercadolibre', this.editBothSkuML.trim(), {
            itemId: ml.itemId,
            variationId: ml.variationId ?? undefined
          })
        : null;
      const tnPayload = hasTN
        ? this.conflicts.updateSku('tiendanube', this.editBothSkuTN.trim(), {
            productId: tn.productId,
            variantId: tn.variantId
          })
        : null;
      if (mlPayload && tnPayload) {
        mlPayload.subscribe({
            next: () => {
                tnPayload!.subscribe({
                  next: () => {
                    this.savingEditBoth = false;
                    this.closeEditBothSkuModal();
                    this.conflicts.invalidateAnalysis();
                  },
              error: e => {
                this.error = e.error?.error || e.message;
                this.savingEditBoth = false;
              }
            });
          },
          error: e => {
            this.error = e.error?.error || e.message;
            this.savingEditBoth = false;
          }
        });
      } else if (mlPayload) {
        mlPayload.subscribe({
          next: () => {
            this.savingEditBoth = false;
            this.closeEditBothSkuModal();
            this.conflicts.invalidateAnalysis();
          },
          error: e => {
            this.error = e.error?.error || e.message;
            this.savingEditBoth = false;
          }
        });
      } else if (tnPayload) {
        tnPayload.subscribe({
          next: () => {
            this.savingEditBoth = false;
            this.closeEditBothSkuModal();
            this.conflicts.invalidateAnalysis();
          },
          error: e => {
            this.error = e.error?.error || e.message;
            this.savingEditBoth = false;
          }
        });
      }
    };
    doSave();
  }

  saveEditSku() {
    if (!this.editSkuTarget || !this.editSkuValue.trim()) return;
    const { channel, row } = this.editSkuTarget;
    const payload = channel === 'mercadolibre'
      ? { itemId: (row as MlRow).itemId, variationId: (row as MlRow).variationId ?? undefined }
      : { productId: (row as TnRow).productId, variantId: (row as TnRow).variantId };
    this.savingSku = true;
    this.error = null;
    this.conflicts.updateSku(channel, this.editSkuValue.trim(), payload).subscribe({
      next: () => {
        this.savingSku = false;
        this.showEditSkuModal = false;
        this.conflicts.invalidateAnalysis();
      },
      error: e => {
        this.error = e.error?.error || e.message;
        this.savingSku = false;
      }
    });
  }

  closeEditSkuModal() {
    this.showEditSkuModal = false;
    this.editSkuTarget = null;
  }

  onBulkEditSku(event: { channel: 'mercadolibre' | 'tiendanube'; sku: string; items: MlRow[] | TnRow[] }) {
    this.bulkEditChannel = event.channel;
    this.bulkEditSku = event.sku;
    this.bulkEditItems = [...event.items];
    this.bulkEditNewSkus = event.items.map((_, i) => `${event.sku}-${i + 1}`);
    this.bulkEditError = null;
    this.showBulkEditSkuModal = true;
  }

  closeBulkEditSkuModal() {
    this.showBulkEditSkuModal = false;
    this.bulkEditChannel = null;
    this.bulkEditItems = [];
    this.bulkEditNewSkus = [];
    this.bulkEditError = null;
  }

  /**
   * Guardado en lote: secuencial + pausa. TN permite máx 2 req/s (doc oficial);
   * 1 req/s deja margen. Backend reintenta en 429 usando x-rate-limit-reset.
   */
  saveBulkEditSku() {
    if (!this.bulkEditChannel || this.bulkEditItems.length === 0) return;
    const toUpdate: { index: number; newSku: string; row: MlRow | TnRow }[] = [];
    this.bulkEditNewSkus.forEach((newSku, i) => {
      const trimmed = newSku.trim();
      if (trimmed && trimmed !== this.bulkEditSku) {
        toUpdate.push({ index: i, newSku: trimmed, row: this.bulkEditItems[i] });
      }
    });
    if (toUpdate.length === 0) {
      this.bulkEditError = 'Ingresá al menos un SKU distinto al actual para actualizar.';
      return;
    }
    this.savingBulkSku = true;
    this.bulkEditError = null;
    const channel = this.bulkEditChannel;
    const delayMs = 1000;
    from(toUpdate).pipe(
      concatMap(({ newSku, row }, index) => {
        const payload = channel === 'mercadolibre'
          ? { itemId: (row as MlRow).itemId, variationId: (row as MlRow).variationId ?? undefined }
          : { productId: (row as TnRow).productId, variantId: (row as TnRow).variantId };
        const request$ = this.conflicts.updateSku(channel, newSku, payload);
        return index === 0 ? request$ : timer(delayMs).pipe(concatMap(() => request$));
      })
    ).subscribe({
      next: () => {},
      error: e => {
        this.bulkEditError = e.error?.error || e.message || 'Error al actualizar uno de los ítems.';
        this.savingBulkSku = false;
      },
      complete: () => {
        this.savingBulkSku = false;
        this.closeBulkEditSkuModal();
        this.conflicts.invalidateAnalysis();
      }
    });
  }

  getBulkEditRowTrackId(row: MlRow | TnRow): string {
    if (this.bulkEditChannel === 'mercadolibre') {
      const r = row as MlRow;
      return String(r.itemId) + (r.variationId ?? '');
    }
    const r = row as TnRow;
    return String(r.productId) + String(r.variantId);
  }

  getBulkEditRowLabel(row: MlRow | TnRow): string {
    return this.bulkEditChannel === 'mercadolibre'
      ? mlLabel(row as MlRow)
      : tnLabel(row as TnRow);
  }

  getEditSkuLabel(): string {
    if (!this.editSkuTarget) return '';
    return this.editSkuTarget.channel === 'mercadolibre'
      ? mlLabel(this.editSkuTarget.row as MlRow)
      : tnLabel(this.editSkuTarget.row as TnRow);
  }

  private matchesLinkSearch(row: MlRow | TnRow, isMl: boolean): boolean {
    const title = isMl ? (row as MlRow).title : (row as TnRow).productName || '';
    const sku = row.sku || '';
    const variationName = isMl ? ((row as MlRow).variationName || '') : ((row as TnRow).variantName || '');
    const searchable = [title, sku, variationName].filter(Boolean).join(' ');
    return matchSearchByTokens(this.linkSearchQuery, searchable);
  }

  get filteredLinkTnOptions(): TnRow[] {
    if (!this.analysis) return [];
    const all = [...this.analysis.onlyTN, ...this.analysis.noSkuTN];
    if (!this.linkSearchQuery.trim()) return all;
    return all.filter(r => this.matchesLinkSearch(r, false));
  }

  get filteredLinkMlOptions(): MlRow[] {
    if (!this.analysis) return [];
    const all = [...this.analysis.onlyML, ...this.analysis.noSkuML];
    if (!this.linkSearchQuery.trim()) return all;
    return all.filter(r => this.matchesLinkSearch(r, true));
  }
}
