import { Component, HostListener, OnInit, computed, input, output, signal } from '@angular/core';

/**
 * Foto grande de un producto, con flechas para pasar entre sus fotos. Pensado para identificar
 * qué armar ("¿cuál era el de lunares?"): ocupa casi toda la pantalla, se cierra con Esc, con la X
 * o tocando afuera.
 */
@Component({
  selector: 'zc-photo-lightbox',
  standalone: true,
  template: `
    <div class="lb-backdrop" (click)="closed.emit()">
      <div class="lb-card" (click)="$event.stopPropagation()" role="dialog" aria-modal="true" [attr.aria-label]="title()">
        <div class="lb-head">
          <div class="lb-title">
            <span>{{ title() }}</span>
            @if (subtitle()) { <small>{{ subtitle() }}</small> }
          </div>
          <button type="button" class="lb-icon" (click)="closed.emit()" aria-label="Cerrar"><i class="ti ti-x"></i></button>
        </div>
        <div class="lb-stage">
          @if (current()) {
            <img [src]="current()" [alt]="title()" />
          } @else {
            <span class="lb-empty"><i class="ti ti-photo-off" aria-hidden="true"></i> Sin foto</span>
          }
          @if (list().length > 1) {
            <button type="button" class="lb-nav prev" (click)="step(-1)" aria-label="Foto anterior"><i class="ti ti-chevron-left"></i></button>
            <button type="button" class="lb-nav next" (click)="step(1)" aria-label="Foto siguiente"><i class="ti ti-chevron-right"></i></button>
            <span class="lb-count">{{ index() + 1 }} / {{ list().length }}</span>
          }
        </div>
        @if (list().length > 1) {
          <div class="lb-strip">
            @for (p of list(); track $index; let i = $index) {
              <button type="button" class="lb-mini" [class.on]="i === index()" (click)="index.set(i)" [attr.aria-label]="'Foto ' + (i + 1)">
                <img [src]="p" alt="" />
              </button>
            }
          </div>
        }
      </div>
    </div>
  `,
  styles: [`
    .lb-backdrop {
      position: fixed; inset: 0; z-index: 120;
      display: flex; align-items: center; justify-content: center; padding: 16px;
      background: color-mix(in srgb, var(--bg) 82%, transparent);
      backdrop-filter: blur(2px);
    }
    .lb-card {
      width: 100%; max-width: 760px; max-height: 100%;
      display: flex; flex-direction: column; gap: 10px;
      background: var(--surface); border: 0.5px solid var(--border-strong);
      border-radius: var(--radius-lg); padding: 12px;
    }
    .lb-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
    .lb-title { display: flex; flex-direction: column; font-size: 0.88rem; font-weight: 600; color: var(--text); }
    .lb-title small { font-size: 0.7rem; font-weight: 400; color: var(--text-2); margin-top: 2px; }
    .lb-icon {
      border: none; background: none; color: var(--text-2); cursor: pointer;
      font-size: 18px; padding: 4px; border-radius: 6px; line-height: 1;
    }
    .lb-icon:hover { background: var(--surface-2); color: var(--text); }
    .lb-stage {
      position: relative; display: flex; align-items: center; justify-content: center;
      background: var(--surface-2); border-radius: var(--radius-md);
      min-height: 240px; height: min(70vh, 640px);
    }
    .lb-stage img { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: var(--radius-md); }
    .lb-empty { color: var(--text-3); font-size: 0.8rem; display: inline-flex; gap: 6px; align-items: center; }
    /* Centrado sin transform: el button:active global (scale) lo pisaba, la flecha saltaba 18px al
       apretarla y el click terminaba afuera del botón (con el mouse no pasaba de foto). */
    .lb-nav {
      position: absolute; top: calc(50% - 18px);
      width: 36px; height: 36px; padding: 0; border-radius: 50%;
      border: 0.5px solid var(--border-strong); background: var(--surface); color: var(--text);
      cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 18px;
    }
    .lb-nav.prev { left: 10px; }
    .lb-nav.next { right: 10px; }
    .lb-count {
      position: absolute; bottom: 8px; left: 50%; transform: translateX(-50%);
      font-size: 11px; color: var(--text-2); background: var(--surface);
      border: 0.5px solid var(--border); border-radius: 999px; padding: 1px 8px;
    }
    .lb-strip { display: flex; gap: 6px; overflow-x: auto; }
    .lb-mini {
      flex-shrink: 0; width: 52px; height: 52px; padding: 0; cursor: pointer;
      border: 1.5px solid transparent; border-radius: var(--radius-sm); background: var(--surface-2); overflow: hidden;
    }
    .lb-mini.on { border-color: var(--brand); }
    .lb-mini img { width: 100%; height: 100%; object-fit: cover; display: block; }
  `],
})
export class PhotoLightboxComponent implements OnInit {
  readonly photos = input<string[]>([]);
  readonly title = input('');
  readonly subtitle = input<string | null>(null);
  readonly startIndex = input(0);
  readonly closed = output<void>();

  /** Sin repetidas: con la misma URL dos veces, la flecha "pasaba" a una foto idéntica. */
  readonly list = computed(() => [...new Set(this.photos().filter(Boolean))]);
  readonly index = signal(0);
  readonly current = computed(() => this.list()[Math.min(this.index(), Math.max(this.list().length - 1, 0))] ?? null);

  /** La foto inicial se fija una sola vez al abrir: nada que re-renderice el padre la vuelve a pisar. */
  ngOnInit(): void {
    this.index.set(Math.min(Math.max(this.startIndex(), 0), Math.max(this.list().length - 1, 0)));
  }

  step(delta: number): void {
    const n = this.list().length;
    if (n < 2) return;
    this.index.set((this.index() + delta + n) % n);
  }

  @HostListener('document:keydown', ['$event'])
  onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') this.closed.emit();
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      // Que la flecha no scrollee la página de atrás ni mueva otro control con foco.
      e.preventDefault();
      this.step(e.key === 'ArrowRight' ? 1 : -1);
    }
  }
}
