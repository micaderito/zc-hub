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
    syncThemeColor(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* localStorage no disponible: el tema vive solo en memoria */
    }
  }
}

/** Color de la barra de estado en la app instalada (PWA): el fondo de la barra lateral/superior. */
export const THEME_COLORS: Record<Theme, string> = { light: '#ffffff', dark: '#171a22' };

/**
 * index.html trae un theme-color por esquema del sistema; si la usuaria eligió otro tema en el hub,
 * los dos pasan a ser el del hub.
 */
export function syncThemeColor(theme: Theme): void {
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', THEME_COLORS[theme]));
}
