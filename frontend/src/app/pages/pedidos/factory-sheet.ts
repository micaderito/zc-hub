/**
 * La hoja que se le manda a la fábrica: solo código, descripción, cantidad y detalle (sin precios,
 * alertas ni iconos). Se exporta como imagen (canvas, sin dependencias) o como tabla para pegar en
 * un mail/Excel. Siempre en fondo blanco: se ve igual aunque la app esté en modo oscuro.
 */
import { SupplierOrder } from '../../core/services/orders.service';

export interface FactorySheetRow {
  code: string;
  description: string;
  qty: number;
  detail: string;
}

type SheetOrder = Pick<SupplierOrder, 'id' | 'name' | 'note' | 'lines' | 'orderedAt' | 'createdAt'>;

export function factorySheetRows(order: SheetOrder): FactorySheetRow[] {
  return order.lines.map((l) => ({ code: l.code || '—', description: l.description, qty: l.qty, detail: l.detail }));
}

export function factorySheetDate(order: SheetOrder): string {
  const d = new Date(order.orderedAt ?? order.createdAt ?? Date.now());
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function factorySheetTotalPacks(order: SheetOrder): number {
  return order.lines.reduce((a, l) => a + l.qty, 0);
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const cleanCell = (s: string) => s.replace(/[\t\r\n]+/g, ' ');

/** Tabla separada por tabs (lo que pega Excel/Sheets como columnas). */
export function factorySheetTsv(order: SheetOrder): string {
  const rows = factorySheetRows(order).map((r) => [r.code, r.description, String(r.qty), r.detail].map(cleanCell).join('\t'));
  return ['Código\tDescripción\tCantidad\tDetalle', ...rows].join('\n');
}

/** Tabla HTML con estilos en línea, para pegar en un mail sin perder las columnas. */
export function factorySheetHtml(order: SheetOrder): string {
  const td = 'border:1px solid #c8ccd4;padding:6px 10px;font:13px Arial,sans-serif;color:#1a1c2e';
  const th = `${td};background:#eef0f3;font-weight:bold;text-align:left`;
  const rows = factorySheetRows(order).map((r) =>
    `<tr><td style="${td}">${escapeHtml(r.code)}</td><td style="${td}">${escapeHtml(r.description)}</td>` +
    `<td style="${td};text-align:center"><b>${r.qty}</b></td><td style="${td}">${escapeHtml(r.detail)}</td></tr>`
  ).join('');
  return `<p style="font:bold 15px Arial,sans-serif">${escapeHtml(order.name)} — Zona Cuaderno · ${factorySheetDate(order)}</p>` +
    `<table style="border-collapse:collapse"><thead><tr><th style="${th}">Código</th><th style="${th}">Descripción</th>` +
    `<th style="${th}">Cantidad</th><th style="${th}">Detalle</th></tr></thead><tbody>${rows}</tbody></table>` +
    (order.note ? `<p style="font:13px Arial,sans-serif"><b>Nota:</b> ${escapeHtml(order.note)}</p>` : '');
}

/** Corta un texto en renglones que entren en `maxWidth` (por palabras; una palabra larguísima se corta por letras). */
export function wrapText(ctx: Pick<CanvasRenderingContext2D, 'measureText'>, text: string, maxWidth: number): string[] {
  if (!text) return [''];
  const lines: string[] = [];
  let current = '';
  const push = (word: string) => {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) { current = candidate; return; }
    if (current) lines.push(current);
    current = '';
    if (ctx.measureText(word).width <= maxWidth) { current = word; return; }
    let chunk = '';
    for (const ch of word) {
      if (ctx.measureText(chunk + ch).width > maxWidth && chunk) { lines.push(chunk); chunk = ch; } else chunk += ch;
    }
    current = chunk;
  };
  for (const word of text.split(/\s+/).filter(Boolean)) push(word);
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

const FONT = 'Inter, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';

/**
 * Dibuja la hoja en un canvas (escala ×2 para que la imagen se lea nítida en el celular). Las
 * columnas tienen ancho fijo y la descripción/detalle se parten en renglones.
 */
export function drawFactorySheet(order: SheetOrder, scale = 2): HTMLCanvasElement {
  const W = 880, PAD = 32, LINE = 18, CELL_PAD = 9;
  const cols = [
    { title: 'Código', w: 130, align: 'left' as const },
    { title: 'Descripción', w: 340, align: 'left' as const },
    { title: 'Cantidad', w: 80, align: 'center' as const },
    { title: 'Detalle', w: W - PAD * 2 - 130 - 340 - 80, align: 'left' as const },
  ];
  const rows = factorySheetRows(order);

  const measure = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D;
  measure.font = `13px ${FONT}`;
  const wrapped = rows.map((r) => [
    wrapText(measure, r.code, cols[0].w - CELL_PAD * 2),
    wrapText(measure, r.description, cols[1].w - CELL_PAD * 2),
    [String(r.qty)],
    wrapText(measure, r.detail, cols[3].w - CELL_PAD * 2),
  ]);
  const rowHeights = wrapped.map((cells) => Math.max(...cells.map((c) => c.length)) * LINE + CELL_PAD * 2);
  const noteLines = order.note ? wrapText(measure, `Nota: ${order.note}`, W - PAD * 2) : [];
  const HEAD = 70, TH = 32, FOOT = 34;
  const H = PAD + HEAD + TH + rowHeights.reduce((a, b) => a + b, 0) + FOOT + noteLines.length * LINE + PAD;

  const canvas = document.createElement('canvas');
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.scale(scale, scale);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'top';

  ctx.fillStyle = '#1a1c2e';
  ctx.font = `600 20px ${FONT}`;
  ctx.fillText(order.name, PAD, PAD);
  ctx.fillStyle = '#5d6373';
  ctx.font = `13px ${FONT}`;
  ctx.fillText(`Zona Cuaderno · ${factorySheetDate(order)}`, PAD, PAD + 30);
  ctx.textAlign = 'right';
  ctx.fillText(`Pedido #${order.id}`, W - PAD, PAD + 4);
  ctx.fillText(`${rows.length} productos · ${factorySheetTotalPacks(order)} packs`, W - PAD, PAD + 30);
  ctx.textAlign = 'left';

  const border = '#c8ccd4';
  let y = PAD + HEAD;
  const drawRow = (height: number, fill: string | null, paint: (x: number, col: (typeof cols)[number], i: number) => void) => {
    let x = PAD;
    cols.forEach((col, i) => {
      if (fill) { ctx.fillStyle = fill; ctx.fillRect(x, y, col.w, height); }
      ctx.strokeStyle = border;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, col.w, height);
      paint(x, col, i);
      x += col.w;
    });
    y += height;
  };
  const textX = (x: number, col: (typeof cols)[number]) => (col.align === 'center' ? x + col.w / 2 : x + CELL_PAD);

  drawRow(TH, '#eef0f3', (x, col) => {
    ctx.fillStyle = '#5d6373';
    ctx.font = `600 11px ${FONT}`;
    ctx.textAlign = col.align;
    ctx.fillText(col.title.toUpperCase(), textX(x, col), y + 11);
  });
  wrapped.forEach((cells, r) => {
    drawRow(rowHeights[r], null, (x, col, i) => {
      ctx.fillStyle = '#1a1c2e';
      ctx.font = i === 2 ? `600 14px ${FONT}` : `13px ${FONT}`;
      ctx.textAlign = col.align;
      cells[i].forEach((line, n) => ctx.fillText(line, textX(x, col), y + CELL_PAD + n * LINE));
    });
  });

  ctx.textAlign = 'right';
  ctx.fillStyle = '#5d6373';
  ctx.font = `13px ${FONT}`;
  ctx.fillText('Total', PAD + cols[0].w + cols[1].w - CELL_PAD, y + 10);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#1a1c2e';
  ctx.font = `600 14px ${FONT}`;
  ctx.fillText(String(factorySheetTotalPacks(order)), PAD + cols[0].w + cols[1].w + cols[2].w / 2, y + 10);
  y += FOOT;

  ctx.textAlign = 'left';
  ctx.font = `13px ${FONT}`;
  ctx.fillStyle = '#1a1c2e';
  noteLines.forEach((line, n) => ctx.fillText(line, PAD, y + n * LINE));
  return canvas;
}

/** Nombre de archivo de la imagen: "pedido-17-pedido-octubre.png". */
export function factorySheetFilename(order: Pick<SupplierOrder, 'id' | 'name'>): string {
  const slug = order.name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `pedido-${order.id}${slug ? '-' + slug : ''}.png`;
}
