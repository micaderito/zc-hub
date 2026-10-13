import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { EditOp } from '../../../../core/services/publication-edits.service';
import { PublishUnit } from '../../../../core/services/catalog.service';
import { ConfirmDialogComponent } from '../../../../shared/components/confirm-dialog/confirm-dialog.component';
import { ProductDraftStore } from '../../product-draft.store';

/**
 * Panel "Cambios a aplicar" del modo edición (Publicaciones → Editar publicación): qué se le va a
 * mandar a cada publicación de ML y TN si se guarda, calculado en el backend contra cómo estaba al
 * abrirla (publicationDiff.js). Lo que no se tocó no aparece y no se manda.
 */
@Component({
  selector: 'zc-edit-review',
  standalone: true,
  imports: [DatePipe, ConfirmDialogComponent],
  styleUrls: ['../section-shared.scss', './edit-review.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="zc-card block edit-review" aria-labelledby="er-title">
      <div class="block-head">
        <i class="ti ti-list-check"></i>
        <span class="block-title" id="er-title">Cambios a aplicar</span>
        @if (store.editPlanLoading()) { <i class="ti ti-loader-2 spin er-spin" aria-label="Calculando"></i> }
        <span class="er-saved">
          @if (store.draftSavedAt()) { Edición guardada {{ store.draftSavedAt()! | date: 'shortTime' }} } @else { Se guarda sola mientras editás }
        </span>
      </div>
      <p class="er-hint">Se manda solo lo que cambiaste, a cada publicación. Lo demás queda como está en Mercado Libre y Tienda Nube.</p>

      @if (store.editSavePhase() !== 'idle') {
        <div class="er-save" [class]="'is-' + store.editSavePhase()" role="status">
          <span class="er-save-head">
            @switch (store.editSavePhase()) {
              @case ('running') { <i class="ti ti-loader-2 spin"></i> Guardando… ({{ totals().done }} de {{ totals().total }}) <span class="er-note">podés cerrar esta pestaña, sigue en el servidor</span> }
              @case ('done') { <i class="ti ti-circle-check"></i> Cambios guardados en {{ channelsLabel() }} }
              @case ('error') { <i class="ti ti-alert-triangle"></i> Se guardó con errores: {{ totals().ok }} de {{ totals().total }} cambios aplicados }
              @case ('cancelled') { <i class="ti ti-ban"></i> Guardado cancelado: {{ totals().ok }} de {{ totals().total }} cambios aplicados }
              @case ('unknown') { <i class="ti ti-alert-circle"></i> No pudimos confirmar cómo va el guardado <span class="er-note">sigue en el servidor</span> }
            }
          </span>
          @if (totals().total) {
            <span class="er-bar" role="progressbar" [attr.aria-valuenow]="totals().done" aria-valuemin="0" [attr.aria-valuemax]="totals().total">
              <span [style.width.%]="(totals().done / totals().total) * 100"></span>
            </span>
          }
          <ul>
            @for (row of saveRows(); track row.op.key) {
              <li [class.ok]="row.unit?.status === 'ok'" [class.err]="row.unit?.status === 'error'">
                <span class="er-st">
                  @if (row.unit?.status === 'ok') { <i class="ti ti-check"></i> }
                  @else if (row.unit?.status === 'error') { <i class="ti ti-x"></i> }
                  @else { <i class="ti ti-clock"></i> }
                </span>
                <span class="er-op">
                  {{ row.op.label }}
                  @if (row.unit?.status === 'error') { <span class="er-fail">{{ row.unit?.detail }}</span> }
                  @else if (row.unit?.status === 'ok' && row.unit?.detail && row.unit?.detail !== 'Listo') { <span class="er-detail">{{ row.unit?.detail }}</span> }
                </span>
                <span class="er-target" [class.ml]="row.op.channel === 'ml'" [class.tn]="row.op.channel === 'tn'">{{ row.op.targetLabel }}</span>
              </li>
            }
          </ul>
        </div>
      }

      @if (store.editConfirmRemote(); as changed) {
        <div class="er-confirm" role="alert">
          <p>
            <i class="ti ti-alert-triangle"></i>
            Desde que empezaste a editar cambió
            @for (c of changed; track c.channel + c.id; let last = $last) { <strong>{{ c.name }}</strong> ({{ c.channel === 'ml' ? 'ML' : 'TN' }}){{ last ? '' : ', ' }} }
            en el canal (puede ser una venta, que mueve el stock). Se mandan solo tus cambios; si tocaste lo mismo, gana lo tuyo.
          </p>
          <div class="er-actions">
            <button type="button" class="zc-btn" (click)="store.editConfirmRemote.set(null)">Revisar primero</button>
            <button type="button" class="zc-btn primary" (click)="store.applyEditChanges(true)">Guardar igual</button>
          </div>
        </div>
      }

      @if (store.editSavePhase() === 'idle') {
      @if (store.editPlanError()) {
        <p class="er-error" role="alert">{{ store.editPlanError() }}</p>
      }

      @if (ops().length === 0) {
        <p class="er-empty">Todavía no cambiaste nada.</p>
      } @else {
        @for (g of groups(); track g.channel) {
          <div class="er-group">
            <span class="er-group-title"><span class="dot" [class.dot-ml]="g.channel === 'ml'" [class.dot-tn]="g.channel === 'tn'"></span>{{ g.title }} · {{ g.ops.length }}</span>
            <ul>
              @for (op of g.ops; track op.key) {
                <li>
                  <span class="er-op">
                    {{ op.label }}
                    @if (op.warn) { <span class="er-warn"><i class="ti ti-alert-triangle"></i> {{ op.warn }}</span> }
                  </span>
                  <span class="er-target" [class.ml]="op.channel === 'ml'" [class.tn]="op.channel === 'tn'">{{ op.targetLabel }}</span>
                </li>
              }
            </ul>
          </div>
        }
      }

      <div class="er-actions">
        <button type="button" class="zc-btn" (click)="confirmDiscard.set(true)">
          <i class="ti ti-trash"></i> Descartar edición
        </button>
        <button type="button" class="zc-btn primary" [disabled]="!ops().length || store.hasPendingUploads() || !!store.editConfirmRemote()" (click)="save.emit()">
          <i class="ti ti-device-floppy"></i> {{ saveLabel() }}
        </button>
      </div>
      } @else {
        <div class="er-actions">
          @switch (store.editSavePhase()) {
            @case ('running') { <button type="button" class="zc-btn" (click)="store.cancelSave()"><i class="ti ti-x"></i> Cancelar lo que falta</button> }
            @case ('unknown') { <button type="button" class="zc-btn primary" (click)="store.retrySavePoll()"><i class="ti ti-refresh"></i> Actualizar</button> }
            @case ('done') { <button type="button" class="zc-btn primary" (click)="finished.emit()"><i class="ti ti-arrow-left"></i> Volver al producto</button> }
            @default {
              <button type="button" class="zc-btn" (click)="finished.emit()">Cerrar sin reintentar</button>
              <button type="button" class="zc-btn primary" (click)="store.retrySave()"><i class="ti ti-refresh"></i> Reintentar lo que falló</button>
            }
          }
        </div>
      }
    </section>

    @if (confirmDiscard()) {
      <zc-confirm-dialog
        title="¿Descartar esta edición?"
        message="Se pierden los cambios que todavía no guardaste. Las publicaciones de Mercado Libre y Tienda Nube quedan como están."
        confirmLabel="Descartar"
        variant="danger"
        icon="ti-trash"
        (confirmed)="confirmDiscard.set(false); discard.emit()"
        (cancelled)="confirmDiscard.set(false)"
      />
    }
  `,
})
export class EditReviewComponent {
  protected readonly store = inject(ProductDraftStore);

  readonly save = output<void>();
  readonly discard = output<void>();
  /** Terminó (o se acepta cómo quedó): cerrar la edición y volver al producto. */
  readonly finished = output<void>();
  readonly confirmDiscard = signal(false);

  /** Cada operación que se está guardando, con el resultado de su unidad del job. */
  readonly saveRows = computed(() => {
    const units = new Map<string, PublishUnit>(this.store.editSaveUnits().map((u) => [`${u.channel}:${u.unitKey}`, u]));
    return this.store.editSaveOps().map((op) => ({ op, unit: units.get(`${op.channel}:${op.key}`) ?? null }));
  });
  readonly totals = computed(() => {
    const rows = this.saveRows();
    const ok = rows.filter((r) => r.unit?.status === 'ok').length;
    const err = rows.filter((r) => r.unit?.status === 'error').length;
    return { total: rows.length, ok, err, done: ok + err };
  });
  readonly channelsLabel = computed(() => {
    const chs = [...new Set(this.store.editSaveOps().map((o) => (o.channel === 'ml' ? 'Mercado Libre' : 'Tienda Nube')))];
    return chs.join(' y ');
  });

  readonly ops = computed<EditOp[]>(() => this.store.editOps());
  readonly groups = computed(() =>
    (['ml', 'tn'] as const)
      .map((channel) => ({ channel, title: channel === 'ml' ? 'Mercado Libre' : 'Tienda Nube', ops: this.ops().filter((o) => o.channel === channel) }))
      .filter((g) => g.ops.length)
  );
  readonly saveLabel = computed(() => {
    const chs = this.groups().map((g) => (g.channel === 'ml' ? 'ML' : 'TN'));
    return chs.length ? `Guardar en ${chs.join(' y ')}` : 'Guardar';
  });
}
