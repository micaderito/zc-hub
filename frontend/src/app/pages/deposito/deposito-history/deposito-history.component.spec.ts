import { DepositoMovement } from '../../../core/services/deposito.service';
import { groupMovementsByDay, movementDayLabel } from './deposito-history.component';

const mov = (id: number, createdAt: string, delta = 1): DepositoMovement => ({
  id, itemId: 1, kind: 'ajuste', delta, quantityAfter: 5, label: 'X', unit: 'u', actor: null, createdAt,
});

describe('historial del depósito', () => {
  // 17/11/2026 15:00 en Argentina (UTC−3).
  const now = new Date('2026-11-17T18:00:00Z');

  it('rotula Hoy / Ayer / fecha en hora argentina', () => {
    expect(movementDayLabel('2026-11-17T12:00:00Z', now)).toBe('Hoy');
    // 01:30 UTC del 17 = 22:30 del 16 en Argentina.
    expect(movementDayLabel('2026-11-17T01:30:00Z', now)).toBe('Ayer');
    expect(movementDayLabel('2026-11-15T15:00:00Z', now)).toMatch(/15\/11/);
  });

  it('agrupa por día respetando el orden (más nuevo primero)', () => {
    const days = groupMovementsByDay([
      mov(3, '2026-11-17T15:00:00Z'),
      mov(2, '2026-11-17T12:00:00Z'),
      mov(1, '2026-11-15T15:00:00Z'),
    ], now);
    expect(days.map((d) => [d.label === 'Hoy', d.movements.map((m) => m.id)])).toEqual([[true, [3, 2]], [false, [1]]]);
  });
});
