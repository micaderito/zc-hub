import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { environment } from '../../../../environments/environment';

interface Deployed {
  version: string | null;
  sha: string | null;
}

/** "__X__" sin reemplazar (build sin CI) = no hay dato. */
const clean = (v: string | undefined) => (v && !v.startsWith('__') ? v : '');

/**
 * Versión deployada en el pie del menú: la del front (inyectada en el build de CI) y la del backend
 * (`GET /health`, de Railway). Si no coinciden, uno de los dos todavía no terminó de deployar.
 */
@Component({
  selector: 'zc-app-version',
  standalone: true,
  imports: [DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="app-version" [class.mismatch]="mismatch()" [title]="tooltip()">
      @if (mismatch()) { <i class="ti ti-alert-triangle"></i> }
      @if (compact()) {
        {{ front().version || front().sha || 'local' }}
      } @else if (mismatch()) {
        Front {{ front().version || front().sha }} · Back {{ back()!.version || back()!.sha }}
      } @else {
        Versión {{ front().version || front().sha || 'local' }}
        @if (front().date) { <span class="muted">· {{ front().date | date: 'dd/MM HH:mm' }}</span> }
      }
    </div>
  `,
  styles: `
    .app-version {
      font-size: 0.6875rem;
      color: var(--text-3);
      padding: 0 0.5rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      text-align: center;
    }
    .app-version.mismatch { color: var(--warn); }
    .muted { opacity: 0.8; }
  `,
})
export class AppVersionComponent {
  readonly compact = input(false);

  readonly front = signal({
    version: clean(environment.build?.version),
    sha: clean(environment.build?.sha),
    date: clean(environment.build?.date),
  });
  readonly back = signal<Deployed | null>(null);

  /** Solo cuando los dos saben su commit y no es el mismo. */
  readonly mismatch = computed(() => {
    const b = this.back();
    const f = this.front();
    return !!(b?.sha && f.sha && b.sha !== f.sha);
  });

  readonly tooltip = computed(() => {
    const f = this.front();
    const b = this.back();
    const front = `Front: ${f.version || '—'} (${f.sha || 'local'}${f.date ? `, ${new Date(f.date).toLocaleString('es-AR')}` : ''})`;
    const back = `Back: ${b?.version || '—'} (${b?.sha || 'sin dato'})`;
    const extra = this.mismatch() ? ' — no son la misma versión: uno de los dos todavía está deployando' : '';
    return `${front} · ${back}${extra}`;
  });

  constructor() {
    fetch(`${environment.apiUrl}/health`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && this.back.set({ version: j.version ?? null, sha: j.sha ?? null }))
      .catch(() => {});
  }
}
