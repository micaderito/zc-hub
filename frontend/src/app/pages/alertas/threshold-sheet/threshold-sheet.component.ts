import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { QueryClient } from '@tanstack/angular-query-experimental';
import { AlertsService } from '../../../core/services/alerts.service';
import { ORDERS_CATALOG_QUERY_KEY } from '../../../core/services/orders.service';
import { SessionService } from '../../../core/services/session.service';
import { BottomSheetComponent } from '../../../shared/components/bottom-sheet/bottom-sheet.component';
import { ProductThumbComponent } from '../../../shared/components/product-thumb/product-thumb.component';

/** Lo que necesita la hoja de un producto: el mismo dato venga de Reglas, Sin alerta o Disparadas. */
export interface ThresholdTarget {
  sku: string;
  label: string;
  stockMl: number | null;
  stockTn: number | null;
  /** Umbral de la regla; `null` = el producto todavía no tiene alerta (la hoja la crea). */
  threshold: number | null;
  mutedUntil?: string | null;
  thumbnail?: string | null;
  /**
   * Alta en masa: varios productos sin alerta a los que se les crea la MISMA regla de una. Con
   * `items` la hoja solo crea (no silencia ni quita) y `sku`/`stock*` no se usan.
   */
  items?: { sku: string; label: string; thumbnail?: string | null }[];
}

/** Cuántos productos del alta en masa se listan con nombre antes de "y N más". */
const BULK_PREVIEW = 4;

const NEW_RULE_DEFAULT = 3;

/**
 * Hoja para crear, cambiar, silenciar o quitar la alerta de UN producto (+/− grande y atajos), o
 * para crearle la misma alerta a VARIOS de una (`items`, desde Sin alerta). En el celular sube
 * desde abajo; con `dialog` (tablet y compu) es un diálogo centrado.
 */
@Component({
  selector: 'zc-threshold-sheet',
  standalone: true,
  imports: [FormsModule, BottomSheetComponent, ProductThumbComponent],
  templateUrl: './threshold-sheet.component.html',
  styleUrl: './threshold-sheet.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ThresholdSheetComponent implements OnInit {
  private readonly alertsSvc = inject(AlertsService);
  private readonly queryClient = inject(QueryClient);
  readonly session = inject(SessionService);

  readonly target = input.required<ThresholdTarget>();
  readonly dialog = input(false);
  readonly closed = output<void>();
  /** Se guardó (antes de `closed`): quien abrió la hoja en masa limpia la selección. */
  readonly saved = output<void>();

  readonly presets = [1, 2, 3, 5, 10];
  readonly bulk = computed(() => this.target().items ?? null);
  readonly isNew = computed(() => !!this.bulk() || this.target().threshold === null);
  readonly bulkPreview = computed(() => (this.bulk() ?? []).slice(0, BULK_PREVIEW));
  readonly bulkRest = computed(() => Math.max(0, (this.bulk()?.length ?? 0) - BULK_PREVIEW));

  readonly title = computed(() => {
    const items = this.bulk();
    if (!items) return this.target().label;
    return items.length === 1 ? items[0].label : `Alerta para ${items.length} productos`;
  });
  readonly value = signal(NEW_RULE_DEFAULT);
  readonly muted = computed(() => {
    const until = this.target().mutedUntil;
    return !!until && new Date(until).getTime() > Date.now();
  });

  readonly busy = signal(false);
  readonly confirmDelete = signal(false);
  readonly error = signal<string | null>(null);

  readonly subtitle = computed(() => {
    const t = this.target();
    const items = this.bulk();
    if (items) return items.length === 1 ? items[0].sku : 'El mismo umbral para todos';
    return `${t.sku} · hoy ML ${t.stockMl ?? '—'} · TN ${t.stockTn ?? '—'}`;
  });

  readonly leadThumb = computed(() => {
    const items = this.bulk();
    if (items) return items.length === 1 ? items[0].thumbnail ?? null : undefined;
    return this.target().thumbnail;
  });

  ngOnInit(): void {
    this.value.set(this.target().threshold ?? NEW_RULE_DEFAULT);
  }

  step(delta: number): void {
    this.value.update((v) => Math.max(0, (Number(v) || 0) + delta));
  }

  setValue(raw: unknown): void {
    const n = Math.floor(Number(raw));
    this.value.set(Number.isFinite(n) && n >= 0 ? n : 0);
  }

  save(): Promise<void> {
    const t = this.target();
    const items = this.bulk();
    if (items) {
      return this.run(async () => {
        await Promise.all(items.map((it) => this.alertsSvc.saveRule(it.sku, this.value(), it.label)));
      }, true);
    }
    return this.run(() => this.alertsSvc.saveRule(t.sku, this.value(), t.label), true);
  }

  mute(): Promise<void> {
    return this.run(() => this.alertsSvc.muteRule(this.target().sku, 7));
  }

  remove(): Promise<void> {
    if (!this.confirmDelete()) { this.confirmDelete.set(true); return Promise.resolve(); }
    return this.run(() => this.alertsSvc.deleteRule(this.target().sku));
  }

  private async run(action: () => Promise<void>, isSave = false): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await action();
      // Disparadas sale del catálogo de Pedidos: cambiar una regla mueve qué aparece ahí.
      this.queryClient.invalidateQueries({ queryKey: ORDERS_CATALOG_QUERY_KEY });
      if (isSave) this.saved.emit();
      this.closed.emit();
    } catch (e: unknown) {
      const err = e as { error?: { error?: string }; message?: string };
      this.error.set(err?.error?.error || err?.message || (this.bulk() ? 'No se pudieron guardar algunas alertas.' : 'No se pudo guardar.'));
    } finally {
      this.busy.set(false);
    }
  }
}
