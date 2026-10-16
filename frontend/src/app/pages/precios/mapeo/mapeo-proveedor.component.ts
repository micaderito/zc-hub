import { Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { QueryClient, injectQuery } from '@tanstack/angular-query-experimental';
import { firstValueFrom } from 'rxjs';
import { MappingProduct, PricingService, SupplierCode } from '../../../core/services/pricing.service';

type MappingFilter = 'all' | 'mapped' | 'unmapped';

/**
 * Un grupo de la lista: un pack CON código propio (`packRow`: el código se asigna al pack entero y
 * `rows` son sus modelos), un pack SIN código propio (sus modelos se mapean de a uno), o los
 * sueltos (`pack: null`).
 */
interface MappingGroup {
  key: string;
  pack: string | null;
  packRow: MappingProduct | null;
  rows: MappingProduct[];
  unmapped: number;
}

/** Valor del filtro de lista para los productos que no tienen código. */
const NO_LIST = '__none__';

/**
 * Pestaña "Mapeo con el proveedor" de Actualizar precios: TODOS los productos de la tienda (y los
 * packs con código propio) con el código de la lista del proveedor que tienen asignado — o
 * ninguno —, de qué lista sale su precio y si ya tienen costo. Es lo que permite ver qué no mapeó
 * después de importar las listas y asignarlo a mano: al guardar, el precio se toma en el momento
 * de la lista más reciente que trae ese código (sin volver a importar).
 *
 * Los códigos son de cada proveedor: con un proveedor elegido (`supplierKey`) se editan los de ese
 * proveedor; en "Todos" (`null`) la vista es de solo lectura y muestra el código de cada proveedor.
 */
@Component({
  selector: 'zc-mapeo-proveedor',
  standalone: true,
  imports: [FormsModule, NgTemplateOutlet],
  templateUrl: './mapeo-proveedor.component.html',
  styleUrl: './mapeo-proveedor.component.scss',
})
export class MapeoProveedorComponent {
  private readonly pricing = inject(PricingService);
  private readonly queryClient = inject(QueryClient);

  /** Proveedor de la pestaña; `null` = "Todos" (solo lectura). */
  readonly supplierKey = input<string | null>(null);
  readonly readOnly = computed(() => this.supplierKey() == null);

  /** Avisa al padre qué SKUs cambiaron de costo, para resaltarlos en la planilla de precios. */
  readonly costsChanged = output<string[]>();

  readonly mappingQuery = injectQuery(() => ({
    queryKey: ['pricing', 'mapping', this.supplierKey() ?? 'all'],
    queryFn: () => firstValueFrom(this.pricing.getMappingState(this.supplierKey())),
    staleTime: 15_000,
  }));

  readonly filter = signal<MappingFilter>('all');
  readonly listFilter = signal<string>('');
  readonly search = signal('');
  /** Packs desplegados (por clave de grupo). Arrancan plegados para que la lista no sea eterna. */
  readonly expanded = signal<Set<string>>(new Set());

  readonly editingKey = signal<string | null>(null);
  readonly editCode = signal('');
  readonly saving = signal(false);
  readonly message = signal<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null);

  readonly products = computed<MappingProduct[]>(() => this.mappingQuery.data()?.products ?? []);
  readonly codes = computed<SupplierCode[]>(() => this.mappingQuery.data()?.codes ?? []);
  private readonly codeSet = computed(() => new Set(this.codes().map((c) => c.code)));

  /** Listas de las que sale algún precio, para el filtro. */
  readonly listLabels = computed(() =>
    [...new Set(this.products().map((p) => p.listLabel).filter((l): l is string => !!l))].sort((a, b) => a.localeCompare(b, 'es')),
  );

  private readonly searched = computed(() => {
    const q = normalize(this.search());
    const list = this.listFilter();
    return this.products().filter((p) => {
      if (list === NO_LIST && p.code) return false;
      if (list && list !== NO_LIST && p.listLabel !== list) return false;
      if (!q) return true;
      return [p.sku, p.name, p.code, p.codeDescription, p.packName, ...p.memberSkus, ...(p.members ?? []).map((m) => m.name)]
        .some((v) => v && normalize(v).includes(q));
    });
  });

  readonly counts = computed(() => {
    const rows = this.searched();
    const mapped = rows.filter((p) => !!p.code).length;
    return { all: rows.length, mapped, unmapped: rows.length - mapped };
  });

  readonly groups = computed<MappingGroup[]>(() => {
    const f = this.filter();
    const rows = this.searched()
      .filter((p) => f === 'all' || (f === 'mapped' ? !!p.code : !p.code))
      .sort((a, b) => displayName(a).localeCompare(displayName(b), 'es'));
    const byPack = new Map<string, MappingProduct[]>();
    const loose: MappingProduct[] = [];
    const groups: MappingGroup[] = [];
    for (const r of rows) {
      if (r.kind === 'pack') {
        const members = membersOf(r);
        groups.push({ key: r.key, pack: displayName(r), packRow: r, rows: members, unmapped: members.filter((m) => !m.code).length });
      } else if (r.packName) {
        const list = byPack.get(r.packName) ?? [];
        list.push(r);
        byPack.set(r.packName, list);
      } else {
        loose.push(r);
      }
    }
    for (const [pack, rs] of byPack) {
      groups.push({ key: `group:${pack}`, pack, packRow: null, rows: rs, unmapped: rs.filter((r) => !r.code).length });
    }
    groups.sort((a, b) => (a.pack ?? '').localeCompare(b.pack ?? '', 'es'));
    if (loose.length > 0) groups.push({ key: 'loose', pack: null, packRow: null, rows: loose, unmapped: loose.filter((r) => !r.code).length });
    return groups;
  });

  /** Códigos de las listas que no están asignados a ningún producto (respetan búsqueda y lista). */
  readonly unusedCodes = computed<SupplierCode[]>(() => {
    const q = normalize(this.search());
    const list = this.listFilter();
    return this.codes().filter((c) => {
      if (c.mapped) return false;
      if (list === NO_LIST) return false;
      if (list && c.listLabel !== list) return false;
      return !q || [c.code, c.description].some((v) => v && normalize(v).includes(q));
    });
  });

  readonly noListValue = NO_LIST;

  /** Último resultado del backend cuyo mapeo automático ya se avisó (no repetir el aviso). */
  private notifiedAuto: object | null = null;

  constructor() {
    // El backend mapea solo lo que coincide con un código de las listas (código igual o
    // `CODIGO-variante`) al leer el mapeo: se avisa y se resaltan los costos que cambiaron.
    effect(() => {
      const data = this.mappingQuery.data();
      const auto = data?.autoMapped;
      if (!data || data === this.notifiedAuto || !auto?.count) return;
      this.notifiedAuto = data;
      const n = auto.count;
      this.message.set({ kind: 'ok', text: `Se ${n === 1 ? 'mapeó solo 1 producto' : `mapearon solos ${n} productos`} cuyo SKU coincide con un código de las listas (${auto.items.map((i) => i.code).filter((c, i, a) => a.indexOf(c) === i).join(', ')}).` });
      if (auto.changedSkus.length > 0) this.costsChanged.emit(auto.changedSkus);
      void this.queryClient.invalidateQueries({ queryKey: ['pricing', 'preview'] });
    }, { allowSignalWrites: true });
  }

  /** Con una búsqueda activa los packs se muestran abiertos: si no, el resultado quedaría escondido. */
  isExpanded(key: string): boolean {
    return !!this.search().trim() || this.expanded().has(key);
  }

  togglePack(key: string): void {
    this.expanded.update((set) => {
      const next = new Set(set);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  setAllExpanded(open: boolean): void {
    this.expanded.set(open ? new Set(this.groups().filter((g) => g.pack).map((g) => g.key)) : new Set());
  }

  displayName(p: MappingProduct): string {
    return displayName(p);
  }

  /** En "Todos": el código de cada proveedor, en vez del de uno solo. */
  showSupplierCodes(p: MappingProduct): boolean {
    return this.readOnly() && (p.codesBySupplier?.length ?? 0) > 0;
  }

  supplierName(key: string | null | undefined): string {
    return (key && this.mappingQuery.data()?.supplierNames?.[key]) || key || '';
  }

  matchLabel(p: MappingProduct): string {
    if (p.codeSource === 'pack') return 'del pack';
    const source = p.matchSource;
    if (source === 'exact' || source === 'base' || source === 'group') return 'automático';
    if (source === 'manual') return 'a mano';
    if (source === 'text') return 'confirmado';
    return '';
  }

  /** Texto del botón de editar: en un modelo que toma el código del pack, es ponerle uno propio. */
  editLabel(p: MappingProduct): string {
    if (!p.code) return 'Asignar código';
    return p.codeSource === 'pack' ? 'Código propio' : 'Cambiar';
  }

  startEdit(p: MappingProduct): void {
    this.editingKey.set(p.key);
    this.editCode.set(p.codeSource === 'pack' ? '' : (p.code ?? ''));
    this.message.set(null);
  }

  cancelEdit(): void {
    this.editingKey.set(null);
    this.editCode.set('');
  }

  async saveEdit(p: MappingProduct): Promise<void> {
    const code = this.editCode().trim();
    if (!code) return;
    this.saving.set(true);
    this.message.set(null);
    try {
      const sup = this.supplierKey() ?? undefined;
      const res = p.kind === 'pack' && p.packId != null
        ? await firstValueFrom(this.pricing.confirmPackMapping(p.packId, code, 'manual', sup))
        : await firstValueFrom(this.pricing.confirmMapping(p.sku, code, 'manual', sup));
      const who = displayName(p);
      if (res.costsUpdated > 0) {
        this.message.set({ kind: 'ok', text: `${who} → ${code}: precio tomado de "${res.listLabel ?? 'la última lista'}".` });
      } else {
        const why = this.codeSet().has(code)
          ? 'el código no tiene precio por bulto en la lista, o el producto tiene otro proveedor vigente'
          : 'el código no está en ninguna lista importada de este proveedor';
        this.message.set({ kind: 'warn', text: `${who} → ${code} guardado, pero ${why}: el costo se va a tomar cuando importes una lista que lo traiga.` });
      }
      if (res.changedSkus.length > 0) this.costsChanged.emit(res.changedSkus);
      this.cancelEdit();
      await this.refresh();
    } catch (e) {
      this.message.set({ kind: 'err', text: `No se pudo guardar: ${(e as Error)?.message ?? e}` });
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * Saca el código (el costo ya cargado queda: solo deja de actualizarse con las listas). En un
   * modelo de pack con código propio, vuelve a tomar el del pack.
   */
  async removeCode(p: MappingProduct): Promise<void> {
    this.message.set(null);
    try {
      const sup = this.supplierKey() ?? undefined;
      if (p.kind === 'pack' && p.packId != null) await firstValueFrom(this.pricing.removePackMapping(p.packId, sup));
      else await firstValueFrom(this.pricing.removeMapping(p.sku, sup));
      const text = p.codeSource === 'own'
        ? `${displayName(p)} vuelve a tomar el código del pack.`
        : `Se sacó el código de ${displayName(p)}. Su costo actual queda como está.`;
      this.message.set({ kind: 'ok', text });
      await this.refresh();
    } catch (e) {
      this.message.set({ kind: 'err', text: `No se pudo sacar el código: ${(e as Error)?.message ?? e}` });
    }
  }

  private async refresh(): Promise<void> {
    await Promise.all([
      this.mappingQuery.refetch(),
      this.queryClient.invalidateQueries({ queryKey: ['pricing', 'preview'] }),
    ]);
  }
}

function displayName(p: MappingProduct): string {
  return p.name || p.sku;
}

/** Los modelos de un pack con código propio, como filas editables (el mapeo propio es por SKU). */
function membersOf(pack: MappingProduct): MappingProduct[] {
  return (pack.members ?? []).map((m) => ({
    ...m,
    kind: 'sku' as const,
    packId: null,
    memberSkus: [],
    packName: pack.name,
  }));
}

/** Minúsculas y sin acentos, para buscar. */
function normalize(v: string): string {
  return v.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}
