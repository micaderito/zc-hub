import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { DiscountProfile, ImportPreview, ImportResult, MappingSuggestion, PricingService } from '../../../core/services/pricing.service';
import { PdfTextService } from '../../../core/services/pdf-text.service';
import { PreciosStore } from '../precios.store';
import { apiError, defaultProfile, discountPcts } from '../precios.utils';

/**
 * Importar una lista del proveedor: leer el PDF/CSV en el navegador, elegir proveedor y config de
 * descuento, confirmar los mapeos dudosos e importar. Después muestra el resumen (qué tomó precio
 * de esta lista, qué es de otra, qué quedó sin código) sin cerrarse.
 */
@Component({
  selector: 'zc-import-list-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, NgTemplateOutlet],
  templateUrl: './import-list-dialog.component.html',
  styleUrl: './import-list-dialog.component.scss',
})
export class ImportListDialogComponent implements OnInit {
  protected readonly store = inject(PreciosStore);
  private readonly pricing = inject(PricingService);
  private readonly pdfText = inject(PdfTextService);

  readonly discountPcts = discountPcts;
  readonly importing = signal(false);
  readonly saving = signal(false);
  readonly errorMsg = signal<string | null>(null);
  readonly importPreview = signal<ImportPreview | null>(null);
  readonly importResult = signal<ImportResult | null>(null);
  readonly importFileName = signal<string | null>(null);
  readonly importFormat = signal<'pdf' | 'csv'>('pdf');
  readonly importLabel = signal('');
  /** Proveedor de la lista y config de descuento para lo que no tiene una propia (null = la default). */
  readonly importSupplier = signal('');
  readonly importProfileId = signal<number | null>(null);
  /** Confirmaciones de mapeo que hizo el usuario en este import: sku → código. */
  readonly mappingChoices = signal<Record<string, string>>({});
  /** Texto del último archivo leído: cambiar de proveedor rehace el preview con sus códigos. */
  private importText: string | null = null;

  readonly importProfiles = computed<DiscountProfile[]>(
    () => this.store.suppliers().find((s) => s.key === this.importSupplier())?.profiles ?? [],
  );
  readonly pendingMappings = computed<MappingSuggestion[]>(() => this.importPreview()?.mapping.review ?? []);
  readonly confirmedCount = computed(() => Object.keys(this.mappingChoices()).length);

  ngOnInit(): void {
    this.reset();
  }

  /** Vuelve al paso de elegir archivo (también "Importar otra lista"). */
  reset(): void {
    this.importPreview.set(null);
    this.importResult.set(null);
    this.importFileName.set(null);
    this.importLabel.set('');
    this.mappingChoices.set({});
    this.errorMsg.set(null);
    this.importText = null;
    const sup = this.store.currentSupplier() ?? this.store.suppliers()[0] ?? null;
    this.importSupplier.set(sup?.key ?? '');
    this.importProfileId.set(defaultProfile(sup)?.id ?? null);
  }

  /** Lee el archivo (PDF o CSV), extrae el texto y pide el preview al backend. */
  async onFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.importing.set(true);
    this.errorMsg.set(null);
    try {
      const { text, format } = await this.pdfText.extract(file);
      this.importFormat.set(format);
      this.importResult.set(null);
      this.mappingChoices.set({});
      this.importFileName.set(file.name);
      if (!this.importLabel()) this.importLabel.set(file.name.replace(/\.(pdf|csv|txt)$/i, ''));
      this.importText = text;
      this.importPreview.set(await firstValueFrom(this.pricing.previewImport(text, format, this.importSupplier() || undefined)));
    } catch (e) {
      this.errorMsg.set(`No se pudo leer el archivo: ${(e as Error)?.message ?? e}`);
      this.importPreview.set(null);
    } finally {
      this.importing.set(false);
      input.value = ''; // permite volver a elegir el mismo archivo
    }
  }

  /** Cambiar el proveedor del import: precarga su default y rehace el preview con sus códigos. */
  async setImportSupplier(key: string): Promise<void> {
    this.importSupplier.set(key);
    this.importProfileId.set(defaultProfile(this.store.suppliers().find((s) => s.key === key))?.id ?? null);
    if (!this.importText) return;
    this.importing.set(true);
    try {
      this.importPreview.set(await firstValueFrom(this.pricing.previewImport(this.importText, this.importFormat(), key)));
    } catch (e) {
      this.errorMsg.set(apiError(e, 'No se pudo leer la lista'));
    } finally {
      this.importing.set(false);
    }
  }

  /** Confirma (o descarta) la sugerencia de mapeo de un SKU dentro del import. */
  chooseMapping(sku: string, code: string | null): void {
    this.mappingChoices.update((m) => {
      const next = { ...m };
      if (code) next[sku] = code; else delete next[sku];
      return next;
    });
  }

  /** Guarda la lista, los mapeos confirmados a mano y actualiza los costos. */
  async confirmImport(): Promise<void> {
    const preview = this.importPreview();
    if (!preview || !this.importLabel().trim()) {
      this.errorMsg.set('Falta el nombre de la lista');
      return;
    }
    this.saving.set(true);
    this.errorMsg.set(null);
    try {
      const supplierKey = this.importSupplier();
      // Primero los mapeos que confirmaste: así el import ya los usa para volcar los costos.
      // Un pack confirmado va a pack_code_map (y de ahí el costo se vuelca a TODOS sus miembros).
      for (const m of this.pendingMappings()) {
        const code = this.mappingChoices()[m.sku];
        if (!code) continue;
        if (m.isPack && m.packId != null) await firstValueFrom(this.pricing.confirmPackMapping(m.packId, code, 'manual', supplierKey));
        else await firstValueFrom(this.pricing.confirmMapping(m.sku, code, 'manual', supplierKey));
      }

      const res = await firstValueFrom(this.pricing.confirmImport({
        label: this.importLabel().trim(),
        sourceFilename: this.importFileName(),
        supplierKey,
        profileId: this.importProfileId(),
        rows: preview.rows,
      }));

      const sinCodigo = res.summary?.unmatched.length ?? 0;
      this.store.notice.set(
        `Lista "${this.importLabel().trim()}": ${res.autoMapped} producto${res.autoMapped === 1 ? '' : 's'} con precio de esta lista`
        + ` · ${res.costsUpdated} costo${res.costsUpdated === 1 ? '' : 's'} actualizado${res.costsUpdated === 1 ? '' : 's'}`
        + (sinCodigo > 0 ? ` · ${sinCodigo} sin código` : ''),
      );
      // Resalta en la planilla los productos cuyo costo esta lista realmente movió (no todos los
      // que tienen mapeo — algunos pueden haber quedado con el mismo precio que antes).
      this.store.markChanged(res.changedSkus ?? []);
      await this.store.refreshAll();
      // El modal no se cierra: muestra el resumen (qué tomó precio, qué no tiene código).
      this.importResult.set(res);
    } catch (e) {
      this.errorMsg.set(apiError(e, 'No se pudo importar'));
    } finally {
      this.saving.set(false);
    }
  }

  /** Desde el resumen del import: cerrar e ir a la pestaña de mapeo para asignar lo que falta. */
  goToMapping(): void {
    this.store.close();
    this.store.setView('mapeo');
  }

  briefName(b: { name: string | null; sku: string }): string {
    return b.name || b.sku;
  }

  matchSourceLabel(source: string): string {
    if (source === 'base') return 'código base';
    if (source === 'group') return 'dentro de un código múltiple';
    if (source === 'text') return 'parecido por descripción';
    return source;
  }
}
