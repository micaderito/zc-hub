import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ApiService } from './api.service';

/** Un usuario del hub (sin roles). No incluye la contraseña — nunca sale del backend. */
export interface AppUser {
  id: number;
  username: string;
  displayName: string | null;
  activo: boolean;
  tokenVersion: number;
  lastLoginAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AppUserInput {
  username: string;
  displayName?: string | null;
  activo?: boolean;
  /** Alta: requerida. Edición: opcional (vacío/undefined = no cambiarla). */
  password?: string;
}

@Injectable({ providedIn: 'root' })
export class UsuariosService {
  private readonly http = inject(HttpClient);
  private readonly api = inject(ApiService);

  getAll() {
    return this.http.get<{ items: AppUser[] }>(`${this.api.baseUrl}/users`);
  }

  create(input: AppUserInput) {
    return this.http.post<{ ok: boolean; item: AppUser }>(`${this.api.baseUrl}/users`, input);
  }

  update(id: number, input: AppUserInput) {
    return this.http.put<{ ok: boolean; item: AppUser }>(`${this.api.baseUrl}/users/${id}`, input);
  }

  /** Sube token_version: invalida todos los tokens ya emitidos para ese usuario. */
  cerrarSesiones(id: number) {
    return this.http.post<{ ok: boolean }>(`${this.api.baseUrl}/users/${id}/cerrar-sesiones`, {});
  }

  delete(id: number) {
    return this.http.delete<{ ok: boolean }>(`${this.api.baseUrl}/users/${id}`);
  }
}
