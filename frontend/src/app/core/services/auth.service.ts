import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ApiService } from './api.service';

export interface AuthStatus {
  mercadolibre: boolean;
  /** true cuando había tokens pero están vencidos o la API devolvió 401 */
  mercadolibreExpired?: boolean;
  tiendanube: boolean;
  tiendanubeExpired?: boolean;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  constructor(
    private http: HttpClient,
    private api: ApiService
  ) {}

  getStatus() {
    return this.http.get<AuthStatus>(`${this.api.baseUrl}/auth/status`);
  }

  getMercadoLibreAuthUrl() {
    return this.http.get<{ url: string }>(`${this.api.baseUrl}/auth/mercadolibre/url`);
  }

  disconnectMercadoLibre() {
    return this.http.post<{ ok: boolean }>(`${this.api.baseUrl}/auth/mercadolibre/disconnect`, {});
  }

  getTiendaNubeAuthUrl() {
    return this.http.get<{ url: string }>(`${this.api.baseUrl}/auth/tiendanube/url`);
  }

  disconnectTiendaNube() {
    return this.http.post<{ ok: boolean }>(`${this.api.baseUrl}/auth/tiendanube/disconnect`, {});
  }
}
