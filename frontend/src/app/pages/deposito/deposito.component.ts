import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { injectQuery } from '@tanstack/angular-query-experimental';
import { firstValueFrom } from 'rxjs';
import { DepositoService, DepositoItem, DepositoItemType } from '../../core/services/deposito.service';
import { MappingService, CatalogOption } from '../../core/services/mapping.service';
import { matchSearchByTokens } from '../../core/services/conflicts.service';

/** Estado del formulario de alta/edición de una fila de depósito. */
interface DepositoForm {
  id: number | null;
  sku: string;
  label: string;
  itemType: DepositoItemType;
  quantity: number;
  unit: string;
  notes: string;
}

function emptyForm(): DepositoForm {
  return { id: null, sku: '', label: '', itemType: 'producto', quantity: 0, unit: 'unidades', notes: '' };
}

/**
 * Depósito Marañón — stock físico guardado aparte del publicado en ML/TN: tanto productos del
 * catálogo (vinculados por SKU, autocomplete contra ML/TN) como insumos de embalaje sin canal
 * (rollos, cinta) que nunca fueron ni van a ser un producto publicado.
 */
@Component({
  selector: 'app-deposito',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './deposito.component.html',
  styleUrl: './deposito.component.scss',
})
export class DepositoComponent {
  private readonly deposito = inject(DepositoService);
  private readonly mapping = inject(MappingService);

  readonly itemsQuery = injectQuery(() => ({
    queryKey: ['deposito', 'items'],
    queryFn: () => firstValueFrom(this.deposito.getAll()),
    staleTime: 15_000,
  }));

  readonly items = computed<DepositoItem[]>(() => this.itemsQuery.data()?.items ?? []);
  readonly search = signal('');

  readonly filteredItems = computed(() => {
    const q = this.search();
    return this.items().filter((i) => matchSearchByTokens(q, `${i.label} ${i.sku ?? ''}`));
  });

  readonly totals = computed(() => {
    const items = this.items();
    return {
      total: items.length,
      productos: items.filter((i) => i.itemType === 'producto').length,
      embalaje: items.filter((i) => i.itemType === 'embalaje').length,
    };
  });

  // ── Catálogo ML/TN para el autocomplete de SKU (carga perezosa, una sola vez) ──
  readonly catalogOptions = signal<CatalogOption[]>([]);
  readonly catalogLoading = signal(false);
  private catalogLoaded = false;

  async ensureCatalogLoaded(): Promise<void> {
    if (this.catalogLoaded || this.catalogLoading()) return;
    this.catalogLoading.set(true);
    try {
      const [ml, tn] = await Promise.allSettled([
        firstValueFrom(this.mapping.getMercadoLibreSources()),
        firstValueFrom(this.mapping.getTiendaNubeSources()),
      ]);
      // Si las dos llamadas fallan (token vencido, ML/TN caídos), no marcamos el catálogo como
      // cargado: la próxima vez que se abra el modal se reintenta en vez de quedar vacío para siempre.
      if (ml.status === 'rejected' && tn.status === 'rejected') return;
      const options = new Map<string, CatalogOption>();
      if (ml.status === 'fulfilled') for (const o of ml.value) options.set(o.sku, o);
      if (tn.status === 'fulfilled') for (const o of tn.value) options.set(o.sku, o);
      this.catalogOptions.set([...options.values()].sort((a, b) => a.sku.localeCompare(b.sku)));
      this.catalogLoaded = true;
    } finally {
      this.catalogLoading.set(false);
    }
  }

  // ── Buscador de SKU (por SKU o descripción, sobre el catálogo ya cargado) ──
  readonly skuQuery = signal('');
  readonly skuDropdownOpen = signal(false);

  readonly filteredCatalogOptions = computed(() => {
    const q = this.skuQuery();
    if (!q.trim()) return [];
    return this.catalogOptions()
      .filter((o) => matchSearchByTokens(q, `${o.label} ${o.sku}`))
      .slice(0, 30);
  });

  skuLabelFor(sku: string): string | null {
    return this.catalogOptions().find((o) => o.sku === sku)?.label ?? null;
  }

  skuThumbnailFor(sku: string): string | null {
    return this.catalogOptions().find((o) => o.sku === sku)?.thumbnail ?? null;
  }

  onSkuQueryChange(value: string): void {
    this.skuQuery.set(value);
    this.skuDropdownOpen.set(true);
  }

  /** Ejecutar el cierre en un microtask para que el click de la opción llegue a registrarse antes. */
  onSkuInputBlur(): void {
    setTimeout(() => this.skuDropdownOpen.set(false), 150);
  }

  selectSku(option: CatalogOption): void {
    this.form.update((f) => ({ ...f, sku: option.sku, label: f.label.trim() ? f.label : option.label }));
    this.skuQuery.set('');
    this.skuDropdownOpen.set(false);
  }

  clearSku(): void {
    this.form.update((f) => ({ ...f, sku: '' }));
    this.skuQuery.set('');
    this.skuDropdownOpen.set(true);
  }

  // ── Modal de alta/edición ──
  readonly showForm = signal(false);
  readonly form = signal<DepositoForm>(emptyForm());
  readonly saving = signal(false);
  readonly errorMsg = signal<string | null>(null);
  readonly adjustingId = signal<number | null>(null);

  openCreate(): void {
    this.form.set(emptyForm());
    this.skuQuery.set('');
    this.skuDropdownOpen.set(false);
    this.errorMsg.set(null);
    this.showForm.set(true);
    void this.ensureCatalogLoaded();
  }

  openEdit(item: DepositoItem): void {
    this.form.set({
      id: item.id, sku: item.sku ?? '', label: item.label, itemType: item.itemType,
      quantity: item.quantity, unit: item.unit, notes: item.notes ?? '',
    });
    this.skuQuery.set('');
    this.skuDropdownOpen.set(false);
    this.errorMsg.set(null);
    this.showForm.set(true);
    if (item.itemType === 'producto') void this.ensureCatalogLoaded();
  }

  setItemType(itemType: DepositoItemType): void {
    this.form.update((f) => ({ ...f, itemType, sku: itemType === 'embalaje' ? '' : f.sku }));
    this.skuQuery.set('');
    this.skuDropdownOpen.set(false);
    if (itemType === 'producto') void this.ensureCatalogLoaded();
  }

  updateForm<K extends keyof DepositoForm>(key: K, value: DepositoForm[K]): void {
    this.form.update((f) => ({ ...f, [key]: value }));
  }

  async save(): Promise<void> {
    const f = this.form();
    if (!f.label.trim()) { this.errorMsg.set('La descripción es obligatoria'); return; }
    if (f.itemType === 'producto' && !f.sku.trim()) { this.errorMsg.set('Elegí el SKU del producto (catálogo ML/TN)'); return; }
    this.saving.set(true);
    this.errorMsg.set(null);
    try {
      const payload = {
        sku: f.itemType === 'producto' ? f.sku.trim() : null,
        label: f.label.trim(),
        itemType: f.itemType,
        quantity: Number(f.quantity) || 0,
        unit: f.unit.trim() || 'unidades',
        notes: f.notes.trim() || null,
      };
      if (f.id != null) {
        await firstValueFrom(this.deposito.update(f.id, payload));
      } else {
        await firstValueFrom(this.deposito.create(payload));
      }
      await this.itemsQuery.refetch();
      this.showForm.set(false);
    } catch (e) {
      this.errorMsg.set((e as { error?: { error?: string } })?.error?.error ?? 'No se pudo guardar');
    } finally {
      this.saving.set(false);
    }
  }

  async remove(item: DepositoItem): Promise<void> {
    try {
      await firstValueFrom(this.deposito.delete(item.id));
      await this.itemsQuery.refetch();
    } catch (e) {
      this.errorMsg.set((e as { error?: { error?: string } })?.error?.error ?? 'No se pudo borrar');
    }
  }

  /** +1 / -1 rápido desde la tabla, sin abrir el modal. */
  async adjust(item: DepositoItem, delta: number): Promise<void> {
    if (item.quantity + delta < 0) return;
    this.adjustingId.set(item.id);
    try {
      await firstValueFrom(this.deposito.adjust(item.id, delta));
      await this.itemsQuery.refetch();
    } catch (e) {
      this.errorMsg.set((e as { error?: { error?: string } })?.error?.error ?? 'No se pudo ajustar');
    } finally {
      this.adjustingId.set(null);
    }
  }
}
