import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class GlobalErrorService {
  /** Mensaje de error actual; null si no hay error. */
  readonly message = signal<string | null>(null);

  show(error: string): void {
    this.message.set(error || 'Error desconocido');
  }

  clear(): void {
    this.message.set(null);
  }
}
