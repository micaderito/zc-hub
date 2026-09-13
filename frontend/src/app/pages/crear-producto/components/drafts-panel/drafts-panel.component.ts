import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { ProductDraftStore } from '../../product-draft.store';

/** A partir de acá se avisa que el storage está por llenarse (deja margen para subir fotos de un producto más antes de bloquearse). */
const STORAGE_WARN_PERCENT = 85;
/** A partir de acá el aviso pasa a tono crítico (queda muy poco lugar). */
const STORAGE_CRITICAL_PERCENT = 90;

/** Panel "Mis borradores": abrir, eliminar, ver cuál se está editando y avisar si el storage de imágenes está por llenarse. */
@Component({
  selector: 'zc-drafts-panel',
  standalone: true,
  imports: [DatePipe, DecimalPipe],
  templateUrl: './drafts-panel.component.html',
  styleUrls: ['../section-shared.scss', './drafts-panel.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DraftsPanelComponent {
  protected readonly store = inject(ProductDraftStore);

  protected readonly storageWarnLevel = computed<'ok' | 'warn' | 'critical'>(() => {
    const percent = this.store.storageUsage()?.percent ?? 0;
    if (percent >= STORAGE_CRITICAL_PERCENT) return 'critical';
    if (percent >= STORAGE_WARN_PERCENT) return 'warn';
    return 'ok';
  });

  protected readonly storageUsedMb = computed(() => (this.store.storageUsage()?.usedBytes ?? 0) / (1024 * 1024));
  protected readonly storageLimitMb = computed(() => (this.store.storageUsage()?.limitBytes ?? 0) / (1024 * 1024));
}
