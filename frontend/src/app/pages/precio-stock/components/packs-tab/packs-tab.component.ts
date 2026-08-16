import { Component, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { toSignal, toObservable } from '@angular/core/rxjs-interop';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';
import { injectQuery } from '@tanstack/angular-query-experimental';
import { PacksService, Pack, PACKS_QUERY_KEY } from '../../../../core/services/packs.service';
import { ConflictsService, mlLabel } from '../../../../core/services/conflicts.service';
import { SearchBarComponent } from '../../../../shared/components/search-bar/search-bar.component';
import { ConfirmDialogComponent } from '../../../../shared/components/confirm-dialog/confirm-dialog.component';

/** Resultado del buscador de productos (para agregar al pack). */
interface ProductOption {
  sku: string;
  label: string;
  thumbnail: string | null;
}

/**
 * Pestaña "Packs" de Productos: la unidad de compra al proveedor (ver CLAUDE.md). Se administra
 * acá porque es una propiedad del catálogo, no de las alertas — Alertas solo lo muestra y agrupa.
 * Autocontenida: no comparte estado con la pestaña "Precio y stock" (su propia query, sus propias
 * mutaciones), para no arriesgar la lógica de precios ya existente.
 */
@Component({
  selector: 'zc-packs-tab',
  standalone: true,
  imports: [CommonModule, FormsModule, SearchBarComponent, ConfirmDialogComponent],
  templateUrl: './packs-tab.component.html',
  styleUrl: './packs-tab.component.scss',
})
export class PacksTabComponent {
  private readonly packsSvc = inject(PacksService);
  private readonly conflicts = inject(ConflictsService);

  readonly packsQuery = injectQuery(() => ({
    queryKey: PACKS_QUERY_KEY,
    queryFn: () => this.packsSvc.getPacksPromise(),
    refetchOnWindowFocus: false,
    staleTime: 60 * 1000,
  }));

  readonly loading = computed(() => this.packsQuery.isLoading());
  readonly packs = computed(() => this.packsQuery.data()?.packs ?? []);

  readonly search = signal('');
  readonly filteredPacks = computed(() => {
    const q = this.search().trim().toLowerCase();
    const packs = this.packs();
    if (!q) return packs;
    return packs.filter((p) =>
      p.name.toLowerCase().includes(q) || p.products.some((pr) => pr.sku.toLowerCase().includes(q) || pr.label.toLowerCase().includes(q))
    );
  });

  readonly expanded = signal<Set<number>>(new Set());

  isExpanded(id: number): boolean {
    return this.expanded().has(id);
  }

  toggleExpand(id: number): void {
    this.expanded.update((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  /* ── Alta de pack ── */

  readonly showNewPackForm = signal(false);
  newPackName = '';
  newPackUnitCount = 8;
  newPackMode: 'assorted' | 'single' = 'assorted';
  newPackSku = '';
  readonly savingNewPack = signal(false);
  newPackError: string | null = null;

  async createPack(): Promise<void> {
    const name = this.newPackName.trim();
    if (!name) { this.newPackError = 'Ingresá un nombre para el pack.'; return; }
    this.savingNewPack.set(true);
    this.newPackError = null;
    try {
      await this.packsSvc.createPack({ name, unitCount: this.newPackUnitCount, mode: this.newPackMode, sku: this.newPackSku.trim() || null });
      this.newPackName = '';
      this.newPackUnitCount = 8;
      this.newPackMode = 'assorted';
      this.newPackSku = '';
      this.showNewPackForm.set(false);
    } catch (e: unknown) {
      const err = e as { error?: { error?: string }; message?: string };
      this.newPackError = err?.error?.error || err?.message || 'No se pudo crear el pack.';
    } finally {
      this.savingNewPack.set(false);
    }
  }

  /* ── Edición de pack ── */

  readonly editingPackId = signal<number | null>(null);
  editName = '';
  editUnitCount = 8;
  editMode: 'assorted' | 'single' = 'assorted';
  editSku = '';
  readonly savingEdit = signal(false);
  editError: string | null = null;

  startEditPack(pack: Pack): void {
    this.editingPackId.set(pack.id);
    this.editName = pack.name;
    this.editUnitCount = pack.unitCount;
    this.editMode = pack.mode;
    this.editSku = pack.sku ?? '';
    this.editError = null;
  }

  cancelEditPack(): void {
    this.editingPackId.set(null);
  }

  async saveEditPack(pack: Pack): Promise<void> {
    const name = this.editName.trim();
    if (!name) return;
    this.savingEdit.set(true);
    this.editError = null;
    try {
      await this.packsSvc.updatePack(pack.id, { name, unitCount: this.editUnitCount, mode: this.editMode, sku: this.editSku.trim() || null });
      this.editingPackId.set(null);
    } catch (e: unknown) {
      const err = e as { error?: { error?: string }; message?: string };
      this.editError = err?.error?.error || err?.message || 'No se pudo guardar el pack.';
    } finally {
      this.savingEdit.set(false);
    }
  }

  readonly deletingPackId = signal<number | null>(null);

  async confirmDeletePack(): Promise<void> {
    const id = this.deletingPackId();
    if (id == null) return;
    await this.packsSvc.deletePack(id);
    this.deletingPackId.set(null);
  }

  /* ── Productos dentro de un pack ── */

  readonly addingToPackId = signal<number | null>(null);
  readonly addProductQuery = signal('');
  readonly selectedSkus = signal<Set<string>>(new Set());
  readonly addingProduct = signal(false);
  addProductError: string | null = null;

  /** Debounce para no pegarle al backend en cada tecla (mismo patrón que el resto de la app). */
  private readonly debouncedAddQuery = toSignal(
    toObservable(this.addProductQuery).pipe(debounceTime(300), distinctUntilChanged()),
    { initialValue: '' }
  );

  /** Busca entre los productos matcheados (ML+TN por SKU), por título o SKU. */
  readonly productSearchQuery = injectQuery(() => ({
    queryKey: ['packs', 'product-search', this.debouncedAddQuery()],
    queryFn: async (): Promise<ProductOption[]> => {
      const q = this.debouncedAddQuery().trim();
      const analysis = await this.conflicts.getAnalysisPromise({ tab: 'coincidencias', search: q, limit: 15 });
      return (analysis.matched ?? [])
        .filter((pair) => !!(pair.sku || pair.ml.sku))
        .map((pair) => ({
          sku: (pair.sku || pair.ml.sku)!,
          label: mlLabel(pair.ml),
          thumbnail: pair.ml.thumbnail ?? pair.tn.thumbnail ?? null,
        }));
    },
    enabled: this.debouncedAddQuery().trim().length >= 2,
    refetchOnWindowFocus: false,
    staleTime: 30 * 1000,
  }));

  readonly productSearchLoading = computed(() => this.productSearchQuery.isFetching());

  /** sku → nombre del pack que ya lo tiene (para no mostrarlo como "agregable" a ciegas). */
  private readonly packBySku = computed(() => {
    const map = new Map<string, string>();
    for (const p of this.packs()) for (const prod of p.products) map.set(prod.sku, p.name);
    return map;
  });

  /**
   * Resultados de la búsqueda, sin los que ya están EN ESTE pack (el pedido original: que no
   * vuelvan a aparecer como para agregar de nuevo). Los que están en otro pack sí se muestran,
   * con un aviso, por si la idea es moverlos.
   */
  readonly productSearchResults = computed<(ProductOption & { inOtherPack: string | null })[]>(() => {
    const packId = this.addingToPackId();
    const currentPack = this.packs().find((p) => p.id === packId);
    const inThisPack = new Set(currentPack?.products.map((p) => p.sku) ?? []);
    const byPack = this.packBySku();
    return (this.productSearchQuery.data() ?? [])
      .filter((opt) => !inThisPack.has(opt.sku))
      .map((opt) => ({ ...opt, inOtherPack: byPack.get(opt.sku) ?? null }));
  });

  isSelected(sku: string): boolean {
    return this.selectedSkus().has(sku);
  }

  toggleSelected(sku: string): void {
    this.selectedSkus.update((s) => {
      const next = new Set(s);
      next.has(sku) ? next.delete(sku) : next.add(sku);
      return next;
    });
  }

  openAddProduct(packId: number): void {
    this.addingToPackId.set(packId);
    this.addProductQuery.set('');
    this.selectedSkus.set(new Set());
    this.addProductError = null;
  }

  closeAddProduct(): void {
    this.addingToPackId.set(null);
    this.addProductQuery.set('');
    this.selectedSkus.set(new Set());
  }

  /** Agrega todos los seleccionados de una: buscás, tildás varios, un solo click. */
  async confirmAddSelected(packId: number): Promise<void> {
    const skus = [...this.selectedSkus()];
    if (!skus.length) return;
    this.addingProduct.set(true);
    this.addProductError = null;
    try {
      await Promise.all(skus.map((sku) => this.packsSvc.setSkuPack(sku, packId)));
      this.closeAddProduct();
    } catch (e: unknown) {
      const err = e as { error?: { error?: string }; message?: string };
      this.addProductError = err?.error?.error || err?.message || 'No se pudieron agregar algunos productos.';
    } finally {
      this.addingProduct.set(false);
    }
  }

  async removeProductFromPack(sku: string): Promise<void> {
    await this.packsSvc.setSkuPack(sku, null);
  }
}
