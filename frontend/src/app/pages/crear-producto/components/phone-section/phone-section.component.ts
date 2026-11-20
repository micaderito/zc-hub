import { ChangeDetectionStrategy, Component, ViewEncapsulation, input, output } from '@angular/core';

/**
 * Tarjeta plegable de una sección de Crear producto en el CELULAR (prototipo
 * `docs/prototype/crear-producto-mobile.html`, opción B). Cerrada muestra el título, un resumen de
 * una línea y si le falta algo; abierta, la sección de siempre (proyectada) sin su propio
 * encabezado ni su borde de tarjeta, para no repetirlos.
 *
 * Fuera del celular (`phone = false`) no dibuja nada propio (`display: contents`): la sección se ve
 * exactamente como en el escritorio. Cerrada, la sección sigue montada (solo se esconde): así no se
 * pierde nada a medio cargar ni se vuelven a pedir sus datos al reabrirla.
 *
 * Sin encapsulación porque aplana la tarjeta de la sección proyectada (`.zc-card.block`), que es de
 * otro componente; todo queda bajo `.zc-psec.is-phone`, así que en el escritorio no aplica.
 */
@Component({
  selector: 'zc-phone-section',
  standalone: true,
  styleUrl: './phone-section.component.scss',
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'zc-psec',
    '[class.is-phone]': 'phone()',
    '[class.is-open]': 'open()',
    '[class.acc-ml]': "accent() === 'ml'",
    '[class.acc-tn]': "accent() === 'tn'",
  },
  template: `
    @if (phone()) {
      <button type="button" class="psec-head" (click)="toggle.emit()" [attr.aria-expanded]="open()">
        <span class="psec-title">
          @if (accent()) {
            <span class="psec-dot" [class.ml]="accent() === 'ml'" [class.tn]="accent() === 'tn'" aria-hidden="true"></span>
          } @else if (icon()) {
            <i class="ti {{ icon() }}" aria-hidden="true"></i>
          }
          <b>{{ title() }}</b>
          <span class="psec-sum" [class.warn]="missing() > 0">{{ summary() }}</span>
        </span>
        @if (missing() > 0) {
          <span class="psec-miss" [attr.aria-label]="'Faltan ' + missing()"><i class="ti ti-alert-triangle" aria-hidden="true"></i>{{ missing() }}</span>
        } @else if (complete()) {
          <i class="ti ti-circle-check psec-ok" aria-label="Completa"></i>
        }
        <i class="ti psec-chev" [class.ti-chevron-down]="!open()" [class.ti-chevron-up]="open()" aria-hidden="true"></i>
      </button>
    }
    <div class="psec-body">
      <ng-content />
    </div>
  `,
})
export class PhoneSectionComponent {
  readonly phone = input(false);
  readonly open = input(false);
  readonly title = input.required<string>();
  readonly icon = input<string | null>(null);
  readonly accent = input<'ml' | 'tn' | null>(null);
  /** Una línea con lo cargado; si falta algo, lo primero que falta. */
  readonly summary = input('');
  /** Cuántos faltantes para publicar son de esta sección. */
  readonly missing = input(0);
  /** Mostrar el ✓ cuando no falta nada (en Editar publicación no hay "completa"). */
  readonly complete = input(false);
  readonly toggle = output<void>();
}
