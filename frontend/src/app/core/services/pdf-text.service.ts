import { Injectable } from '@angular/core';

/**
 * Extrae el texto de un archivo de lista de precios. El PDF se procesa **en el navegador**: nunca
 * sale de la máquina, y el backend recibe solo texto (así la API queda simple y el parseo, que es
 * la parte con reglas, vive del lado del servidor donde está testeado).
 *
 * pdfjs se carga de forma diferida: solo pesa cuando realmente importás un PDF.
 */
@Injectable({ providedIn: 'root' })
export class PdfTextService {
  /** ¿Es un PDF? Se mira la extensión y el mime, porque el mime a veces viene vacío. */
  isPdf(file: File): boolean {
    return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  }

  /** Texto de un archivo: PDF vía pdfjs, CSV/TXT leído directo. */
  async extract(file: File): Promise<{ text: string; format: 'pdf' | 'csv' }> {
    if (this.isPdf(file)) {
      return { text: await this.extractPdf(file), format: 'pdf' };
    }
    return { text: await file.text(), format: 'csv' };
  }

  private async extractPdf(file: File): Promise<string> {
    const pdfjs = await import('pdfjs-dist');
    // El worker se copia al build como asset estático (angular.json) desde node_modules, así que
    // se sirve desde el propio dominio (sin CDN, para que ande sin internet). La referencia es
    // relativa (sin "/" inicial) para que el navegador la resuelva contra <base href> — necesario
    // porque en GitHub Pages la app vive en un subpath (/zc-hub/) y no en la raíz del dominio.
    // `new URL(..., import.meta.url)` NO sirve acá: esbuild no reescribe ese import como asset (a
    // diferencia de Vite/webpack), así que en producción quedaba apuntando al specifier del paquete
    // literal en vez de al archivo copiado.
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', document.baseURI).toString();

    const buffer = await file.arrayBuffer();
    const doc = await pdfjs.getDocument({ data: buffer }).promise;
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      // Se concatenan los fragmentos tal cual: el parser del backend espera el bloque continuo
      // (sin separadores entre columnas) que es como sale este PDF.
      pages.push(content.items.map((it) => ('str' in it ? it.str : '')).join(''));
    }
    return pages.join('\n');
  }
}
