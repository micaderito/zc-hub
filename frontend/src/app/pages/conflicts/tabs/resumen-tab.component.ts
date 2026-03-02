import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ConflictAnalysis } from '../../../core/services/conflicts.service';

@Component({
  selector: 'app-conflicts-resumen-tab',
  standalone: true,
  imports: [CommonModule],
  styleUrls: ['./_conflicts-tabs-styles.scss'],
  template: `
    <section>
      <p>Coincidencias (mismo SKU en ML y TN): {{ analysis.matched.length }}. Ver la pestaña <strong>Coincidencias</strong> para listarlos y editarlos. Los que además están en Precio y stock ya están listos para sincronizar.</p>
      <p>Solo en ML / Solo en TN: son SKUs que existen en una plataforma pero no en la otra. Resolvelos <strong>vinculando manualmente</strong> (elegís esta publicación de ML = esta variante de TN y asignás un SKU).</p>
      <p>Sin SKU: productos que no tienen SKU en ML o TN. Podés <strong>editar el SKU</strong> en la plataforma y después vincular, o vincular y marcar "Actualizar SKU en ambas plataformas".</p>
      <p>Duplicados: el mismo SKU está usado por varios ítems en una plataforma. <strong>Editá el SKU</strong> en cada uno para que sean únicos por producto/variante.</p>
    </section>
  `
})
export class ResumenTabComponent {
  @Input({ required: true }) analysis!: ConflictAnalysis;
}
