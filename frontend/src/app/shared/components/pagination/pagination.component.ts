import { Component, input, output } from '@angular/core';

@Component({
  selector: 'zc-pagination',
  standalone: true,
  styleUrl: './pagination.component.scss',
  template: `
    @if (totalPages() > 1) {
      <nav class="pagination" aria-label="Paginación">
        <button
          type="button"
          class="page-btn zc-btn"
          (click)="prev.emit()"
          [disabled]="currentPage() === 1"
          aria-label="Página anterior"
        >
          <i class="ti ti-chevron-left" aria-hidden="true"></i>
        </button>

        <div class="page-info">
          <span class="page-current">{{ currentPage() }}</span>
          <span class="page-sep">de</span>
          <span class="page-total">{{ totalPages() }}</span>
          <span class="page-results">({{ total() }} resultado{{ total() !== 1 ? 's' : '' }})</span>
        </div>

        <button
          type="button"
          class="page-btn zc-btn"
          (click)="next.emit()"
          [disabled]="currentPage() === totalPages()"
          aria-label="Página siguiente"
        >
          <i class="ti ti-chevron-right" aria-hidden="true"></i>
        </button>
      </nav>
    }
  `,
})
export class PaginationComponent {
  readonly currentPage = input.required<number>();
  readonly totalPages = input.required<number>();
  readonly total = input.required<number>();

  readonly prev = output<void>();
  readonly next = output<void>();
}
