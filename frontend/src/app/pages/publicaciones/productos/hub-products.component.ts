import { Component, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { injectQuery, QueryClient } from '@tanstack/angular-query-experimental';
import {
  HubMlPublication,
  HubProductDetail,
  HubProductsService,
  HubStatus,
  HubTnVariant,
  HubVariantRow,
} from '../../../core/services/hub-products.service';
import { SearchBarComponent } from '../../../shared/components/search-bar/search-bar.component';
import { PaginationComponent } from '../../../shared/components/pagination/pagination.component';
import { ProductThumbComponent } from '../../../shared/components/product-thumb/product-thumb.component';
import { CanWriteDirective } from '../../../shared/directives/can-write.directive';
import { LinkVariantDialogComponent } from './link-variant-dialog.component';

const PER_PAGE = 30;

type FilterKey = '' | HubStatus;

/** Etiqueta y color de cada estado. Semántica, no de canal (ver STYLEGUIDE). */
export const HUB_STATUS_META: Record<HubStatus, { label: string; cls: 'ok' | 'warn' | 'err' | 'mute' }> = {
  orphan: { label: 'Variantes sin par', cls: 'err' },
  duplicate: { label: 'SKU repetido', cls: 'err' },
  desync: { label: 'Stock distinto', cls: 'warn' },
  only_ml: { label: 'Solo en ML', cls: 'mute' },
  only_tn: { label: 'Solo en TN', cls: 'mute' },
  linked: { label: 'Vinculado', cls: 'ok' },
};

/**
 * Productos del hub: cada uno con sus publicaciones de ML y TN y una fila por variante (SKU).
 * Los datos salen de la foto del catálogo (`GET /api/hub-products`), no de ML/TN en vivo: navegar
 * no gasta requests. "Actualizar" fuerza un crawl completo, igual que en Conflictos.
 *
 * El producto abierto vive en el query param `p` (se puede compartir el link y sobrevive al F5).
 */
@Component({
  selector: 'zc-hub-products',
  standalone: true,
  imports: [SearchBarComponent, PaginationComponent, ProductThumbComponent, CanWriteDirective, LinkVariantDialogComponent],
  templateUrl: './hub-products.component.html',
  styleUrl: './hub-products.component.scss',
})
export class HubProductsComponent {
  private readonly hub = inject(HubProductsService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly queryClient = inject(QueryClient);

  readonly statusMeta = HUB_STATUS_META;
  readonly filters: { key: FilterKey; label: string }[] = [
    { key: '', label: 'Todos' },
    { key: 'orphan', label: 'Sin par' },
    { key: 'duplicate', label: 'SKU repetido' },
    { key: 'desync', label: 'Stock distinto' },
    { key: 'only_ml', label: 'Solo ML' },
    { key: 'only_tn', label: 'Solo TN' },
    { key: 'linked', label: 'Vinculados' },
  ];

  readonly search = signal('');
  readonly appliedSearch = signal('');
  readonly status = signal<FilterKey>('');
  readonly page = signal(1);
  readonly selectedKey = signal<string | null>(this.route.snapshot.queryParamMap.get('p'));
  readonly refreshing = signal(false);
  /** Fila sin par a la que se le está buscando pareja (abre el diálogo). */
  readonly linking = signal<HubVariantRow | null>(null);
  readonly notice = signal<string | null>(null);
  /** Pub de ML (itemId) o TN (productId) a resaltar al pasar el mouse por una variante. */
  readonly hoverPubs = signal<string[]>([]);

  constructor() {
    let t: ReturnType<typeof setTimeout>;
    effect(() => {
      const v = this.search();
      clearTimeout(t);
      t = setTimeout(() => {
        this.appliedSearch.set(v.trim());
        this.page.set(1);
      }, 300);
    }, { allowSignalWrites: true });
  }

  readonly listQuery = injectQuery(() => ({
    queryKey: ['hub-products', this.appliedSearch(), this.status(), this.page()],
    queryFn: () => this.hub.list({
      search: this.appliedSearch() || undefined,
      status: this.status() || undefined,
      limit: PER_PAGE,
      offset: (this.page() - 1) * PER_PAGE,
    }),
    staleTime: 30_000,
  }));

  readonly detailQuery = injectQuery(() => ({
    queryKey: ['hub-product', this.selectedKey()],
    queryFn: () => this.hub.get(this.selectedKey()!),
    enabled: !!this.selectedKey(),
    staleTime: 30_000,
    retry: false,
  }));

  readonly rows = computed(() => this.listQuery.data()?.rows ?? []);
  readonly total = computed(() => this.listQuery.data()?.total ?? 0);
  readonly counts = computed(() => this.listQuery.data()?.counts);
  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.total() / PER_PAGE)));
  readonly detail = computed<HubProductDetail | undefined>(() => this.detailQuery.data());

  setStatus(k: FilterKey): void {
    this.status.set(k);
    this.page.set(1);
  }

  open(key: string): void {
    this.selectedKey.set(key);
    this.notice.set(null);
    void this.router.navigate([], { relativeTo: this.route, queryParams: { p: key }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  close(): void {
    this.selectedKey.set(null);
    void this.router.navigate([], { relativeTo: this.route, queryParams: { p: null }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  async refresh(): Promise<void> {
    this.refreshing.set(true);
    try {
      await this.hub.list({ refresh: true, limit: 1 });
      await this.queryClient.invalidateQueries({ queryKey: ['hub-products'] });
      await this.queryClient.invalidateQueries({ queryKey: ['hub-product'] });
    } catch {
      /* la lista sigue mostrando lo que había; el error de lectura lo muestra la query */
    } finally {
      this.refreshing.set(false);
    }
  }

  /** Texto de cómo está armado el producto en un canal ("1 publicación con 4 variantes"). */
  shape(d: HubProductDetail, ch: 'ml' | 'tn'): string {
    const pubs = ch === 'ml' ? d.ml : d.tn;
    const variants = d.rows.filter((r) => (ch === 'ml' ? r.ml : r.tn)).length;
    if (!pubs.length) return 'No está publicado';
    const noun = ch === 'ml' ? 'publicación' : 'producto';
    const nouns = ch === 'ml' ? 'publicaciones' : 'productos';
    if (pubs.length === 1) return variants > 1 ? `1 ${noun} con ${variants} variantes` : `1 ${noun}`;
    const sameFamily = ch === 'ml' && (d.ml as HubMlPublication[]).every((p) => p.format === 'up' && p.familyName && p.familyName === d.ml[0].familyName);
    return `${pubs.length} ${nouns}` + (sameFamily ? ', agrupadas en una ficha' : '');
  }

  formatLabel(p: HubMlPublication): string {
    if (p.format === 'legacy') return 'Clásica con variaciones';
    if (p.format === 'up') return 'Ficha de variantes';
    return 'Sin variaciones';
  }

  /** Estado de la publicación de ML que no es "activa" (pausada, en revisión…), en castellano. */
  mlStatusLabel(status: string): string {
    return ({ paused: 'Pausada', under_review: 'En revisión', closed: 'Finalizada', inactive: 'Inactiva', not_yet_active: 'Todavía no activa' } as Record<string, string>)[status] ?? status;
  }

  /** Link a la publicación de ML. El snapshot no guarda el permalink (egress): se arma desde el id. */
  mlUrl(itemId: string): string {
    const digits = String(itemId).replace(/\D/g, '');
    return `https://articulo.mercadolibre.com.ar/MLA-${digits}-_JM`;
  }

  /** Clave corta para relacionar cada variante con su publicación (ML-1, TN-2…). */
  pubKey(d: HubProductDetail, ch: 'ml' | 'tn', id: string | number): string {
    const list = ch === 'ml' ? d.ml.map((p) => p.itemId) : d.tn.map((p) => p.productId);
    const i = list.findIndex((x) => String(x) === String(id));
    return `${ch === 'ml' ? 'ML' : 'TN'}-${i + 1}`;
  }

  /**
   * Nombre de la variante de TN. Sin valores de variante, el snapshot cae al SKU (ver
   * `tnVariantLabel` en conflictsService), que acá ya se ve en su columna: en ese caso se muestra
   * el nombre del producto, que es lo que distingue a cada uno cuando TN tiene un producto por variante.
   */
  tnVariantLabel(d: HubProductDetail, t: HubTnVariant): string {
    if (t.variantName && t.variantName !== t.sku) return t.variantName;
    return d.tn.length > 1 ? t.productName : 'Sin variantes';
  }

  stockDiffers(r: HubVariantRow): boolean {
    return !!r.ml && !!r.tn && Number(r.ml.stock) !== Number(r.tn.stock);
  }

  hover(r: HubVariantRow | null): void {
    if (!r) return this.hoverPubs.set([]);
    const out: string[] = [];
    if (r.ml) out.push(`ml:${r.ml.itemId}`);
    if (r.tn) out.push(`tn:${r.tn.productId}`);
    this.hoverPubs.set(out);
  }

  isHovered(ch: 'ml' | 'tn', id: string | number): boolean {
    return this.hoverPubs().includes(`${ch}:${id}`);
  }

  money(n: number | null | undefined): string {
    return n == null ? '—' : '$ ' + Number(n).toLocaleString('es-AR');
  }

  async onLinked(res: { sku: string; pendingMl: boolean }): Promise<void> {
    this.linking.set(null);
    this.notice.set(res.pendingMl
      ? `Listo: quedó el SKU ${res.sku}. El cambio en Mercado Libre se termina de aplicar en unos segundos (Cola ML).`
      : `Listo: las dos variantes quedaron con el SKU ${res.sku}.`);
    await this.queryClient.invalidateQueries({ queryKey: ['hub-products'] });
    // El grupo puede haber cambiado de id al unirse con otro: si ya no existe, se cierra el detalle.
    try {
      await this.detailQuery.refetch();
    } catch {
      /* el template muestra el aviso de "no encontramos ese producto" */
    }
  }

  prevPage(): void {
    this.page.update((p) => Math.max(1, p - 1));
  }
  nextPage(): void {
    this.page.update((p) => Math.min(this.totalPages(), p + 1));
  }
}
