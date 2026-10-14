import { Component, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { QueryClient, injectQuery } from '@tanstack/angular-query-experimental';
import { firstValueFrom } from 'rxjs';
import { MappingProduct, PricingService, SupplierCode } from '../../../core/services/pricing.service';

type MappingFilter = 'all' | 'mapped' | 'unmapped';

/** Un grupo de la lista: los modelos de un pack SIN código propio, o los sueltos (`pack: null`). */
interface MappingGroup {
  key: string;
  pack: string | null;
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
 */
@Component({
  selector: 'zc-mapeo-proveedor',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './mapeo-proveedor.component.html',
  styleUrl: './mapeo-proveedor.component.scss',
})
export class MapeoProveedorComponent {
  private readonly pricing = inject(PricingService);
  private readonly queryClient = inject(QueryClient);

  /** Avisa al padre qué SKUs cambiaron de costo, para resaltarlos en la planilla de precios. */
  readonly costsChanged = output<string[]>();

  readonly mappingQuery = injectQuery(() => ({
    queryKey: ['pricing', 'mapping'],
    queryFn: () => firstValueFrom(this.pricing.getMappingState()),
    staleTime: 15_000,
  }));

  readonly filter = signal<MappingFilter>('all');
  readonly listFilter = signal<string>('');
  readonly search = signal('');
  /** Packs (sin código propio) desplegados. Arrancan plegados para que la lista no sea eterna. */
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
      return [p.sku, p.name, p.code, p.codeDescription, p.packName, ...p.memberSkus]
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
    for (const r of rows) {
      if (r.packName) {
        const list = byPack.get(r.packName) ?? [];
        list.push(r);
        byPack.set(r.packName, list);
      } else {
        loose.push(r);
      }
    }
    const groups: MappingGroup[] = [...byPack.entries()]
      .sort(([a], [b]) => a.localeCompare(b, 'es'))
      .map(([pack, rs]) => ({ key: `pack:${pack}`, pack, rows: rs, unmapped: rs.filter((r) => !r.code).length }));
    if (loose.length > 0) groups.push({ key: 'loose', pack: null, rows: loose, unmapped: loose.filter((r) => !r.code).length });
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

  /** Con una búsqueda activa los packs se muestran abiertos: si no, el resultado quedaría escondido. */
  isExpanded(pack: string): boolean {
    return !!this.search().trim() || this.expanded().has(pack);
  }

  togglePack(pack: string): void {
    this.expanded.update((set) => {
      const next = new Set(set);
      if (next.has(pack)) next.delete(pack); else next.add(pack);
      return next;
    });
  }

  setAllExpanded(open: boolean): void {
    this.expanded.set(open ? new Set(this.groups().map((g) => g.pack).filter((p): p is string => !!p)) : new Set());
  }

  displayName(p: MappingProduct): string {
    return displayName(p);
  }

  matchLabel(source: string | null): string {
    if (source === 'exact') return 'automático';
    if (source === 'manual') return 'a mano';
    if (source === 'base' || source === 'group' || source === 'text') return 'confirmado';
    return '';
  }

  startEdit(p: MappingProduct): void {
    this.editingKey.set(p.key);
    this.editCode.set(p.code ?? '');
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
      const res = p.kind === 'pack' && p.packId != null
        ? await firstValueFrom(this.pricing.confirmPackMapping(p.packId, code, 'manual'))
        : await firstValueFrom(this.pricing.confirmMapping(p.sku, code, 'manual'));
      const who = displayName(p);
      if (res.costsUpdated > 0) {
        this.message.set({ kind: 'ok', text: `${who} → ${code}: precio tomado de "${res.listLabel ?? 'la última lista'}".` });
      } else {
        const why = this.codeSet().has(code) ? 'el código no tiene precio por bulto en la lista' : 'el código no está en ninguna lista importada';
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

  /** Saca el código (el costo ya cargado queda: solo deja de actualizarse con las listas). */
  async removeCode(p: MappingProduct): Promise<void> {
    this.message.set(null);
    try {
      if (p.kind === 'pack' && p.packId != null) await firstValueFrom(this.pricing.removePackMapping(p.packId));
      else await firstValueFrom(this.pricing.removeMapping(p.sku));
      this.message.set({ kind: 'ok', text: `Se sacó el código de ${displayName(p)}. Su costo actual queda como está.` });
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

/** Minúsculas y sin acentos, para buscar. */
function normalize(v: string): string {
  return v.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}
