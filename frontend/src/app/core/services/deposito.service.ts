import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ApiService } from './api.service';

export type DepositoItemType = 'producto' | 'embalaje';

/** Una fila de stock guardado en el depósito Marañón, aparte de lo publicado en ML/TN. */
export interface DepositoItem {
  id: number;
  sku: string | null;
  label: string;
  itemType: DepositoItemType;
  quantity: number;
  unit: string;
  notes: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface DepositoItemInput {
  sku?: string | null;
  label: string;
  itemType: DepositoItemType;
  quantity: number;
  unit: string;
  notes?: string | null;
}

@Injectable({ providedIn: 'root' })
export class DepositoService {
  private readonly http = inject(HttpClient);
  private readonly api = inject(ApiService);

  getAll() {
    return this.http.get<{ items: DepositoItem[] }>(`${this.api.baseUrl}/deposito`);
  }

  create(input: DepositoItemInput) {
    return this.http.post<{ ok: boolean; item: DepositoItem }>(`${this.api.baseUrl}/deposito`, input);
  }

  update(id: number, input: DepositoItemInput) {
    return this.http.put<{ ok: boolean; item: DepositoItem }>(`${this.api.baseUrl}/deposito/${id}`, input);
  }

  /** Ajuste rápido de cantidad (+1/-1 desde la tabla). */
  adjust(id: number, delta: number) {
    return this.http.patch<{ ok: boolean; item: DepositoItem }>(`${this.api.baseUrl}/deposito/${id}/ajustar`, { delta });
  }

  delete(id: number) {
    return this.http.delete<{ ok: boolean }>(`${this.api.baseUrl}/deposito/${id}`);
  }
}
