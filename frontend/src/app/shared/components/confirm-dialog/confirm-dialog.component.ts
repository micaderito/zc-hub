import { Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';

export type ConfirmDialogVariant = 'warn' | 'danger';

@Component({
  selector: 'zc-confirm-dialog',
  standalone: true,
  imports: [CommonModule],
  styleUrl: './confirm-dialog.component.scss',
  template: `
    <div class="zc-confirm-backdrop" (click)="cancelled.emit()">
      <div class="zc-confirm-card" (click)="$event.stopPropagation()" role="dialog" aria-modal="true">
        <div class="zc-confirm-head" [class.danger]="variant() === 'danger'">
          <i class="ti" [class]="icon()" aria-hidden="true"></i>
          <h2>{{ title() }}</h2>
        </div>
        <div class="zc-confirm-body">
          @if (message()) {
            <p>{{ message() }}</p>
          } @else {
            <ng-content></ng-content>
          }
        </div>
        <div class="zc-confirm-actions">
          <button type="button" class="zc-btn" (click)="cancelled.emit()">{{ cancelLabel() }}</button>
          <button type="button" class="zc-btn primary" [class.danger]="variant() === 'danger'" (click)="confirmed.emit()">{{ confirmLabel() }}</button>
        </div>
      </div>
    </div>
  `,
})
export class ConfirmDialogComponent {
  readonly title = input.required<string>();
  /** Mensaje simple. Para contenido con formato (negritas, pipes, etc.) omitilo y usá content projection. */
  readonly message = input<string>('');
  readonly confirmLabel = input('Confirmar');
  readonly cancelLabel = input('Cancelar');
  readonly variant = input<ConfirmDialogVariant>('warn');
  readonly icon = input('ti-alert-triangle');

  readonly confirmed = output<void>();
  readonly cancelled = output<void>();
}
