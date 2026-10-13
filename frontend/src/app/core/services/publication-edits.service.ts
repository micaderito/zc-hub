import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { lastValueFrom } from 'rxjs';
import { ApiService } from './api.service';

/**
 * Una cosa a cambiar en una publicación concreta al guardar la edición (ver
 * backend/src/services/publicationDiff.js). `targetLabel` es ML-1, TN-2… o "ML nuevo"/"TN nuevo".
 */
export interface EditOp {
  key: string;
  channel: 'ml' | 'tn';
  target: string;
  targetLabel: string;
  kind: string;
  label: string;
  warn?: string;
}

/** Lo que ML no deja cambiar en esta edición, con el motivo (se muestra con candado). */
export type EditLockKey = 'mlTitle' | 'mlCategory' | 'condition' | 'mappingMode';

export interface PublicationEdit {
  id: string;
  groupKey: string;
  name: string | null;
  /** ProductDraft (mismo shape que Crear producto). */
  draft: unknown;
  refs: { channels: { ml: boolean; tn: boolean }; [k: string]: unknown };
  locks: Partial<Record<EditLockKey, string>>;
  notes: string[];
  status: 'editing' | 'saving' | 'done' | 'discarded';
  /** true = se retomó una edición que ya estaba abierta (no se volvió a importar de ML/TN). */
  resumed?: boolean;
  /** Job que está guardando (o guardó con errores) esta edición, con sus operaciones. */
  job?: { id: string; status: 'pending' | 'processing' | 'done' | 'error' | 'cancelled'; lastError: string | null };
  jobOps?: EditOp[];
  createdAt: string;
  updatedAt: string;
}

/** Publicación que alguien cambió en ML/TN desde que se abrió la edición. */
export interface RemoteChange {
  channel: 'ml' | 'tn';
  id: string | number;
  name: string;
}

@Injectable({ providedIn: 'root' })
export class PublicationEditsService {
  private readonly http = inject(HttpClient);
  private readonly api = inject(ApiService);
  private get base() {
    return `${this.api.baseUrl}/publication-edits`;
  }

  /** Abre la edición de un producto del hub (la importa en vivo, o retoma la que estaba abierta). */
  open(groupKey: string): Promise<PublicationEdit> {
    return lastValueFrom(this.http.post<PublicationEdit>(this.base, { groupKey }));
  }

  get(id: string): Promise<PublicationEdit> {
    return lastValueFrom(this.http.get<PublicationEdit>(`${this.base}/${id}`));
  }

  save(id: string, draft: unknown): Promise<{ ok: boolean }> {
    return lastValueFrom(this.http.put<{ ok: boolean }>(`${this.base}/${id}`, { draft }));
  }

  discard(id: string): Promise<{ ok: boolean }> {
    return lastValueFrom(this.http.delete<{ ok: boolean }>(`${this.base}/${id}`));
  }

  plan(id: string, draft?: unknown): Promise<{ ops: EditOp[]; summary: { total: number; ml: number; tn: number } }> {
    return lastValueFrom(this.http.post<{ ops: EditOp[]; summary: { total: number; ml: number; tn: number } }>(`${this.base}/${id}/plan`, draft ? { draft } : {}));
  }

  /**
   * Guarda en ML y TN (en segundo plano). Sin `force`, si la publicación cambió en el canal desde que
   * se abrió la edición responde 409 con `code: 'remote_changed'` y la lista `changed`.
   */
  apply(id: string, draft: unknown, force = false): Promise<{ jobId: string; ops: EditOp[] }> {
    return lastValueFrom(this.http.post<{ jobId: string; ops: EditOp[] }>(`${this.base}/${id}/apply`, { draft, force }));
  }

  /** Cierra una edición ya guardada (con o sin errores): la próxima vez se vuelve a importar. */
  close(id: string): Promise<{ ok: boolean }> {
    return lastValueFrom(this.http.post<{ ok: boolean }>(`${this.base}/${id}/close`, {}));
  }

  remoteCheck(id: string): Promise<{ changed: RemoteChange[] }> {
    return lastValueFrom(this.http.get<{ changed: RemoteChange[] }>(`${this.base}/${id}/remote-check`));
  }
}
