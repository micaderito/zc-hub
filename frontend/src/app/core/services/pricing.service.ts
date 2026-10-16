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

/** Una configuración de descuento de un proveedor (ej. "Agendas −30% −5%"). */
export interface DiscountProfile {
  id: number;
  supplierKey: string;
  name: string;
  discount1: number;
  discount2: number;
  /** La que toma todo lo del proveedor que no tiene una config propia. */
  isDefault: boolean;
  /** Productos con costo que hoy calculan con esta config. */
  productCount: number;
}

export interface Supplier {
  key: string;
  name: string;
  /** Productos que se le compran (vigente o no). */
  productCount: number;
  /** La default primero. */
  profiles: DiscountProfile[];
}

export interface PricingConfig {
  settings: PricingSettings;
  tiers: MlFeeTier[];
  updatedAt: string | null;
  suppliers: Supplier[];
}

/** Un pack (`id` = packId) o un producto suelto (`id` = SKU), destino de una asignación. */
export interface PricingTarget {
  type: 'sku' | 'pack';
  id: string | number;
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
  /** Proveedor vigente (el que manda el costo). */
  supplierKey?: string | null;
  updatedAt: string | null;
}

/** Descuento resuelto de una fila: de qué config sale y a qué nivel está asignada. */
export interface RowDiscount {
  profileId: number | null;
  name: string | null;
  discount1: number;
  discount2: number;
  /** sku = config propia · pack = la del pack · default = la del proveedor · none = sin proveedor. */
  level: 'sku' | 'pack' | 'default' | 'none';
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
  /** Precio del bulto tal cual la lista (bruto); null si el costo se cargó por unidad. */
  bulkPrice: number | null;
  /** Precio por unidad antes del descuento (bulto ÷ unidades). */
  unitListPrice: number | null;
  /** Descuento aplicado (null si el costo es unitario directo). */
  discount: RowDiscount | null;
  /** Proveedor vigente y todos a los que se le compra (el vigente primero). */
  supplierKey: string | null;
  suppliers: string[];
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
    /** Config elegida al importar y a cuántos les tocó; los que ya tenían una propia la conservan. */
    profileName?: string | null;
    withChosenProfile?: number;
    withOwnProfile?: Array<MappingBrief & { profileName: string | null }>;
  };
}

/** Código de un producto en cada proveedor (pestaña Mapeo, vista "Todos"). */
export interface SupplierCodeRef {
  supplierKey: string;
  supplierName: string;
  code: string;
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
  /** Proveedor del código que se muestra, el vigente del producto y los códigos de cada proveedor. */
  codeSupplier?: string | null;
  vigente?: string | null;
  codesBySupplier?: SupplierCodeRef[];
  /** Pack con código propio: sus modelos, con el código del que sale el precio de cada uno. */
  members?: MappingMember[];
  /** En un modelo de pack: `pack` = toma el código del pack, `own` = tiene mapeo propio. */
  codeSource?: 'pack' | 'own' | null;
}

/** Un modelo de un pack con código propio. */
export interface MappingMember {
  key: string;
  sku: string;
  name: string | null;
  code: string | null;
  codeDescription: string | null;
  listLabel: string | null;
  codeSource: 'pack' | 'own' | null;
  matchSource: string | null;
  hasCost: boolean;
  mappedMl: boolean;
  mappedTn: boolean;
  codeSupplier?: string | null;
  vigente?: string | null;
  codesBySupplier?: SupplierCodeRef[];
}

export interface SupplierCode {
  code: string;
  supplierKey?: string | null;
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
  /** Proveedor del mapeo (`null` = vista "Todos", solo lectura). */
  supplierKey?: string | null;
  supplierNames?: Record<string, string>;
  products: MappingProduct[];
  /** Lo que el backend mapeó solo en esta lectura (código igual o `CODIGO-variante`). */
  autoMapped?: { count: number; changedSkus: string[]; items: Array<{ key: string; sku: string; code: string; matchSource: string }> };
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
  supplier?: string;
  supplierName?: string;
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

  saveCost(sku: string, data: Partial<ProductCost> & { profileId?: number | null }) {
    return this.http.put<{ ok: boolean; cost: ProductCost }>(`${this.api.baseUrl}/pricing/cost/${encodeURIComponent(sku)}`, data);
  }

  deleteCost(sku: string) {
    return this.http.delete<{ ok: boolean }>(`${this.api.baseUrl}/pricing/cost/${encodeURIComponent(sku)}`);
  }

  apply(skus: string[], channels: { ml: boolean; tn: boolean } = { ml: true, tn: true }) {
    return this.http.post<ApplyResult>(`${this.api.baseUrl}/pricing/apply`, { skus, channels });
  }

  /** Preview de una importación: parsea y sugiere mapeos, sin guardar nada. */
  previewImport(text: string, format: 'pdf' | 'csv' = 'pdf', supplierKey?: string) {
    return this.http.post<ImportPreview>(`${this.api.baseUrl}/pricing/lists/preview`, { text, format, supplierKey });
  }

  /**
   * Confirma la importación: guarda lista, códigos, mapeos automáticos y costos. `profileId` = la
   * config de descuento para lo de esta lista que no tiene una propia (`null` = la default).
   */
  confirmImport(body: {
    label: string;
    sourceFilename?: string | null;
    supplierKey: string;
    profileId: number | null;
    rows: ParsedListRow[];
  }) {
    return this.http.post<ImportResult>(`${this.api.baseUrl}/pricing/lists`, body);
  }

  getLists() {
    return this.http.get<{ lists: ImportedList[] }>(`${this.api.baseUrl}/pricing/lists`);
  }

  /** Borra una lista importada (y los códigos que ya no estén en ninguna lista ni mapeo). */
  deleteList(id: number) {
    return this.http.delete<{ ok: boolean }>(`${this.api.baseUrl}/pricing/lists/${id}`);
  }

  /** Mapeo de un proveedor (`null` = vista "Todos", solo lectura). */
  getMappingState(supplierKey: string | null = null) {
    const params: Record<string, string> = supplierKey ? { supplier: supplierKey } : {};
    return this.http.get<MappingState>(`${this.api.baseUrl}/pricing/mapping`, { params });
  }

  confirmMapping(sku: string, code: string, matchSource = 'manual', supplierKey?: string) {
    return this.http.put<MappingSaveResult>(
      `${this.api.baseUrl}/pricing/mapping/${encodeURIComponent(sku)}`, { code, matchSource, supplierKey },
    );
  }

  removeMapping(sku: string, supplierKey?: string) {
    return this.http.delete<{ ok: boolean }>(
      `${this.api.baseUrl}/pricing/mapping/${encodeURIComponent(sku)}`, { params: supplierKey ? { supplier: supplierKey } : {} },
    );
  }

  /** Confirma (o corrige) el mapeo de un PACK: el costo se aplica a TODOS sus SKUs miembro. */
  confirmPackMapping(packId: number, code: string, matchSource = 'manual', supplierKey?: string) {
    return this.http.put<MappingSaveResult>(
      `${this.api.baseUrl}/pricing/mapping/pack/${packId}`, { code, matchSource, supplierKey },
    );
  }

  removePackMapping(packId: number, supplierKey?: string) {
    return this.http.delete<{ ok: boolean }>(
      `${this.api.baseUrl}/pricing/mapping/pack/${packId}`, { params: supplierKey ? { supplier: supplierKey } : {} },
    );
  }

  // ── Proveedores y configuraciones de descuento ──

  createSupplier(body: { name: string; discount1?: number; discount2?: number; profileName?: string }) {
    return this.http.post<{ key: string }>(`${this.api.baseUrl}/pricing/suppliers`, body);
  }

  renameSupplier(key: string, name: string) {
    return this.http.put<{ ok: boolean }>(`${this.api.baseUrl}/pricing/suppliers/${encodeURIComponent(key)}`, { name });
  }

  deleteSupplier(key: string) {
    return this.http.delete<{ ok: boolean }>(`${this.api.baseUrl}/pricing/suppliers/${encodeURIComponent(key)}`);
  }

  createProfile(supplierKey: string, body: { name: string; discount1: number; discount2: number }) {
    return this.http.post<{ id: number }>(`${this.api.baseUrl}/pricing/suppliers/${encodeURIComponent(supplierKey)}/profiles`, body);
  }

  updateProfile(id: number, patch: { name?: string; discount1?: number; discount2?: number; isDefault?: true }) {
    return this.http.put<{ ok: boolean }>(`${this.api.baseUrl}/pricing/profiles/${id}`, patch);
  }

  deleteProfile(id: number) {
    return this.http.delete<{ ok: boolean }>(`${this.api.baseUrl}/pricing/profiles/${id}`);
  }

  /** Asignación masiva de una config (`null` = la default) a packs/productos de un proveedor. */
  assignDiscount(supplierKey: string, targets: PricingTarget[], profileId: number | null) {
    return this.http.put<{ ok: boolean; assigned: number }>(`${this.api.baseUrl}/pricing/assignments`, { supplierKey, targets, profileId });
  }

  /** Cambia el proveedor vigente: el costo pasa a salir de la última lista de ese proveedor. */
  setVigente(supplierKey: string, targets: PricingTarget[]) {
    return this.http.put<{ ok: boolean; changedSkus: string[]; withoutPrice: string[] }>(
      `${this.api.baseUrl}/pricing/vigente`, { supplierKey, targets },
    );
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
