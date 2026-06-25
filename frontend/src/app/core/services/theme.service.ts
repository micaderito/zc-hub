import { Injectable, signal } from '@angular/core';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'zc-theme';

/** Maneja el tema claro/oscuro: lo persiste en localStorage y lo aplica en <html data-theme>. */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  /** Tema actual. Inicializado desde el atributo que setea el script no-FOUC en index.html. */
  readonly theme = signal<Theme>(this.readInitial());

  private readInitial(): Theme {
    const attr = document.documentElement.getAttribute('data-theme');
    return attr === 'dark' ? 'dark' : 'light';
  }

  toggle(): void {
    this.set(this.theme() === 'dark' ? 'light' : 'dark');
  }

  set(theme: Theme): void {
    this.theme.set(theme);
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* localStorage no disponible: el tema vive solo en memoria */
    }
  }
}
