import { Component, input, output, model } from '@angular/core';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'zc-search-bar',
  standalone: true,
  imports: [FormsModule],
  styleUrl: './search-bar.component.scss',
  template: `
    <div class="search-bar">
      <i class="ti ti-search search-icon" aria-hidden="true"></i>
      <input
        type="text"
        [ngModel]="value()"
        (ngModelChange)="value.set($event)"
        [placeholder]="placeholder()"
        class="search-input"
        [attr.aria-label]="ariaLabel()"
      />
      @if (value()) {
        <button type="button" class="search-clear" (click)="value.set('')" aria-label="Limpiar búsqueda">
          <i class="ti ti-x" aria-hidden="true"></i>
        </button>
      }
    </div>
  `,
})
export class SearchBarComponent {
  readonly value = model('');
  readonly placeholder = input('Buscar…');
  readonly ariaLabel = input('Buscar');
}
