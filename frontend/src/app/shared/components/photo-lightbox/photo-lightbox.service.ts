import {
  ApplicationRef, ComponentRef, EnvironmentInjector, Injectable, createComponent, inject,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { NavigationStart, Router } from '@angular/router';
import { PhotoLightboxComponent } from './photo-lightbox.component';

export interface PhotoLightboxOptions {
  photos: string[];
  title?: string;
  subtitle?: string | null;
  startIndex?: number;
}

/**
 * Abre el zoom de fotos colgado directo de `<body>`, no adentro del componente que lo pide. Así
 * funciona aunque la miniatura esté dentro de un botón, un `<label>` o un modal: un click en el zoom
 * no le llega a la fila de atrás (abrir el detalle, tildar el checkbox) y ningún `transform` de un
 * ancestro le corre el `position: fixed`. Uno solo a la vez; se cierra solo al cambiar de página.
 */
@Injectable({ providedIn: 'root' })
export class PhotoLightboxService {
  private readonly appRef = inject(ApplicationRef);
  private readonly env = inject(EnvironmentInjector);
  private readonly doc = inject(DOCUMENT);
  private ref: ComponentRef<PhotoLightboxComponent> | null = null;

  constructor() {
    inject(Router, { optional: true })?.events.subscribe((e) => {
      if (e instanceof NavigationStart) this.close();
    });
  }

  get isOpen(): boolean {
    return !!this.ref;
  }

  open(opts: PhotoLightboxOptions): void {
    this.close();
    const ref = createComponent(PhotoLightboxComponent, { environmentInjector: this.env });
    ref.setInput('photos', opts.photos);
    ref.setInput('title', opts.title ?? '');
    ref.setInput('subtitle', opts.subtitle ?? null);
    ref.setInput('startIndex', opts.startIndex ?? 0);
    ref.instance.closed.subscribe(() => this.close());
    this.appRef.attachView(ref.hostView);
    this.doc.body.appendChild(ref.location.nativeElement);
    ref.changeDetectorRef.detectChanges();
    this.ref = ref;
  }

  close(): void {
    const ref = this.ref;
    if (!ref) return;
    this.ref = null;
    this.appRef.detachView(ref.hostView);
    ref.destroy();
    (ref.location.nativeElement as HTMLElement).remove();
  }
}
