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
  /** Precio publicado hoy en cada canal (de la foto del catálogo); null = sin publicación o desconocido. */
  currentMl: number | null;
  currentTn: number | null;
  /** Lo que se aplicaría difiere de lo publicado hoy en ese canal. */
  pendingMl: boolean;
  pendingTn: boolean;
  /** Hay un cambio de precio de ML encolado (se aplicó y la cola todavía no lo escribió). */
  mlQueued: boolean;
  freeShipping: boolean;
  mappedMl: boolean;
  mappedTn: boolean;
  /** Nombre de la publicación (TN o ML). En un pack todos traen la misma descripción de lista en `label`. */
  name: string | null;
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
  /**
   * bulk = Precios (aplicar lista) · manual = edición en Precio y stock · sync = "Sincronizar
   * precios" del Dashboard (ML → TN) · externo = cambiado desde el panel de ML/TN (o una promoción
   * de ML), detectado por webhook.
   */
  source: 'bulk' | 'manual' | 'sync' | 'externo';
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
  /** Nombre de la publicación (solo para mostrar). */
  name?: string | null;
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

/** Un producto o pack, en versión corta, para los resúmenes del import. */
export interface MappingBrief {
  sku: string;
  name: string | null;
  isPack: boolean;
  packId: number | null;
  memberCount: number | null;
  code: string | null;
}

export interface SupplierCodeBrief {
  code: string;
  description: string | null;
}

export interface ImportPreview {
  stats: { total: number; valid: number; flagged: number };
  rows: ParsedListRow[];
  flagged: ParsedListRow[];
  mapping: {
    /** Productos/packs que toman el precio de ESTA lista (código exacto o ya confirmado). */
    auto: number;
    /** Ya tienen código, pero de otra lista: esta no los toca. */
    otherLists: number;
    review: MappingSuggestion[];
    unmatched: number;
    inListItems: MappingBrief[];
    unmatchedItems: MappingBrief[];
    codesWithoutProduct: SupplierCodeBrief[];
  };
}

export interface ImportResult {
  ok: boolean;
  listId: number;
  autoMapped: number;
  newMappings: number;
  costsUpdated: number;
  changedSkus: string[];
  summary: {
    inList: MappingBrief[];
    otherLists: number;
    unmatched: MappingBrief[];
    codesWithoutProduct: SupplierCodeBrief[];
  };
}

/** Un producto (o pack con código propio) de la tienda, con su código del proveedor. */
export interface MappingProduct {
  key: string;
  kind: 'sku' | 'pack';
  sku: string;
  packId: number | null;
  name: string | null;
  memberSkus: string[];
  /** Pack SIN código propio al que pertenece (sus modelos se mapean de a uno). */
  packName: string | null;
  code: string | null;
  codeDescription: string | null;
  /** Lista más reciente que trae el código (de ahí sale el precio). */
  listLabel: string | null;
  matchSource: string | null;
  hasCost: boolean;
  mappedMl: boolean;
  mappedTn: boolean;
}

export interface SupplierCode {
  code: string;
  description: string | null;
  listLabel: string | null;
  mapped: boolean;
}

/** Resultado de mapear un código a mano: el precio se toma en el momento de la lista más reciente. */
export interface MappingSaveResult {
  ok: boolean;
  costsUpdated: number;
  changedSkus: string[];
  listLabel: string | null;
}

export interface MappingState {
  products: MappingProduct[];
  codes: SupplierCode[];
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
    return this.http.post<ImportResult>(`${this.api.baseUrl}/pricing/lists`, body);
  }

  getLists() {
    return this.http.get<{ lists: ImportedList[] }>(`${this.api.baseUrl}/pricing/lists`);
  }

  getMappingState() {
    return this.http.get<MappingState>(`${this.api.baseUrl}/pricing/mapping`);
  }

  confirmMapping(sku: string, code: string, matchSource = 'manual') {
    return this.http.put<MappingSaveResult>(
      `${this.api.baseUrl}/pricing/mapping/${encodeURIComponent(sku)}`, { code, matchSource },
    );
  }

  removeMapping(sku: string) {
    return this.http.delete<{ ok: boolean }>(`${this.api.baseUrl}/pricing/mapping/${encodeURIComponent(sku)}`);
  }

  /** Confirma (o corrige) el mapeo de un PACK: el costo se aplica a TODOS sus SKUs miembro. */
  confirmPackMapping(packId: number, code: string, matchSource = 'manual') {
    return this.http.put<MappingSaveResult>(
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
