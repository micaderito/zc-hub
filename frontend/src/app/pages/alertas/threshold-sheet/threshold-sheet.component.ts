import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { QueryClient } from '@tanstack/angular-query-experimental';
import { AlertsService } from '../../../core/services/alerts.service';
import { ORDERS_CATALOG_QUERY_KEY } from '../../../core/services/orders.service';
import { SessionService } from '../../../core/services/session.service';
import { BottomSheetComponent } from '../../../shared/components/bottom-sheet/bottom-sheet.component';

/** Lo que necesita la hoja de un producto: el mismo dato venga de Reglas, Sin alerta o Disparadas. */
export interface ThresholdTarget {
  sku: string;
  label: string;
  stockMl: number | null;
  stockTn: number | null;
  /** Umbral de la regla; `null` = el producto todavía no tiene alerta (la hoja la crea). */
  threshold: number | null;
  mutedUntil?: string | null;
}

const NEW_RULE_DEFAULT = 3;

/**
 * Hoja del celular para crear, cambiar, silenciar o quitar la alerta de UN producto (+/− grande y
 * atajos). En escritorio no se usa: ahí se edita en la fila de la tabla de Reglas.
 */
@Component({
  selector: 'zc-threshold-sheet',
  standalone: true,
  imports: [FormsModule, BottomSheetComponent],
  templateUrl: './threshold-sheet.component.html',
  styleUrl: './threshold-sheet.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ThresholdSheetComponent implements OnInit {
  private readonly alertsSvc = inject(AlertsService);
  private readonly queryClient = inject(QueryClient);
  readonly session = inject(SessionService);

  readonly target = input.required<ThresholdTarget>();
  readonly closed = output<void>();

  readonly presets = [1, 2, 3, 5, 10];
  readonly isNew = computed(() => this.target().threshold === null);
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
    return `${t.sku} · hoy ML ${t.stockMl ?? '—'} · TN ${t.stockTn ?? '—'}`;
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
    return this.run(() => this.alertsSvc.saveRule(t.sku, this.value(), t.label));
  }

  mute(): Promise<void> {
    return this.run(() => this.alertsSvc.muteRule(this.target().sku, 7));
  }

  remove(): Promise<void> {
    if (!this.confirmDelete()) { this.confirmDelete.set(true); return Promise.resolve(); }
    return this.run(() => this.alertsSvc.deleteRule(this.target().sku));
  }

  private async run(action: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await action();
      // Disparadas sale del catálogo de Pedidos: cambiar una regla mueve qué aparece ahí.
      this.queryClient.invalidateQueries({ queryKey: ORDERS_CATALOG_QUERY_KEY });
      this.closed.emit();
    } catch (e: unknown) {
      const err = e as { error?: { error?: string }; message?: string };
      this.error.set(err?.error?.error || err?.message || 'No se pudo guardar.');
    } finally {
      this.busy.set(false);
    }
  }
}
