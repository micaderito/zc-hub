import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AppUpdateService } from '../../../core/services/app-update.service';

/** Aviso flotante "Hay una versión nueva" cuando un deploy llega mientras se usa la app. */
@Component({
  selector: 'zc-update-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (updates.updateReady()) {
      <div class="ub" role="status">
        <i class="ti ti-refresh" aria-hidden="true"></i>
        <span class="ub-text">Hay una versión nueva del hub.</span>
        <button type="button" class="ub-btn" (click)="updates.apply()">Actualizar</button>
      </div>
    }
  `,
  styles: [`
    .ub {
      position: fixed;
      z-index: 1000;
      left: 50%;
      /* En el celu, arriba de la barra de pestañas (que ya incluye el área segura). */
      bottom: calc(16px + max(var(--zc-tabbar-h, 0px), env(safe-area-inset-bottom)));
      transform: translateX(-50%);
      width: max-content;
      max-width: calc(100vw - 32px);
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 10px 10px 14px;
      background: var(--surface);
      color: var(--text);
      border: 0.5px solid var(--border);
      border-radius: 12px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.16);
      font-size: 13px;
    }
    .ti { color: var(--brand); font-size: 18px; }
    .ub-text { flex: 1; }
    .ub-btn {
      min-height: 36px;
      padding: 0 14px;
      border: none;
      border-radius: 8px;
      background: var(--brand);
      color: #fff;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }
  `]
})
export class UpdateBannerComponent {
  readonly updates = inject(AppUpdateService);
}
