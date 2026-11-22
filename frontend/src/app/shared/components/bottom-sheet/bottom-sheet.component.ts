import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/**
 * Hoja que sube desde abajo (celular). Encabezado con título/subtítulo y cruz; lo de adentro va por
 * content projection, y un `[sheet-lead]` opcional a la izquierda del título (ícono o foto).
 * Tocar el fondo o la cruz emite `closed`: quien la abre decide cuándo deja de renderizarla.
 * Con `dialog`, fuera del celular (> 760px) se ve como un diálogo centrado: así el mismo contenido
 * sirve en la tablet y la compu sin duplicar el formulario.
 */
@Component({
  selector: 'zc-bottom-sheet',
  standalone: true,
  styleUrl: './bottom-sheet.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bs-scrim" (click)="closed.emit()"></div>
    <div class="bs-panel" role="dialog" aria-modal="true" [attr.aria-label]="title()">
      <div class="bs-grab" aria-hidden="true"></div>
      <div class="bs-head">
        <ng-content select="[sheet-lead]" />
        <div class="bs-title">
          <b>{{ title() }}</b>
          @if (subtitle()) { <span>{{ subtitle() }}</span> }
        </div>
        <button type="button" class="bs-x" (click)="closed.emit()" aria-label="Cerrar"><i class="ti ti-x" aria-hidden="true"></i></button>
      </div>
      <div class="bs-body"><ng-content /></div>
    </div>
  `,
  host: { '(document:keydown.escape)': 'closed.emit()', '[class.as-dialog]': 'dialog()' },
})
export class BottomSheetComponent {
  readonly title = input.required<string>();
  readonly subtitle = input<string | null>(null);
  readonly dialog = input(false);
  readonly closed = output<void>();
}
