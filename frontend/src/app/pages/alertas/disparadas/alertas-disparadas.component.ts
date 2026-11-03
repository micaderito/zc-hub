import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { CatalogMember, CatalogUnit, OrderSupplier } from '../../../core/services/orders.service';
import { matchSearchByTokens } from '../../../core/services/conflicts.service';
import { SearchBarComponent } from '../../../shared/components/search-bar/search-bar.component';
import { CanWriteDirective } from '../../../shared/directives/can-write.directive';

/** Filtro de proveedor: `''` = todos, `'none'` = sin proveedor, o la clave de uno. */
type SupplierFilter = string;

/**
 * Pestaña "Disparadas" de Alertas: los productos que hoy tienen la alerta activa (stock ≤ umbral de
 * la regla), con el mismo catálogo que usa el editor de Pedidos (`GET /api/orders/catalog`, sin
 * proveedor) — así lo que se ve acá es exactamente lo que el pedido muestra como "Con alerta".
 * Una alerta sale de esta lista recién cuando el stock vuelve a superar el umbral.
 */
@Component({
  selector: 'zc-alertas-disparadas',
  standalone: true,
  imports: [DatePipe, FormsModule, RouterLink, SearchBarComponent, CanWriteDirective],
  templateUrl: './alertas-disparadas.component.html',
  styleUrl: './alertas-disparadas.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlertasDisparadasComponent {
  readonly units = input.required<CatalogUnit[]>();
  readonly suppliers = input<OrderSupplier[]>([]);
  readonly loading = input(false);

  readonly search = signal('');
  readonly supplierFilter = signal<SupplierFilter>('');
  /** Packs plegados a mano (arrancan abiertos: lo que importa es qué modelo avisó). */
  private readonly collapsed = signal<Set<string>>(new Set());

  /** Unidades con alerta, la peor primero: sin stock → más lejos del umbral. */
  readonly alerted = computed(() =>
    this.units()
      .filter((u) => u.alerted)
      .sort((a, b) => worstGap(b) - worstGap(a) || a.name.localeCompare(b.name)));

  /** Proveedores que aparecen en las alertas (para el selector), en el orden de la lista de proveedores. */
  readonly supplierOptions = computed(() => {
    const used = new Set(this.alerted().flatMap((u) => u.suppliers));
    return this.suppliers().filter((s) => used.has(s.key));
  });
  readonly hasUnassigned = computed(() => this.alerted().some((u) => !u.suppliers.length));

  readonly visible = computed(() => {
    const q = this.search();
    const sup = this.supplierFilter();
    return this.alerted().filter((u) =>
      (!sup || (sup === 'none' ? !u.suppliers.length : u.suppliers.includes(sup))) &&
      matchSearchByTokens(q, `${u.name} ${u.code ?? ''} ${u.description} ${u.members.map((m) => `${m.sku} ${m.label}`).join(' ')}`));
  });

  /** Modelos con alerta en toda la lista (no solo en lo filtrado). */
  readonly alertedModels = computed(() =>
    this.alerted().reduce((n, u) => n + u.members.filter(isActive).length, 0));

  isOpen(u: CatalogUnit): boolean {
    return !this.collapsed().has(u.key);
  }

  toggle(u: CatalogUnit): void {
    this.collapsed.update((s) => {
      const next = new Set(s);
      next.has(u.key) ? next.delete(u.key) : next.add(u.key);
      return next;
    });
  }

  activeCount(u: CatalogUnit): number {
    return u.members.filter(isActive).length;
  }

  supplierName(key: string): string {
    return this.suppliers().find((s) => s.key === key)?.name ?? key;
  }

  memberLabel(m: CatalogMember): { text: string; cls: string } {
    switch (m.alertState) {
      case 'out': return { text: 'Sin stock', cls: 'err' };
      case 'still-low': return { text: 'Bajo', cls: 'warn' };
      case 'watching': return { text: 'ok', cls: 'plain' };
      default: return { text: 'sin regla', cls: 'plain' };
    }
  }
}

function isActive(m: CatalogMember): boolean {
  return m.alertState === 'out' || m.alertState === 'still-low';
}

/** Cuánto le falta al modelo con alerta que peor está (para ordenar). */
function worstGap(u: CatalogUnit): number {
  return Math.max(0, ...u.members.filter(isActive).map((m) => (m.threshold ?? 0) - (m.stockEffective ?? 0) + (m.alertState === 'out' ? 1000 : 0)));
}
