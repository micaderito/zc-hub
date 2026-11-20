import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ConflictAnalysis, MlRow, TnRow } from '../../../core/services/conflicts.service';
import { ConflictsPhoneComponent } from './conflicts-phone.component';

const ml = (id: string, title: string, sku: string | null): MlRow =>
  ({ type: 'ml', itemId: id, variationId: null, title, sku, hasSku: !!sku, thumbnail: null }) as MlRow;
const tn = (id: number, name: string, sku: string | null): TnRow =>
  ({ type: 'tn', productId: id, variantId: id, productName: name, sku, hasSku: !!sku, thumbnail: null }) as TnRow;

function analysis(): ConflictAnalysis {
  return {
    mlConnected: true,
    tnConnected: true,
    summary: { matched: 2, onlyML: 1, onlyTN: 1, noSkuML: 1, noSkuTN: 0, duplicateSkuML: 1, duplicateSkuTN: 0, resolved: 0 },
    matched: [
      { ml: ml('M1', 'Cuaderno rayado', 'R1'), tn: tn(1, 'Cuaderno rayado', 'R1'), sku: 'R1' },
      { ml: ml('M2', 'Cuaderno liso', 'L1'), tn: tn(2, 'Cuaderno liso', 'L1'), sku: 'L1' },
    ],
    onlyML: [ml('M3', 'Agenda negra', 'BP700N')],
    onlyTN: [tn(3, 'Lapicera azul', 'LAP-AZ')],
    noSkuML: [ml('M4', 'Repuesto 96 hojas', null)],
    noSkuTN: [],
    duplicateSkuML: [{ sku: '39000', items: [ml('M5', 'Mármol rayado', '39000'), ml('M6', 'Mármol cuadriculado', '39000')] }],
    duplicateSkuTN: [],
    mappings: [],
    paging: { page: 1, limit: 25, total: 0, pages: 1 },
  };
}

describe('ConflictsPhoneComponent', () => {
  let fixture: ComponentFixture<ConflictsPhoneComponent>;
  let c: ConflictsPhoneComponent;
  let el: HTMLElement;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ConflictsPhoneComponent] });
    fixture = TestBed.createComponent(ConflictsPhoneComponent);
    c = fixture.componentInstance;
    fixture.componentRef.setInput('analysis', analysis());
    fixture.detectChanges();
    el = fixture.nativeElement;
  });

  const sectionTitles = () => Array.from(el.querySelectorAll('.cp-h')).map((h) => h.textContent?.replace(/\s+/g, ' ').trim());

  it('cuenta por problema y separa la lista en secciones; lo que coincide va al final', () => {
    expect(Array.from(el.querySelectorAll('.cp-tile b')).map((b) => b.textContent)).toEqual(['2', '1', '1']);
    expect(sectionTitles()).toEqual(['Sin par en el otro canal 2', 'Sin SKU 1', 'SKU duplicado 1']);
    expect(el.querySelector('.cp-matched')?.textContent).toContain('2 pares coinciden');
  });

  it('tocar un número filtra y tocarlo de nuevo vuelve a todo', () => {
    (el.querySelectorAll<HTMLButtonElement>('.cp-tile')[2]).click();
    fixture.detectChanges();
    expect(sectionTitles()).toEqual(['SKU duplicado 1']);
    c.toggle('dup');
    fixture.detectChanges();
    expect(sectionTitles().length).toBe(3);
  });

  it('busca en el navegador por título o SKU', () => {
    c.search.set('lapicera');
    fixture.detectChanges();
    expect(sectionTitles()).toEqual(['Sin par en el otro canal 1']);
    expect(el.textContent).toContain('Lapicera azul');
    expect(el.textContent).not.toContain('Agenda negra');
  });

  it('"N pares coinciden" abre la lista de pares', () => {
    (el.querySelector('.cp-matched .cp-row') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(c.filter()).toBe('matched');
    expect(el.textContent).toContain('Cuaderno rayado');
  });

  it('la hoja de un producto sin par emite Editar SKU y Vincular para su canal', () => {
    const linked: TnRow[] = [];
    const edited: string[] = [];
    c.linkFromTn.subscribe((r) => linked.push(r));
    c.editSku.subscribe((e) => edited.push(e.channel));

    const lapicera = Array.from(el.querySelectorAll<HTMLButtonElement>('.cp-row')).find((r) => r.textContent?.includes('Lapicera'))!;
    lapicera.click();
    fixture.detectChanges();
    expect(el.querySelector('zc-bottom-sheet')?.textContent).toContain('Solo en Tienda Nube');
    const btn = (t: string) => Array.from(el.querySelectorAll<HTMLButtonElement>('zc-bottom-sheet button')).find((b) => b.textContent?.includes(t))!;
    btn('Vincular').click();
    expect(linked.map((r) => r.productId)).toEqual([3]);
    expect(c.open()).toBeNull();

    lapicera.click();
    fixture.detectChanges();
    btn('Editar SKU').click();
    expect(edited).toEqual(['tiendanube']);
  });

  it('un duplicado se resuelve con la edición en lote y un par con los dos SKU', () => {
    let bulk = '';
    let both = '';
    c.bulkEditSku.subscribe((e) => (bulk = e.sku));
    c.editBothSku.subscribe((e) => (both = e.ml.itemId));

    const dup = c['allItems']().find((i) => i.kind === 'dup')!;
    c.doEdit(dup);
    expect(bulk).toBe('39000');

    const pair = c['allItems']().find((i) => i.kind === 'pair')!;
    c.doEdit(pair);
    expect(both).toBe('M1');
  });

  it('sin nada por resolver lo dice', () => {
    fixture.componentRef.setInput('analysis', { ...analysis(), onlyML: [], onlyTN: [], noSkuML: [], duplicateSkuML: [] });
    fixture.detectChanges();
    expect(el.querySelector('.cp-empty')?.textContent).toContain('Todo vinculado');
  });
});
