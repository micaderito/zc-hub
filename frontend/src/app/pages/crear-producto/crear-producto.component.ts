import { Component, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  Channel,
  MappingMode,
  MlAttribute,
  OverrideField,
  ProductDraft,
  ProductVariant,
  PublishResult,
  emptyDraft,
  inherited,
  listingTypeLabel,
  projectionLabel
} from './product-draft.model';

let variantSeq = 1;

@Component({
  selector: 'app-crear-producto',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './crear-producto.component.html',
  styleUrl: './crear-producto.component.scss'
})
export class CrearProductoComponent {
  readonly draft = signal<ProductDraft>(this.seedDraft());

  /** Resultado de "Publicar en ambos" (null = todavía no se publicó). */
  readonly publishResults = signal<PublishResult[] | null>(null);
  readonly publishing = signal(false);

  protected readonly listingTypeLabel = listingTypeLabel;

  readonly hasVariants = computed(() => this.draft().axes.length > 0);

  readonly mlProjection = computed(() =>
    projectionLabel('ml', this.draft().ml.mappingMode, this.draft().variants.length)
  );
  readonly tnProjection = computed(() =>
    projectionLabel('tn', this.draft().tn.mappingMode, this.draft().variants.length)
  );

  /** Datos de ejemplo para arrancar (se reemplaza por formulario vacío en producción). */
  private seedDraft(): ProductDraft {
    const d = emptyDraft();
    d.common = {
      baseName: 'Cuaderno A4 Tapa Dura',
      sku: 'CUA-A4-TD',
      brand: 'Zona Cuaderno',
      barcode: '7791234567890',
      condition: 'new',
      weightG: 480,
      lengthCm: 30,
      widthCm: 22,
      heightCm: 3,
      seoKeywords: 'cuaderno, tapa dura, a4, anillado, oficina'
    };
    d.ml = {
      ...d.ml,
      title: { inherited: false, value: 'Cuaderno A4 Tapa Dura Premium Anillado 480g' },
      categoryId: 'MLA1652',
      categoryName: 'Cuadernos',
      description: { inherited: false, value: 'Cuaderno premium con tapa rígida. Envío full. Ideal para oficina y estudio.' },
      attributes: [
        { id: 'BRAND', name: 'Marca', value: 'Zona Cuaderno', required: true, inherited: true },
        { id: 'MODEL', name: 'Modelo', value: 'A4-TD', required: true, inherited: false },
        { id: 'COVER_MATERIAL', name: 'Material de la tapa', value: 'Cartón', required: false, inherited: false }
      ],
      images: ['img-ml-1', 'img-ml-2']
    };
    d.tn = {
      ...d.tn,
      nameEs: inherited('Cuaderno A4 Tapa Dura'),
      namePt: 'Caderno A4 Capa Dura',
      handle: 'cuaderno-a4-tapa-dura',
      categories: 'Cuadernos, Oficina',
      seoTitle: 'Cuaderno A4 Tapa Dura | Zona Cuaderno',
      seoDescription: 'Cuaderno premium tapa dura, 480g. Envío a todo el país.',
      tags: 'escolar, oficina',
      description: { inherited: false, value: 'Cuaderno de tapa dura con diseño exclusivo. Personalizá con tu nombre en el checkout.' },
      images: ['img-tn-1']
    };
    return d;
  }

  /* ---------- override-on-demand ---------- */

  /** El valor a mostrar/usar: el propio si fue editado, o el común si hereda. */
  effective(field: OverrideField<string>, common: string): string {
    return field.inherited ? common : field.value;
  }

  /** Marca un campo como propio del canal (copia el común como punto de partida). */
  makeOwn(field: OverrideField<string>, common: string): void {
    field.inherited = false;
    if (!field.value) field.value = common;
    this.touch();
  }

  /** Vuelve a heredar el campo del dato común. */
  revert(field: OverrideField<string>): void {
    field.inherited = true;
    this.touch();
  }

  /* ---------- mapping mode (Opción B) ---------- */

  setMode(channel: Channel, mode: MappingMode): void {
    const d = this.draft();
    if (channel === 'ml') d.ml.mappingMode = mode;
    else d.tn.mappingMode = mode;
    this.touch();
  }

  /* ---------- variantes ---------- */

  addAxis(): void {
    const d = this.draft();
    if (d.axes.length >= 3) return;
    d.axes.push({ name: '' });
    for (const v of d.variants) v.values.push('');
    if (d.variants.length === 0) this.addVariant();
    this.touch();
  }

  removeAxis(index: number): void {
    const d = this.draft();
    d.axes.splice(index, 1);
    for (const v of d.variants) v.values.splice(index, 1);
    if (d.axes.length === 0) d.variants = [];
    this.touch();
  }

  addVariant(): void {
    const d = this.draft();
    const variant: ProductVariant = {
      id: `v${variantSeq++}`,
      sku: '',
      values: d.axes.map(() => ''),
      ml: { price: null, stock: null },
      tn: { price: null, promoPrice: null, stock: null }
    };
    d.variants.push(variant);
    this.touch();
  }

  removeVariant(id: string): void {
    const d = this.draft();
    d.variants = d.variants.filter((v) => v.id !== id);
    this.touch();
  }

  /* ---------- atributos ML ---------- */

  addMlAttribute(): void {
    const d = this.draft();
    const attr: MlAttribute = { id: '', name: '', value: '', required: false, inherited: false };
    d.ml.attributes.push(attr);
    this.touch();
  }

  removeMlAttribute(index: number): void {
    const d = this.draft();
    d.ml.attributes.splice(index, 1);
    this.touch();
  }

  /* ---------- imágenes (placeholder hasta integrar el uploader real) ---------- */

  addImage(channel: Channel): void {
    const d = this.draft();
    const list = channel === 'ml' ? d.ml.images : d.tn.images;
    list.push(`img-${channel}-${list.length + 1}`);
    this.touch();
  }

  removeImage(channel: Channel, index: number): void {
    const d = this.draft();
    const list = channel === 'ml' ? d.ml.images : d.tn.images;
    list.splice(index, 1);
    this.touch();
  }

  /* ---------- publicar ---------- */

  /** Por ahora simula la respuesta de cada canal. Se conecta a POST /products en el backend. */
  publish(): void {
    this.publishing.set(true);
    this.publishResults.set(null);
    const payload = this.buildPayloads();
    // El backend hará el fan-out real; acá dejamos el payload listo para inspección.
    // eslint-disable-next-line no-console
    console.log('POST /products payload', payload);
    setTimeout(() => {
      this.publishing.set(false);
      this.publishResults.set([
        { channel: 'ml', status: 'ok', detail: 'Publicación MLA-1182 creada' },
        { channel: 'tn', status: 'ok', detail: 'Producto #90431 creado' }
      ]);
    }, 600);
  }

  /** Arma los dos payloads (forma cercana a lo que espera cada API). */
  buildPayloads(): { common: ProductDraft['common']; ml: unknown; tn: unknown } {
    const d = this.draft();
    const dims =
      d.common.lengthCm && d.common.widthCm && d.common.heightCm && d.common.weightG
        ? `${d.common.lengthCm}x${d.common.widthCm}x${d.common.heightCm},${d.common.weightG}`
        : null;
    return {
      common: d.common,
      ml: {
        mapping_mode: d.ml.mappingMode,
        title: this.effective(d.ml.title, d.common.baseName),
        category_id: d.ml.categoryId,
        listing_type_id: d.ml.listingType,
        currency_id: d.ml.currency,
        condition: d.common.condition,
        buying_mode: 'buy_it_now',
        description: { plain_text: this.effective(d.ml.description, '') },
        attributes: [
          ...d.ml.attributes.map((a) => ({ id: a.id, value_name: a.value })),
          { id: 'SELLER_SKU', value_name: d.common.sku }
        ],
        sale_terms: [
          { id: 'WARRANTY_TYPE', value_name: d.ml.warrantyType },
          { id: 'WARRANTY_TIME', value_name: d.ml.warrantyTime }
        ],
        shipping: {
          mode: d.ml.shippingMode,
          free_shipping: d.ml.freeShipping,
          local_pick_up: d.ml.localPickup,
          dimensions: dims
        },
        pictures: d.ml.images.map((src) => ({ source: src }))
      },
      tn: {
        mapping_mode: d.tn.mappingMode,
        name: { es: this.effective(d.tn.nameEs, d.common.baseName), pt: d.tn.namePt || undefined },
        handle: d.tn.handle ? { es: d.tn.handle } : undefined,
        description: { es: this.effective(d.tn.description, '') },
        categories: d.tn.categories,
        brand: d.common.brand,
        seo_title: d.tn.seoTitle,
        seo_description: d.tn.seoDescription,
        tags: d.tn.tags,
        free_shipping: d.tn.freeShipping,
        video_url: d.tn.videoUrl || undefined,
        variants: this.tnVariants()
      }
    };
  }

  private tnVariants(): unknown[] {
    const d = this.draft();
    const weightKg = d.common.weightG != null ? d.common.weightG / 1000 : null;
    if (d.variants.length === 0) {
      return [
        {
          sku: d.common.sku,
          barcode: d.common.barcode,
          weight: weightKg,
          width: d.common.widthCm,
          height: d.common.heightCm,
          depth: d.common.lengthCm
        }
      ];
    }
    return d.variants.map((v) => ({
      sku: v.sku,
      values: v.values.map((value, i) => ({ es: `${d.axes[i]?.name ?? ''}: ${value}` })),
      price: v.tn.price,
      promotional_price: v.tn.promoPrice,
      stock: v.tn.stock,
      weight: weightKg
    }));
  }

  dismissResults(): void {
    this.publishResults.set(null);
  }

  retry(channel: Channel): void {
    const results = this.publishResults();
    if (!results) return;
    this.publishResults.set(
      results.map((r) =>
        r.channel === channel ? { ...r, status: 'ok', detail: r.channel === 'ml' ? 'Publicación creada' : 'Producto creado' } : r
      )
    );
  }

  /** Fuerza una nueva referencia de la señal tras mutar el draft en sitio. */
  private touch(): void {
    this.draft.set({ ...this.draft() });
  }
}
