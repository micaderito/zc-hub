import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ApiService } from './api.service';

/** Valores fijos del motor de precios (Ajustes). Precargados con los del Excel, editables. */
export interface PricingSettings {
  commissionPct: number;
  taxes: number;
  shippingCost: number;
  freeShippingThreshold: number;
  cardMultiplier: number;
  roundStep: number;
  defaultMarginPct: number;
  defaultDiscount1: number;
  defaultDiscount2: number;
}

/** Un tramo de comisión fija de ML. maxPrice null = tramo superior (sin tope). */
export interface MlFeeTier {
  maxPrice: number | null;
  fixedFee: number;
}

export interface PricingConfig {
  settings: PricingSettings;
  tiers: MlFeeTier[];
  updatedAt: string | null;
}

/** Resultado de sincronizar comisiones con la API de ML. */
export interface MlFeesSync {
  remote: { commissionPct: number | null; tiers: MlFeeTier[]; probes: Array<{ price: number; fixedFee: number }>; fetchedAt: string };
  current: { commissionPct: number; tiers: MlFeeTier[] };
  applied: boolean;
  config?: PricingConfig;
}

/** El costo cargado de un producto (bulto o unidad). */
export interface ProductCost {
  sku: string;
  source: 'manual' | 'list';
  bulkPrice: number | null;
  bulkQty: number | null;
  unitCost: number | null;
  discount1: number | null;
  discount2: number | null;
  marginOverride: number | null;
  label: string | null;
  updatedAt: string | null;
}

/** El pack al que pertenece un SKU (si tiene), para agrupar la planilla. */
export interface PreviewRowPack {
  packId: number;
  name: string;
  sku: string | null;
  unitCount: number;
  mode: 'assorted' | 'single';
  modelCount: number;
}

/** Una fila del preview: costo + precios calculados + estado de mapeo. */
export interface PreviewRow {
  sku: string;
  label: string | null;
  source: 'manual' | 'list';
  /** Unidades por bulto (de la lista del proveedor), para ver cómo se llegó al costo unitario. */
  bulkQty: number | null;
  unitCost: number;
  valorFinal: number;
  /** `list` es el calculado; `override` el ajuste manual (null = no hay); `effective` es lo que se aplica. */
  tn: { transfer: number; list: number; override: number | null; effective: number };
  /** Calculado. El ajuste manual va en mlOverride/mlEffective. */
  ml: number;
  mlOverride: number | null;
  mlEffective: number;
  mlNet: number;
  currentMl: number | null;
  currentTn: number | null;
  freeShipping: boolean;
  mappedMl: boolean;
  mappedTn: boolean;
  pack: PreviewRowPack | null;
}

/** Una fila del historial de precios de un producto. */
export interface PriceAuditRow {
  id: number;
  sku: string;
  channel: 'mercadolibre' | 'tiendanube';
  /** Puede ser null si el snapshot no tenía la fila cuando se aplicó el cambio. */
  priceBefore: number | null;
  priceAfter: number;
  source: 'bulk' | 'manual';
  productLabel: string | null;
  createdAt: string;
}

export interface PriceHistoryResponse {
  rows: PriceAuditRow[];
  total: number;
}

/** Una fila parseada de la lista del proveedor. */
export interface ParsedListRow {
  code: string | null;
  description: string | null;
  unitPrice: number | null;
  bulkQty: number | null;
  bulkPrice: number | null;
  fractionable: boolean;
  inheritedCode: boolean;
  valid: boolean;
  issues: string[];
}

/** Sugerencia de mapeo para un SKU (o un pack) que todavía no tiene código confirmado. */
export interface MappingSuggestion {
  sku: string;
  label?: string | null;
  /** true si esta entidad es un PACK (sku = su código propio): confirmarla aplica el costo a TODOS sus memberSkus. */
  isPack?: boolean;
  packId?: number | null;
  memberSkus?: string[];
  suggestion: {
    code: string;
    matchSource: 'exact' | 'saved' | 'base' | 'group' | 'text';
    score: number;
    auto: boolean;
  } | null;
}

export interface ImportPreview {
  stats: { total: number; valid: number; flagged: number };
  rows: ParsedListRow[];
  flagged: ParsedListRow[];
  mapping: { auto: number; review: MappingSuggestion[]; unmatched: number };
}

export interface MappingState {
  mapped: Array<{ sku: string; code: string; matchSource: string; confirmedAt: string | null }>;
  packMapped: Array<{ packId: number; code: string; matchSource: string; confirmedAt: string | null; packName: string | null; packSku: string | null; memberSkus: string[] }>;
  skusWithoutCode: string[];
  packsWithoutCode: Array<{ id: number; name: string; sku: string | null }>;
  codesWithoutSku: Array<{ code: string; description: string | null }>;
  totals: { codes: number; skus: number; mapped: number };
}

export interface ImportedList {
  id: number;
  label: string;
  sourceFilename: string | null;
  discount1: number;
  discount2: number;
  importedAt: string | null;
  itemCount: number;
}

export interface ApplyResult {
  total: number;
  enqueuedMl: number;
  appliedTn: number;
  failed: number;
  results: Array<{ sku: string; channel?: 'ml' | 'tn'; ok: boolean; reason?: string; taskId?: number; price?: number }>;
}

@Injectable({ providedIn: 'root' })
export class PricingService {
  private readonly http = inject(HttpClient);
  private readonly api = inject(ApiService);

  getConfig() {
    return this.http.get<PricingConfig>(`${this.api.baseUrl}/pricing/config`);
  }

  saveConfig(patch: Partial<PricingSettings> & { tiers?: MlFeeTier[] }) {
    return this.http.put<PricingConfig>(`${this.api.baseUrl}/pricing/config`, patch);
  }

  /**
   * Trae las comisiones reales de la API de ML. apply=false solo compara; apply=true además las
   * guarda en Ajustes.
   */
  syncMlFees(apply = false) {
    return this.http.post<MlFeesSync>(`${this.api.baseUrl}/pricing/ml-fees/sync`, { apply });
  }

  getPreview() {
    return this.http.get<{ rows: PreviewRow[] }>(`${this.api.baseUrl}/pricing/preview`);
  }

  saveCost(sku: string, data: Partial<ProductCost>) {
    return this.http.put<{ ok: boolean; cost: ProductCost }>(`${this.api.baseUrl}/pricing/cost/${encodeURIComponent(sku)}`, data);
  }

  deleteCost(sku: string) {
    return this.http.delete<{ ok: boolean }>(`${this.api.baseUrl}/pricing/cost/${encodeURIComponent(sku)}`);
  }

  apply(skus: string[], channels: { ml: boolean; tn: boolean } = { ml: true, tn: true }) {
    return this.http.post<ApplyResult>(`${this.api.baseUrl}/pricing/apply`, { skus, channels });
  }

  /** Preview de una importación: parsea y sugiere mapeos, sin guardar nada. */
  previewImport(text: string, format: 'pdf' | 'csv' = 'pdf') {
    return this.http.post<ImportPreview>(`${this.api.baseUrl}/pricing/lists/preview`, { text, format });
  }

  /** Confirma la importación: guarda lista, códigos, mapeos automáticos y costos. */
  confirmImport(body: {
    label: string;
    sourceFilename?: string | null;
    discount1: number;
    discount2: number;
    rows: ParsedListRow[];
  }) {
    return this.http.post<{ ok: boolean; listId: number; autoMapped: number; costsUpdated: number; changedSkus: string[] }>(
      `${this.api.baseUrl}/pricing/lists`, body,
    );
  }

  getLists() {
    return this.http.get<{ lists: ImportedList[] }>(`${this.api.baseUrl}/pricing/lists`);
  }

  getMappingState() {
    return this.http.get<MappingState>(`${this.api.baseUrl}/pricing/mapping`);
  }

  confirmMapping(sku: string, code: string, matchSource = 'manual') {
    return this.http.put<{ ok: boolean }>(
      `${this.api.baseUrl}/pricing/mapping/${encodeURIComponent(sku)}`, { code, matchSource },
    );
  }

  removeMapping(sku: string) {
    return this.http.delete<{ ok: boolean }>(`${this.api.baseUrl}/pricing/mapping/${encodeURIComponent(sku)}`);
  }

  /** Confirma (o corrige) el mapeo de un PACK: el costo se aplica a TODOS sus SKUs miembro. */
  confirmPackMapping(packId: number, code: string, matchSource = 'manual') {
    return this.http.put<{ ok: boolean }>(
      `${this.api.baseUrl}/pricing/mapping/pack/${packId}`, { code, matchSource },
    );
  }

  removePackMapping(packId: number) {
    return this.http.delete<{ ok: boolean }>(`${this.api.baseUrl}/pricing/mapping/pack/${packId}`);
  }

  /** Ajuste manual del precio publicado de un SKU en un canal. `value: null` lo saca (vuelve al calculado). */
  saveOverride(sku: string, channel: 'ml' | 'tn', value: number | null) {
    return this.http.put<{ ok: boolean }>(
      `${this.api.baseUrl}/pricing/override/${encodeURIComponent(sku)}`, { channel, value },
    );
  }

  /** Historial de precios de un producto (ambos canales). */
  getPriceHistoryBySku(sku: string, limit = 50, offset = 0) {
    return this.http.get<PriceHistoryResponse>(
      `${this.api.baseUrl}/pricing/history/${encodeURIComponent(sku)}`,
      { params: { limit: String(limit), offset: String(offset) } },
    );
  }
}
