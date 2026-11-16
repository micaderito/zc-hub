import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs';

/** Cada cuánto se pregunta si hay un deploy nuevo mientras la app está abierta. */
export const UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000;
/** Volver a la app después de este tiempo afuera cuenta como "abrirla de nuevo": se actualiza sola. */
export const UPDATE_AWAY_RELOAD_MS = 10 * 60 * 1000;

/**
 * Hace que la app instalada (PWA) tome cada deploy sin reinstalar nada.
 *
 * El service worker de Angular baja la versión nueva en segundo plano. Cuando está lista:
 * - si la usuaria todavía no tocó nada (la app recién abre) o vuelve después de un rato afuera,
 *   recarga sola;
 * - si la está usando, muestra un aviso ("Actualizar") en vez de recargar: así no se pierde un
 *   formulario a medio cargar.
 */
@Injectable({ providedIn: 'root' })
export class AppUpdateService {
  private readonly sw = inject(SwUpdate);
  private readonly destroyRef = inject(DestroyRef);

  /** Hay una versión nueva descargada esperando que se recargue. */
  readonly updateReady = signal(false);

  private interacted = false;
  private hiddenAt: number | null = null;
  private started = false;

  /** Se llama una vez al arrancar la app. Sin service worker (dev, tests) no hace nada. */
  start(): void {
    if (this.started || !this.sw.isEnabled) return;
    this.started = true;

    const versionSub = this.sw.versionUpdates
      .pipe(filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY'))
      .subscribe(() => {
        if (!this.interacted || document.visibilityState === 'hidden') this.reload();
        else this.updateReady.set(true);
      });
    // La versión en caché quedó rota (el servidor ya no tiene sus archivos): solo queda recargar.
    const brokenSub = this.sw.unrecoverable.subscribe(() => this.reload());

    const markInteracted = () => (this.interacted = true);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        this.hiddenAt = Date.now();
        return;
      }
      const away = this.hiddenAt === null ? 0 : Date.now() - this.hiddenAt;
      this.hiddenAt = null;
      if (this.updateReady() && away >= UPDATE_AWAY_RELOAD_MS) {
        this.reload();
        return;
      }
      void this.check();
    };
    window.addEventListener('pointerdown', markInteracted, { once: true });
    window.addEventListener('keydown', markInteracted, { once: true });
    document.addEventListener('visibilitychange', onVisibility);
    const timer = setInterval(() => void this.check(), UPDATE_CHECK_INTERVAL_MS);

    this.destroyRef.onDestroy(() => {
      versionSub.unsubscribe();
      brokenSub.unsubscribe();
      window.removeEventListener('pointerdown', markInteracted);
      window.removeEventListener('keydown', markInteracted);
      document.removeEventListener('visibilitychange', onVisibility);
      clearInterval(timer);
    });

    void this.check();
  }

  /** Botón "Actualizar" del aviso. */
  async apply(): Promise<void> {
    try {
      await this.sw.activateUpdate();
    } finally {
      this.reload();
    }
  }

  private async check(): Promise<void> {
    try {
      await this.sw.checkForUpdate();
    } catch {
      /* sin red: se vuelve a intentar en el próximo chequeo */
    }
  }

  /** Aparte para poder espiarlo en los tests (location.reload no se puede reemplazar). */
  reload(): void {
    document.location.reload();
  }
}
