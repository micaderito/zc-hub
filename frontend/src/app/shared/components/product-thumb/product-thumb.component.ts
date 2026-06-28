import { Component, input } from '@angular/core';

@Component({
  selector: 'zc-product-thumb',
  standalone: true,
  template: `
    @if (src()) {
      <img [src]="src()" alt="" class="thumb-img" />
    } @else {
      <span class="thumb-placeholder" aria-hidden="true">
        <i class="ti ti-photo-off"></i>
      </span>
    }
  `,
  styles: [`
    :host { display: contents; }

    .thumb-img,
    .thumb-placeholder {
      width: var(--thumb-size, 36px);
      height: var(--thumb-size, 36px);
      border-radius: var(--radius-sm);
      flex-shrink: 0;
    }

    .thumb-img {
      object-fit: cover;
      display: block;
    }

    .thumb-placeholder {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: var(--surface-2);
      color: var(--text-3);
      font-size: 0.8rem;
    }
  `],
})
export class ProductThumbComponent {
  readonly src = input<string | null | undefined>();
}
