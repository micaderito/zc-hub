import { DispatchPackage } from '../../core/services/dispatch.service';

/**
 * Buscador de Para despachar. Se filtra en el navegador, sobre la lista que ya llegó entera: son
 * ~100-150 paquetes, la lista no se pagina y el backend la arma desde ML/TN con caché de 60 s. Así
 * cada tecla no le pega al backend (ni, a través de él, a ML/TN) y el resultado es instantáneo.
 * El texto de cada paquete se normaliza UNA vez por lista (`buildSearchIndex`); por tecla solo se
 * compara con `includes`.
 */

/** Minúsculas, sin acentos, sin `#` (se pega "Venta #2000…" tal cual) y espacios colapsados. */
export function normalizeSearch(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/#/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Nro de venta (ML: pack o cada orden; TN: número visible e id), comprador, SKU y producto. */
export function packageSearchText(p: DispatchPackage): string {
  const parts: (string | null | undefined)[] = [
    p.saleId,
    ...(p.orderIds ?? []),
    p.orderNumber,
    p.buyer,
    p.buyerName,
    ...p.items.flatMap((it) => [it.sku, it.title, it.variation]),
  ];
  return normalizeSearch(parts.filter(Boolean).join(' '));
}

/** Rótulos que se pegan junto con el número ("Venta #2000…", "Orden #1234"): no se buscan. */
const LABEL_WORDS = new Set(['venta', 'orden', 'pedido', 'sku']);

/**
 * Palabras de la búsqueda: un paquete coincide si tiene TODAS (en cualquier campo). Un número tiene
 * que arrancar donde arranca un número del paquete: "1234" encuentra la orden #1234 de TN o el SKU
 * 1234-AZUL, no cualquier venta de ML que tenga esas cifras en el medio.
 */
export function searchTerms(q: string): string[] {
  const words = normalizeSearch(q).split(' ').filter(Boolean);
  const meaningful = words.filter((w) => !LABEL_WORDS.has(w));
  return meaningful.length ? meaningful : words;
}

const termMatchers = new Map<string, (text: string) => boolean>();

function matcherFor(term: string): (text: string) => boolean {
  let m = termMatchers.get(term);
  if (!m) {
    if (/^\d+$/.test(term)) {
      const re = new RegExp(`(^|[^0-9])${term}`);
      m = (text) => re.test(text);
    } else {
      m = (text) => text.includes(term);
    }
    if (termMatchers.size > 200) termMatchers.clear();
    termMatchers.set(term, m);
  }
  return m;
}

export function buildSearchIndex(packages: DispatchPackage[], key: (p: DispatchPackage) => string): Map<string, string> {
  return new Map(packages.map((p) => [key(p), packageSearchText(p)]));
}

export function matchesTerms(text: string | undefined, terms: string[]): boolean {
  if (!terms.length) return true;
  if (!text) return false;
  return terms.every((t) => matcherFor(t)(text));
}
