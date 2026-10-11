import { Injectable, Injector, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';

/**
 * Sesión de usuario del hub (login con usuario/contraseña + rol). NO confundir con
 * AuthService (core/services/auth.service.ts), que es la conexión OAuth de la cuenta comercial a
 * Mercado Libre/Tienda Nube — algo completamente distinto que ya existía con ese nombre.
 */
/** 'admin' hace todo; 'lectura' solo ve (el backend rechaza sus escrituras con 403 `read_only`). */
export type UserRole = 'admin' | 'lectura';

export interface SessionUser {
  id: number;
  username: string;
  displayName: string | null;
  role: UserRole;
}

const TOKEN_KEY = 'zc-token';

@Injectable({ providedIn: 'root' })
export class SessionService {
  // HttpClient se resuelve recién al usarlo: `*zcCanWrite` inyecta este servicio en casi todas las
  // pantallas solo para leer el rol, y así no arrastra HttpClient a cada componente (ni a sus specs).
  private readonly injector = inject(Injector);
  private get http() { return this.injector.get(HttpClient); }
  private get api() { return this.injector.get(ApiService); }

  private readonly _token = signal<string | null>(localStorage.getItem(TOKEN_KEY));
  private readonly _user = signal<SessionUser | null>(null);

  readonly token = this._token.asReadonly();
  readonly user = this._user.asReadonly();
  readonly isAuthenticated = computed(() => !!this._token());
  /** Sin dato de rol (sesión vieja todavía sin restaurar) se asume admin: el backend es la guarda real. */
  readonly isAdmin = computed(() => (this._user()?.role ?? 'admin') === 'admin');
  readonly isReadOnly = computed(() => !this.isAdmin());

  private setSession(token: string, user: SessionUser) {
    localStorage.setItem(TOKEN_KEY, token);
    this._token.set(token);
    this._user.set(user);
  }

  clear() {
    localStorage.removeItem(TOKEN_KEY);
    this._token.set(null);
    this._user.set(null);
  }

  async login(username: string, password: string): Promise<void> {
    const res = await firstValueFrom(
      this.http.post<{ token: string; user: SessionUser }>(`${this.api.baseUrl}/session/login`, { username, password })
    );
    this.setSession(res.token, res.user);
  }

  logout() {
    // Stateless del lado servidor (no hay nada que invalidar sin subir token_version); el POST es
    // best-effort, no bloquea el logout local si falla.
    firstValueFrom(this.http.post(`${this.api.baseUrl}/session/logout`, {})).catch(() => {});
    this.clear();
  }

  /**
   * Restaura la sesión al arrancar la app (F5): si hay un token guardado, lo valida contra el
   * backend y trae los datos del usuario. Se usa desde un provideAppInitializer para que corra
   * ANTES del primer guard de ruta — si no, un F5 rebota a /login aunque el token sea válido.
   */
  async restore(): Promise<void> {
    if (!this._token()) return;
    try {
      const res = await firstValueFrom(
        this.http.get<{ user: SessionUser; token?: string }>(`${this.api.baseUrl}/session/me`)
      );
      if (res.token) {
        localStorage.setItem(TOKEN_KEY, res.token);
        this._token.set(res.token);
      }
      this._user.set(res.user);
    } catch {
      // Token vencido/inválido/usuario desactivado: no queda logueada con una sesión rota.
      this.clear();
    }
  }

  async changePassword(actual: string, nueva: string): Promise<void> {
    const res = await firstValueFrom(
      this.http.post<{ ok: boolean; token: string }>(`${this.api.baseUrl}/session/password`, { actual, nueva })
    );
    localStorage.setItem(TOKEN_KEY, res.token);
    this._token.set(res.token);
  }
}
