import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { provideTanStackQuery, QueryClient } from '@tanstack/angular-query-experimental';
import { of } from 'rxjs';
import { CatalogService } from '../../core/services/catalog.service';
import { PricingService } from '../../core/services/pricing.service';
import { EditOp, PublicationEdit, PublicationEditsService } from '../../core/services/publication-edits.service';
import { CrearProductoComponent } from './crear-producto.component';
import { emptyDraft } from './product-draft.model';

/**
 * Crear producto en modo edición (Publicaciones → Editar publicación): el mismo form cargado con
 * publicaciones que ya existen. Se autoguarda en la edición (no en "Mis borradores"), muestra lo
 * que ML no deja cambiar y en vez de publicar lista los cambios a aplicar.
 */
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function editFixture(over: Partial<PublicationEdit> = {}): PublicationEdit {
  const draft = emptyDraft();
  draft.common.baseName = 'Cuaderno Rivadavia A4';
  draft.ml.categoryId = '';
  draft.ml.title = { inherited: false, value: 'Cuaderno Rivadavia A4 Tapa Dura' };
  draft.ml.images = [{ id: 'ml-P1', name: 'Foto ML', previewUrl: '', remote: { channel: 'ml', id: 'P1', url: 'https://ml/p1.jpg' } }];
  return {
    id: 'e1',
    groupKey: 'ml:MLA1',
    name: 'Cuaderno Rivadavia A4',
    draft,
    refs: { channels: { ml: true, tn: true } },
    locks: { mlTitle: 'ML no deja cambiar el título de una publicación con ventas (37).', mappingMode: 'No se cambia desde acá.', mlCategory: 'No se cambia.' },
    notes: ['Una variante tenía stock distinto en ML y en TN.'],
    status: 'editing',
    resumed: false,
    createdAt: '2026-10-12T10:00:00Z',
    updatedAt: '2026-10-12T10:00:00Z',
    ...over,
  };
}

class EditsMock {
  edit = editFixture();
  ops: EditOp[] = [];
  open = jasmine.createSpy('open').and.callFake(() => Promise.resolve(this.edit));
  save = jasmine.createSpy('save').and.resolveTo({ ok: true });
  discard = jasmine.createSpy('discard').and.resolveTo({ ok: true });
  plan = jasmine.createSpy('plan').and.callFake(() => Promise.resolve({ ops: this.ops, summary: { total: this.ops.length, ml: 0, tn: 0 } }));
  apply = jasmine.createSpy('apply').and.resolveTo({ jobId: 'j1', ops: [
    { key: 'ml:MLA1:description', channel: 'ml', target: 'MLA1', targetLabel: 'ML-1', kind: 'description', label: 'Cambiar la descripción' },
    { key: 'tn:5:stock:v1', channel: 'tn', target: '5', targetLabel: 'TN-1', kind: 'stock:v1', label: 'Stock de "Rojo"' },
  ] });
  close = jasmine.createSpy('close').and.resolveTo({ ok: true });
  remoteCheck = jasmine.createSpy('remoteCheck').and.resolveTo({ changed: [{ channel: 'ml', id: 'MLA1', name: 'Cuaderno Rivadavia A4' }] });
}

describe('CrearProductoComponent en modo edición', () => {
  let fixture: ComponentFixture<CrearProductoComponent>;
  let component: CrearProductoComponent;
  let edits: EditsMock;
  let catalog: Record<string, jasmine.Spy>;
  let jobResponse: { job: { status: string }; units: { channel: string; unitKey: string; status: string; detail: string | null }[] };

  async function setup(prepare?: (m: EditsMock) => void) {
    jobResponse = {
      job: { status: 'done' },
      units: [
        { channel: 'ml', unitKey: 'ml:MLA1:description', status: 'ok', detail: 'Listo' },
        { channel: 'tn', unitKey: 'tn:5:stock:v1', status: 'ok', detail: 'Listo' },
      ],
    };
    edits = new EditsMock();
    prepare?.(edits);
    catalog = {
      getTiendaNubeCategories: jasmine.createSpy('tn').and.resolveTo([]),
      getMlCategoryAttributes: jasmine.createSpy('attrs').and.resolveTo([]),
      getMlCategory: jasmine.createSpy('cat').and.resolveTo({ max_pictures: 12, max_pictures_per_var: 10 }),
      listDrafts: jasmine.createSpy('listDrafts').and.resolveTo([]),
      createDraft: jasmine.createSpy('createDraft'),
      updateDraft: jasmine.createSpy('updateDraft'),
      getStorageUsage: jasmine.createSpy('storage').and.resolveTo(null),
      getPublishJob: jasmine.createSpy('getPublishJob').and.callFake(() => Promise.resolve(jobResponse)),
      retryPublishJob: jasmine.createSpy('retryPublishJob').and.resolveTo({ ok: true }),
      cancelPublishJob: jasmine.createSpy('cancelPublishJob').and.resolveTo({ ok: true }),
    };
    await TestBed.configureTestingModule({
      imports: [CrearProductoComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideTanStackQuery(new QueryClient({ defaultOptions: { queries: { retry: false } } })),
        { provide: CatalogService, useValue: catalog },
        { provide: PricingService, useValue: { getConfig: () => of(null) } },
        { provide: PublicationEditsService, useValue: edits },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { data: { mode: 'edit' }, paramMap: convertToParamMap({ key: 'ml:MLA1' }), queryParamMap: convertToParamMap({}) } },
        },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(CrearProductoComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  }

  const text = () => (fixture.nativeElement as HTMLElement).textContent ?? '';

  it('abre la edición del producto de la ruta y muestra el form sin lo propio de Crear producto', async () => {
    await setup();
    expect(edits.open).toHaveBeenCalledWith('ml:MLA1');
    expect(component.store.isEdit()).toBeTrue();
    expect(text()).toContain('Editar publicación');
    expect(text()).not.toContain('Mis borradores');
    expect(text()).not.toContain('Publicar en ambos');
    expect(fixture.nativeElement.querySelector('zc-stock-alert-section')).toBeNull();
    expect(text()).toContain('stock distinto en ML y en TN');
    expect(catalog['listDrafts']).not.toHaveBeenCalled();
  });

  it('muestra con candado lo que ML no deja cambiar y no deja cambiar cómo está armado cada canal', async () => {
    await setup();
    expect(text()).toContain('ML no deja cambiar el título de una publicación con ventas (37).');
    expect(fixture.nativeElement.querySelector('.locked-box')).not.toBeNull();
    const modeButtons = fixture.nativeElement.querySelectorAll('.channel-ml .mode-opt, .channel-tn .mode-opt') as NodeListOf<HTMLButtonElement>;
    expect(modeButtons.length).toBe(4);
    modeButtons.forEach((b) => expect(b.disabled).toBeTrue());
    component.store.setMode('ml', 'one_per_variant');
    expect(component.draft().ml.mappingMode).toBe('single_with_variants');
  });

  it('las fotos ya publicadas usan la URL del canal y al autoguardar conservan a qué foto corresponden', async () => {
    await setup();
    const img = component.draft().ml.images[0];
    expect(img.previewUrl).toBe('https://ml/p1.jpg');
    component.draft().common.baseName = 'Otro nombre';
    await component.store.saveDraft({ auto: true });
    expect(edits.save).toHaveBeenCalled();
    const [id, saved] = edits.save.calls.mostRecent().args as [string, any];
    expect(id).toBe('e1');
    expect(saved.ml.images[0]).toEqual({ id: 'ml-P1', name: 'Foto ML', remote: { channel: 'ml', id: 'P1', url: 'https://ml/p1.jpg' } });
    expect(catalog['updateDraft']).not.toHaveBeenCalled();
    expect(catalog['createDraft']).not.toHaveBeenCalled();
  });

  it('cada cambio recalcula "Cambios a aplicar" y los lista por canal', async () => {
    await setup();
    expect(text()).toContain('Todavía no cambiaste nada.');
    edits.ops = [
      { key: 'ml:MLA1:description', channel: 'ml', target: 'MLA1', targetLabel: 'ML-1', kind: 'description', label: 'Cambiar la descripción' },
      { key: 'tn:5:stock:v1', channel: 'tn', target: '5', targetLabel: 'TN-1', kind: 'stock:v1', label: 'Stock de "Rojo": 3 → 5', warn: 'aviso de prueba' },
    ];
    await component.store.refreshPlan();
    fixture.detectChanges();
    expect(text()).toContain('Cambiar la descripción');
    expect(text()).toContain('aviso de prueba');
    expect(text()).toContain('Guardar en ML y TN');
  });

  it('al retomar una edición abierta avisa si la publicación cambió en el canal mientras tanto', async () => {
    await setup((m) => (m.edit = editFixture({ resumed: true })));
    await settle();
    fixture.detectChanges();
    expect(edits.remoteCheck).toHaveBeenCalledWith('e1');
    expect(text()).toContain('Retomaste una edición');
    expect(text()).toContain('alguien cambió');
  });

  it('descartar la edición la cierra y vuelve al producto en Publicaciones', async () => {
    await setup();
    const router = TestBed.inject(Router);
    const nav = spyOn(router, 'navigate').and.resolveTo(true);
    await component.discardEdit();
    expect(edits.discard).toHaveBeenCalledWith('e1');
    expect(nav).toHaveBeenCalledWith(['/publicaciones'], { queryParams: { p: 'ml:MLA1' } });
  });

  it('si no se puede importar, explica por qué y no muestra el form', async () => {
    await setup((m) => m.open.and.rejectWith({ error: { error: 'Mercado Libre no devolvió la publicación MLA1.' } }));
    expect(text()).toContain('Mercado Libre no devolvió la publicación MLA1.');
    expect(fixture.nativeElement.querySelector('zc-common-data-section')).toBeNull();
  });

  it('guardar manda el borrador, sigue el progreso y al terminar vuelve al producto', async () => {
    await setup();
    await component.saveEdit();
    await settle();
    fixture.detectChanges();
    expect(edits.apply).toHaveBeenCalledWith('e1', jasmine.any(Object), false);
    expect(catalog['getPublishJob']).toHaveBeenCalledWith('j1');
    expect(component.store.editSavePhase()).toBe('done');
    expect(component.store.editLocked()).toBeTrue();
    expect(text()).toContain('Cambios guardados en Mercado Libre y Tienda Nube');
    const router = TestBed.inject(Router);
    const nav = spyOn(router, 'navigate').and.resolveTo(true);
    await component.finishEdit();
    expect(edits.close).toHaveBeenCalledWith('e1');
    expect(nav).toHaveBeenCalledWith(['/publicaciones'], { queryParams: { p: 'ml:MLA1' } });
  });

  it('con errores muestra cuál falló y permite reintentar lo que falta', async () => {
    await setup();
    jobResponse = {
      job: { status: 'error' },
      units: [
        { channel: 'ml', unitKey: 'ml:MLA1:description', status: 'ok', detail: 'Listo' },
        { channel: 'tn', unitKey: 'tn:5:stock:v1', status: 'error', detail: 'Tienda Nube no aceptó el stock.' },
      ],
    };
    await component.saveEdit();
    await settle();
    fixture.detectChanges();
    expect(component.store.editSavePhase()).toBe('error');
    expect(text()).toContain('1 de 2 cambios aplicados');
    expect(text()).toContain('Tienda Nube no aceptó el stock.');
    jobResponse = { ...jobResponse, job: { status: 'done' } };
    await component.store.retrySave();
    await settle();
    expect(catalog['retryPublishJob']).toHaveBeenCalledWith('j1');
    expect(component.store.editSavePhase()).toBe('done');
  });

  it('si la publicación cambió en el canal pide confirmación antes de guardar igual', async () => {
    await setup();
    edits.apply.and.callFake((_id: string, _d: unknown, force: boolean) =>
      force
        ? Promise.resolve({ jobId: 'j1', ops: [] })
        : Promise.reject({ status: 409, error: { code: 'remote_changed', changed: [{ channel: 'ml', id: 'MLA1', name: 'Cuaderno Rivadavia A4' }] } })
    );
    await component.saveEdit();
    fixture.detectChanges();
    expect(component.store.editConfirmRemote()?.length).toBe(1);
    expect(text()).toContain('Guardar igual');
    expect(component.store.editSavePhase()).toBe('idle');
    await component.store.applyEditChanges(true);
    expect(edits.apply).toHaveBeenCalledWith('e1', jasmine.any(Object), true);
    expect(component.store.editConfirmRemote()).toBeNull();
  });

  it('al volver a una edición que se estaba guardando retoma el progreso en vez de editar', async () => {
    await setup((m) => (m.edit = editFixture({ status: 'saving', job: { id: 'j7', status: 'processing', lastError: null }, jobOps: [{ key: 'ml:MLA1:description', channel: 'ml', target: 'MLA1', targetLabel: 'ML-1', kind: 'description', label: 'Cambiar la descripción' }] })));
    await settle();
    expect(catalog['getPublishJob']).toHaveBeenCalledWith('j7');
    expect(component.store.editSaveOps().length).toBe(1);
    expect(edits.plan).not.toHaveBeenCalled();
  });
});
