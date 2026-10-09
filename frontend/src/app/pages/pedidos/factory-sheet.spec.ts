import { SupplierOrder } from '../../core/services/orders.service';
import {
  drawFactorySheet, factorySheetFilename, factorySheetHtml, factorySheetRows, factorySheetTotalPacks, factorySheetTsv, wrapText,
} from './factory-sheet';

const order = (over: Partial<SupplierOrder> = {}): SupplierOrder => ({
  id: 17, name: 'Pedido octubre', status: 'borrador', partial: false, discount1: 25, discount2: 5, note: 'Entregar martes',
  basedOnId: null, createdAt: '2026-10-08T12:00:00.000Z', updatedAt: null, orderedAt: null, receivedAt: null,
  totals: { lineCount: 2, packs: 3, subtotal: 0, discount1Amount: 0, discount2Amount: 0, total: 0, missingPrices: 0 },
  lines: [
    { kind: 'pack', packId: 1, sku: null, code: '4410-SUR', description: 'CUADERNO <SURTIDO>', detail: 'todo A5\trayado', qty: 2, unitPrice: 96000, priceSource: 'precios', unitsPerPack: 8, origin: 'alerta', receivedQty: null },
    { kind: 'free', packId: null, sku: null, code: '', description: 'Planner nuevo', detail: '', qty: 1, unitPrice: null, priceSource: 'manual', unitsPerPack: null, origin: 'libre', receivedQty: null },
  ],
  ...over,
});

describe('hoja para la fábrica', () => {
  it('solo código, descripción, cantidad y detalle (sin precios); sin código muestra un guion', () => {
    expect(factorySheetRows(order())).toEqual([
      { code: '4410-SUR', description: 'CUADERNO <SURTIDO>', qty: 2, detail: 'todo A5\trayado' },
      { code: '—', description: 'Planner nuevo', qty: 1, detail: '' },
    ]);
    expect(factorySheetTotalPacks(order())).toBe(3);
  });

  it('TSV: una columna por campo, sin tabs ni saltos adentro de una celda', () => {
    const lines = factorySheetTsv(order()).split('\n');
    expect(lines[0]).toBe('Código\tDescripción\tCantidad\tDetalle');
    expect(lines[1]).toBe('4410-SUR\tCUADERNO <SURTIDO>\t2\ttodo A5 rayado');
  });

  it('HTML: tabla escapada, con la nota y sin precios', () => {
    const html = factorySheetHtml(order());
    expect(html).toContain('<table');
    expect(html).toContain('CUADERNO &lt;SURTIDO&gt;');
    expect(html).toContain('Entregar martes');
    expect(html).not.toContain('96');
  });

  it('wrapText parte por palabras según el ancho medido', () => {
    const ctx = { measureText: (t: string) => ({ width: t.length * 10 }) as TextMetrics };
    expect(wrapText(ctx, 'uno dos tres', 70)).toEqual(['uno dos', 'tres']);
    expect(wrapText(ctx, 'abcdefghij', 40)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrapText(ctx, '', 40)).toEqual(['']);
  });

  it('drawFactorySheet dibuja un canvas al doble de resolución', () => {
    const canvas = drawFactorySheet(order());
    expect(canvas.width).toBe(880 * 2);
    expect(canvas.height).toBeGreaterThan(0);
  });

  it('nombre de archivo sin acentos ni espacios', () => {
    expect(factorySheetFilename({ id: 17, name: 'Pedido de Agendas 2027 — señas' })).toBe('pedido-17-pedido-de-agendas-2027-senas.png');
  });
});
