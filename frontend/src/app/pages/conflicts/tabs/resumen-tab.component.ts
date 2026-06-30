import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ConflictAnalysis } from '../../../core/services/conflicts.service';

@Component({
  selector: 'app-conflicts-resumen-tab',
  standalone: true,
  imports: [CommonModule],
  styleUrls: ['./_conflicts-tabs-styles.scss'],
  template: `
    <div class="resumen-grid">
      <div class="resumen-item item-ok">
        <div class="resumen-icon"><i class="ti ti-link" aria-hidden="true"></i></div>
        <div class="resumen-title">Coincidencias ({{ analysis.matched.length }})</div>
        <div class="resumen-desc">SKU idéntico en ML y TN. Estos pares ya están listos para sincronizar precios y stock.</div>
      </div>
      <div class="resumen-item item-warn">
        <div class="resumen-icon"><i class="ti ti-arrows-diff" aria-hidden="true"></i></div>
        <div class="resumen-title">Solo en un canal ({{ analysis.onlyML.length + analysis.onlyTN.length }})</div>
        <div class="resumen-desc">El SKU existe en ML o en TN pero no en el otro. Vinculá manualmente eligiendo el par correspondiente.</div>
      </div>
      <div class="resumen-item item-warn">
        <div class="resumen-icon"><i class="ti ti-tag-off" aria-hidden="true"></i></div>
        <div class="resumen-title">Sin SKU ({{ analysis.noSkuML.length + analysis.noSkuTN.length }})</div>
        <div class="resumen-desc">Sin SKU no podemos emparejar. Asigná un SKU desde la pestaña o vinculá directamente.</div>
      </div>
      <div class="resumen-item item-warn">
        <div class="resumen-icon"><i class="ti ti-copy" aria-hidden="true"></i></div>
        <div class="resumen-title">SKU duplicados ({{ analysis.duplicateSkuML.length + analysis.duplicateSkuTN.length }})</div>
        <div class="resumen-desc">Varios ítems comparten el mismo SKU. Asigná un SKU único a cada uno para que el mapeo funcione.</div>
      </div>
    </div>
  `
})
export class ResumenTabComponent {
  @Input({ required: true }) analysis!: ConflictAnalysis;
}
