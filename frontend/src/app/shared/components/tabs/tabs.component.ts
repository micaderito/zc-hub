import { Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface TabDef {
  key: string;
  label: string;
  count?: number;
  countVariant?: 'ok' | 'warn' | 'err';
}

@Component({
  selector: 'zc-tabs',
  standalone: true,
  imports: [CommonModule],
  styleUrl: './tabs.component.scss',
  template: `
    <div class="tabs" role="tablist">
      @for (tab of tabs(); track tab.key) {
        <button
          type="button"
          role="tab"
          [class.active]="activeKey() === tab.key"
          [attr.aria-selected]="activeKey() === tab.key"
          (click)="tabChange.emit(tab.key)"
        >
          {{ tab.label }}
          @if (tab.count !== undefined) {
            <span class="tab-count" [class.ok]="tab.countVariant === 'ok'" [class.warn]="tab.countVariant === 'warn'" [class.err]="tab.countVariant === 'err'">
              {{ tab.count }}
            </span>
          }
        </button>
      }
    </div>
  `,
})
export class TabsComponent {
  readonly tabs = input.required<TabDef[]>();
  readonly activeKey = input.required<string>();
  readonly tabChange = output<string>();
}
