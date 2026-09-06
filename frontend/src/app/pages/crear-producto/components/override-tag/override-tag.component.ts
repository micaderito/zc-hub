import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { OverrideField } from '../../product-draft.model';

/** Chip "del común" / "propio" del patrón override-on-demand (ver docs/STYLEGUIDE.md §6). */
@Component({
  selector: 'zc-override-tag',
  standalone: true,
  template: `
    @if (field().inherited) {
      <span class="tag tag-com"><i class="ti ti-link"></i> del común</span>
    } @else {
      <span class="tag tag-own"><i class="ti ti-pencil"></i> propio</span>
    }
  `,
  styles: [`
    :host { display: contents; }
    .tag {
      font-size: 0.62rem;
      font-weight: 500;
      padding: 0.05rem 0.4rem;
      border-radius: 5px;
      display: inline-flex;
      align-items: center;
      gap: 0.2rem;
      i { font-size: 0.7rem; }
      &.tag-com { background: var(--surface-2); color: var(--text-3); }
      &.tag-own { background: var(--brand-bg); color: var(--brand); }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class OverrideTagComponent {
  readonly field = input.required<OverrideField<string>>();
}
