import { Directive, TemplateRef, ViewContainerRef, effect, inject } from '@angular/core';
import { SessionService } from '../../core/services/session.service';

/**
 * `*zcCanWrite`: dibuja el bloque solo si el usuario puede modificar cosas (rol admin). Es el patrón
 * único para esconder botones de crear/editar/borrar a un usuario de lectura. El backend igual
 * rechaza sus escrituras (403 `read_only`): esto es para no mostrarle botones que no puede usar.
 */
@Directive({ selector: '[zcCanWrite]', standalone: true })
export class CanWriteDirective {
  private readonly tpl = inject(TemplateRef<unknown>);
  private readonly vcr = inject(ViewContainerRef);
  private readonly session = inject(SessionService);
  private shown = false;

  constructor() {
    // Primer render sincrónico (como un *ngIf): si esperara al effect, el bloque recién se crearía
    // después del change detection del padre y quedaría un ciclo sin bindings.
    this.render(this.session.isAdmin());
    // Después, reacciona si el rol cambia (ej. al restaurar la sesión).
    effect(() => this.render(this.session.isAdmin()));
  }

  private render(show: boolean) {
    if (show && !this.shown) this.vcr.createEmbeddedView(this.tpl);
    else if (!show && this.shown) this.vcr.clear();
    this.shown = show;
  }
}
