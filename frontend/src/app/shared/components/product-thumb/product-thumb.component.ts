import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { PhotoLightboxService } from '../photo-lightbox/photo-lightbox.service';
import { largePhotoUrl } from './photo-url';

/**
 * Miniatura de la foto de un producto. LA forma de mostrar una foto de producto en el hub: además
 * de la miniatura, al tocarla abre la foto en grande (`zc-photo-lightbox`, con flechas si hay
 * varias). Sin foto muestra un ícono.
 *
 * - `photos`: todas las fotos que se pueden recorrer en el zoom (si no, solo la de `src`, en
 *   grande). Arranca en la que corresponde a `src` (o a `zoomSrc`, la versión grande de esta foto
 *   cuando no se puede deducir de la URL de la miniatura).
 * - `zoom`:
 *   - `'image'` (default): toda la miniatura abre el zoom. Si está dentro de algo clickeable (una
 *     fila que abre un detalle), el toque en la foto NO le llega a la fila.
 *   - `'badge'`: solo la lupita de la esquina abre el zoom; tocar la foto hace lo de siempre en el
 *     contenedor (elegir una opción de un buscador, seleccionar una foto, arrastrar para ordenar).
 *   - `'none'`: solo la miniatura, sin zoom.
 * - Tamaño con `--thumb-size` (36px por defecto; `100%` llena el contenedor) y radio con
 *   `--thumb-radius`. La lupita se puede correr con `--thumb-zoom-top/right/bottom/left`.
 * - Si la foto no carga (el CDN de ML a veces corta alguna), reintenta una vez a los
 *   `THUMB_RETRY_MS` y, si vuelve a fallar, muestra el ícono de "sin foto" en vez de la imagen rota.
 *
 * Usa `<span role="button">` y no `<button>` a propósito: muchas miniaturas viven adentro de un
 * `<button>` o un `<label>`, donde un botón anidado es HTML inválido.
 */
/** Espera antes de volver a pedir una foto que no cargó. */
export const THUMB_RETRY_MS = 2000;

/** Misma URL con un parámetro para que el navegador la vuelva a pedir (el CDN lo ignora). */
function retryUrl(src: string): string {
  return `${src}${src.includes('?') ? '&' : '?'}zcr=1`;
}

@Component({
  selector: 'zc-product-thumb',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (shownSrc()) {
      @if (zoom() === 'none') {
        <img [src]="shownSrc()" [alt]="alt()" class="thumb-img" draggable="false" (error)="onError()" />
      } @else if (zoom() === 'image') {
        <span class="thumb-wrap zoomable" role="button" tabindex="0" [attr.aria-label]="label()" [attr.title]="label()"
              (click)="open($event)" (pointerdown)="$event.stopPropagation()"
              (keydown.enter)="open($event)" (keydown.space)="open($event)">
          <img [src]="shownSrc()" [alt]="alt()" class="thumb-img" draggable="false" (error)="onError()" />
          <span class="zoom" aria-hidden="true"><i class="ti ti-zoom-in"></i></span>
        </span>
      } @else {
        <span class="thumb-wrap">
          <img [src]="shownSrc()" [alt]="alt()" class="thumb-img" draggable="false" (error)="onError()" />
          <span class="zoom zoom-btn" role="button" tabindex="0" [attr.aria-label]="label()" [attr.title]="label()"
                (click)="open($event)" (pointerdown)="$event.stopPropagation()" (mousedown)="$event.stopPropagation()"
                (keydown.enter)="open($event)" (keydown.space)="open($event)">
            <i class="ti ti-zoom-in" aria-hidden="true"></i>
          </span>
        </span>
      }
    } @else {
      <span class="thumb-placeholder" aria-hidden="true">
        <i [class]="'ti ' + placeholderIcon()"></i>
      </span>
    }
  `,
  styles: [`
    @use 'mobile' as m;
    :host { display: contents; }

    .thumb-wrap {
      position: relative;
      display: inline-flex;
      flex-shrink: 0;
      width: var(--thumb-size, 36px);
      height: var(--thumb-size, 36px);
      border-radius: var(--thumb-radius, var(--radius-sm));
    }
    .thumb-wrap .thumb-img { width: 100%; height: 100%; }
    .thumb-wrap.zoomable { cursor: zoom-in; }
    .thumb-wrap.zoomable:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }

    .thumb-img,
    .thumb-placeholder {
      width: var(--thumb-size, 36px);
      height: var(--thumb-size, 36px);
      border-radius: var(--thumb-radius, var(--radius-sm));
      flex-shrink: 0;
    }

    .thumb-img {
      object-fit: cover;
      display: block;
      background: var(--surface-2);
      -webkit-user-drag: none;
    }

    .thumb-placeholder {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: var(--surface-2);
      color: var(--text-3);
      font-size: calc(var(--thumb-size, 36px) * 0.42);
    }

    /* Lupita en la esquina: avisa que la foto se agranda. */
    .zoom {
      position: absolute;
      top: var(--thumb-zoom-top, auto);
      right: var(--thumb-zoom-right, -4px);
      bottom: var(--thumb-zoom-bottom, -4px);
      left: var(--thumb-zoom-left, auto);
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--surface);
      color: var(--text-2);
      font-size: 9px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 0.5px solid var(--border);
      pointer-events: none;
    }
    /* En modo 'badge' la lupita ES el botón: un poco más grande y con área de toque generosa. */
    /* Adentro de la foto: en modo 'badge' la miniatura suele estar en un tile con overflow hidden. */
    .zoom-btn {
      right: var(--thumb-zoom-right, 3px);
      bottom: var(--thumb-zoom-bottom, 3px);
      width: 18px;
      height: 18px;
      font-size: 11px;
      pointer-events: auto;
      cursor: zoom-in;
    }
    .zoom-btn::after { content: ''; position: absolute; inset: -8px; }
    .zoom-btn:focus-visible { outline: 2px solid var(--brand); outline-offset: 1px; }
    @include m.hover {
      .thumb-wrap.zoomable:hover .zoom,
      .zoom-btn:hover { color: var(--brand); border-color: var(--brand); }
    }
    @include m.touch {
      .zoom-btn { width: 22px; height: 22px; font-size: 13px; }
    }
  `],
})
export class ProductThumbComponent {
  private readonly lightbox = inject(PhotoLightboxService);
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  readonly src = input<string | null | undefined>();
  /** Fotos para recorrer en el zoom (default: solo `src`, en grande). */
  readonly photos = input<(string | null | undefined)[] | null | undefined>(null);
  /** Título del zoom (nombre del producto). */
  readonly title = input<string | null | undefined>('');
  /** Debajo del título en el zoom (variante, SKU…). */
  readonly subtitle = input<string | null | undefined>(null);
  /** Esta misma foto en grande, si no sale de la URL de `src` (ver `largePhotoUrl`). */
  readonly zoomSrc = input<string | null | undefined>(null);
  readonly zoom = input<'image' | 'badge' | 'none'>('image');
  readonly alt = input('');
  /** Ícono (Tabler) cuando no hay foto. */
  readonly placeholderIcon = input('ti-photo-off');

  /** Cómo va la carga de `src`: si cambia `src`, se arranca de cero. */
  private readonly load = signal<{ src: string; attempt: number; failed: boolean } | null>(null);

  /** La URL que va en el `<img>`: `null` (ícono) si no hay foto o no cargó tampoco al reintentar. */
  protected readonly shownSrc = computed(() => {
    const src = this.src();
    if (!src) return null;
    const st = this.load();
    if (!st || st.src !== src) return src;
    if (st.failed) return null;
    return st.attempt > 0 ? retryUrl(src) : src;
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.clearRetry());
  }

  onError(): void {
    const src = this.src();
    if (!src) return;
    const st = this.load();
    const attempt = st && st.src === src ? st.attempt : 0;
    this.clearRetry();
    this.load.set({ src, attempt, failed: true });
    // Un `blob:`/`data:` (foto recién elegida) no se arregla reintentando.
    if (attempt > 0 || !/^https?:/i.test(src)) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.src() === src) this.load.set({ src, attempt: 1, failed: false });
    }, THUMB_RETRY_MS);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  protected readonly label = computed(() => (this.title() ? `Ver foto de ${this.title()}` : 'Ver foto en grande'));

  /** Fotos del zoom, en grande y sin vacías. */
  private readonly zoomPhotos = computed(() => {
    const list = this.photos()?.length ? this.photos()! : [this.zoomSrc() || this.src()];
    return [...new Set(list.map((p) => largePhotoUrl(p)).filter((p): p is string => !!p))];
  });

  open(event: Event): void {
    // Que el toque no le llegue a lo de atrás (fila que abre un detalle, opción de un buscador,
    // `<label>` que tildaría su checkbox) y que la barra espaciadora no scrollee.
    event.stopPropagation();
    event.preventDefault();
    const photos = this.zoomPhotos();
    if (!photos.length) return;
    const own = largePhotoUrl(this.zoomSrc() || this.src());
    this.lightbox.open({
      photos,
      title: this.title() ?? '',
      subtitle: this.subtitle() ?? null,
      startIndex: Math.max(own ? photos.indexOf(own) : 0, 0),
    });
  }
}
