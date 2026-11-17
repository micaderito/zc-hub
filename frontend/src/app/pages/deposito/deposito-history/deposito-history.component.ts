import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { injectQuery } from '@tanstack/angular-query-experimental';
import { firstValueFrom } from 'rxjs';
import { DepositoMovement, DepositoService } from '../../../core/services/deposito.service';

/** Clave de la query del historial de una fila (la página la invalida después de un +/−). */
export const depositoMovementsKey = (id: number) => ['deposito', 'movements', id] as const;

interface MovementDay {
  key: string;
  label: string;
  movements: DepositoMovement[];
}

const TZ = 'America/Argentina/Buenos_Aires';
const dayKey = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: TZ });

/** Hoy / Ayer / "lun 15/11" (hora argentina). `now` inyectable para los tests. */
export function movementDayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const key = dayKey(d);
  if (key === dayKey(now)) return 'Hoy';
  if (key === dayKey(new Date(now.getTime() - 86_400_000))) return 'Ayer';
  // Armado a mano: según el navegador, es-AR separa día y mes con "-" o con "/".
  const parts = new Intl.DateTimeFormat('es-AR', { timeZone: TZ, weekday: 'short', day: '2-digit', month: '2-digit' }).formatToParts(d);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('weekday').replace('.', '')} ${part('day')}/${part('month')}`;
}

/** Agrupa los movimientos (ya vienen del más nuevo al más viejo) por día. */
export function groupMovementsByDay(movements: DepositoMovement[], now = new Date()): MovementDay[] {
  const days: MovementDay[] = [];
  for (const m of movements) {
    const key = dayKey(new Date(m.createdAt));
    let day = days[days.length - 1];
    if (!day || day.key !== key) {
      day = { key, label: movementDayLabel(m.createdAt, now), movements: [] };
      days.push(day);
    }
    day.movements.push(m);
  }
  return days;
}

/**
 * Historial de una fila del depósito: cada alta, +/−, cambio de cantidad al editar y baja, con
 * cuánto cambió, en cuánto quedó, quién y cuándo. Lo usa la hoja de detalle (celular) y el
 * modal del relojito (escritorio).
 */
@Component({
  selector: 'zc-deposito-history',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './deposito-history.component.html',
  styleUrl: './deposito-history.component.scss',
})
export class DepositoHistoryComponent {
  private readonly deposito = inject(DepositoService);

  readonly itemId = input.required<number>();

  readonly query = injectQuery(() => ({
    queryKey: depositoMovementsKey(this.itemId()),
    queryFn: () => firstValueFrom(this.deposito.getMovements(this.itemId())),
    staleTime: 15_000,
  }));

  readonly days = computed(() => groupMovementsByDay(this.query.data()?.movements ?? []));

  title(m: DepositoMovement): string {
    switch (m.kind) {
      case 'alta': return 'Alta en el depósito';
      case 'baja': return 'Fila borrada';
      case 'edicion': return `Editado: ${m.quantityAfter - m.delta} → ${m.quantityAfter}`;
      default: return m.delta > 0 ? 'Sumado a mano' : 'Restado a mano';
    }
  }

  deltaText(m: DepositoMovement): string {
    return m.delta > 0 ? `+${m.delta}` : `−${Math.abs(m.delta)}`;
  }

  time(m: DepositoMovement): string {
    return new Date(m.createdAt).toLocaleTimeString('es-AR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
  }
}
