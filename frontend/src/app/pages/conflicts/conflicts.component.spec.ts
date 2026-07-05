import { ComponentFixture, TestBed, fakeAsync, tick, flush } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideTanStackQuery, QueryClient } from '@tanstack/angular-query-experimental';
import { of, throwError } from 'rxjs';

import { ConflictsComponent } from './conflicts.component';
import { ConflictAnalysis, ConflictsService, MlRow, TnRow } from '../../core/services/conflicts.service';

/*
 * Nota de diseño: los componentes hijos de esta página (tabs/*, conflict-row, product-thumb,
 * pagination) son standalone, puramente presentacionales y no inyectan servicios propios, así
 * que se dejan renderizar de verdad (sin NO_ERRORS_SCHEMA). Esto permite además verificar que
 * los bindings de [pairs]/[rows]/[noSkuML]/etc. le llegan bien al hijo correcto según la tab activa.
 * Lo único que se mockea es ConflictsService (la fuente de datos remota).
 */

function mkMl(overrides: Partial<MlRow> = {}): MlRow {
  return {
    type: 'ml',
    itemId: 'MLA1',
    variationId: null,
    variationName: null,
    title: 'Cuaderno A4 Rayado',
    sku: 'SKU-1',
    hasSku: true,
    price: 1000,
    stock: 5,
    thumbnail: null,
    ...overrides
  };
}

function mkTn(overrides: Partial<TnRow> = {}): TnRow {
  return {
    type: 'tn',
    productId: 1,
    variantId: 1,
    variantName: null,
    productName: 'Cuaderno A4 Rayado',
    sku: 'SKU-1',
    hasSku: true,
    price: 1000,
    stock: 5,
    thumbnail: null,
    ...overrides
  };
}

function createAnalysis(overrides: Partial<ConflictAnalysis> = {}): ConflictAnalysis {
  const matchedMl = mkMl({ itemId: 'MLA-MATCH', sku: 'SKU-MATCH', title: 'Producto Coincidente' });
  const matchedTn = mkTn({ productId: 10, variantId: 10, sku: 'SKU-MATCH', productName: 'Producto Coincidente' });
  const onlyMl = mkMl({ itemId: 'MLA-ONLY', sku: 'SKU-ONLY-ML', title: 'Solo en ML' });
  const onlyTn = mkTn({ productId: 20, variantId: 20, sku: 'SKU-ONLY-TN', productName: 'Solo en TN' });
  const noSkuMl = mkMl({ itemId: 'MLA-NOSKU', sku: null, hasSku: false, title: 'Sin SKU ML' });
  const noSkuTn = mkTn({ productId: 30, variantId: 30, sku: null, hasSku: false, productName: 'Sin SKU TN' });

  return {
    mlConnected: true,
    tnConnected: true,
    mlAuthError: false,
    summary: {
      totalML: 10,
      totalTN: 12,
      matched: 1,
      onlyML: 1,
      onlyTN: 1,
      noSkuML: 1,
      noSkuTN: 1,
      duplicateSkuML: 1,
      duplicateSkuTN: 1,
      resolved: 0
    },
    matched: [{ ml: matchedMl, tn: matchedTn, sku: 'SKU-MATCH' }],
    onlyML: [onlyMl],
    onlyTN: [onlyTn],
    noSkuML: [noSkuMl],
    noSkuTN: [noSkuTn],
    duplicateSkuML: [{ sku: 'DUP-ML', items: [mkMl({ itemId: 'MLA-D1', sku: 'DUP-ML' }), mkMl({ itemId: 'MLA-D2', sku: 'DUP-ML' })] }],
    duplicateSkuTN: [{ sku: 'DUP-TN', items: [mkTn({ productId: 40, variantId: 40, sku: 'DUP-TN' }), mkTn({ productId: 40, variantId: 41, sku: 'DUP-TN' })] }],
    mappings: [],
    paging: { page: 1, limit: 25, total: 1, pages: 1 },
    ...overrides
  };
}

describe('ConflictsComponent', () => {
  let fixture: ComponentFixture<ConflictsComponent>;
  let component: ConflictsComponent;
  let conflictsSpy: jasmine.SpyObj<ConflictsService>;

  function createSpy(): jasmine.SpyObj<ConflictsService> {
    const spy = jasmine.createSpyObj<ConflictsService>('ConflictsService', [
      'getAnalysisPromise',
      'getAnalysis',
      'updateSku',
      'linkManually',
      'invalidateAnalysis',
      'forceRefresh',
      'updatePairInCache',
      'updateItemVariationsPriceInCache',
      'updatePricesAndStock',
      'getTaskStatus'
    ]);
    spy.forceRefresh.and.returnValue(Promise.resolve());
    spy.updateSku.and.returnValue(of({ ok: true }));
    spy.linkManually.and.returnValue(of({ ok: true, sku: 'SKU-MATCH', persisted: { ml: true, tn: true } }));
    return spy;
  }

  /** Configura el TestBed, crea el componente y espera a que la query de TanStack se resuelva. */
  async function init(): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [ConflictsComponent],
      providers: [
        provideRouter([]),
        provideTanStackQuery(new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })),
        { provide: ConflictsService, useValue: conflictsSpy }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(ConflictsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(() => {
    conflictsSpy = createSpy();
  });

  describe('carga del análisis', () => {
    it('debería cargar el análisis y exponerlo en analysis/loading/error', async () => {
      const analysis = createAnalysis();
      conflictsSpy.getAnalysisPromise.and.returnValue(Promise.resolve(analysis));

      await init();

      expect(component.analysis).toEqual(analysis);
      expect(component.loading).toBeFalse();
      expect(component.error).toBeNull();
    });

    it('debería llamar a getAnalysisPromise con la tab, página y límite actuales', async () => {
      conflictsSpy.getAnalysisPromise.and.returnValue(Promise.resolve(createAnalysis()));

      await init();

      expect(conflictsSpy.getAnalysisPromise).toHaveBeenCalledWith(
        jasmine.objectContaining({ tab: 'resumen', page: 1, limit: 25 })
      );
    });

    it('debería mostrar el mensaje de carga mientras loading es true', async () => {
      conflictsSpy.getAnalysisPromise.and.returnValue(new Promise(() => {})); // nunca resuelve: queda "cargando"
      await TestBed.configureTestingModule({
        imports: [ConflictsComponent],
        providers: [
          provideRouter([]),
          provideTanStackQuery(new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })),
          { provide: ConflictsService, useValue: conflictsSpy }
        ]
      }).compileComponents();
      fixture = TestBed.createComponent(ConflictsComponent);
      fixture.detectChanges();

      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('.loading-msg')).not.toBeNull();
    });

    it('debería exponer un mensaje de error legible cuando el server rechaza con { error: { error } }', async () => {
      conflictsSpy.getAnalysisPromise.and.returnValue(Promise.reject({ error: { error: 'Análisis no disponible' } }));

      await init();

      expect(component.error).toBe('Análisis no disponible');
      expect(component.loading).toBeFalse();
      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('.alert.error')?.textContent).toContain('Análisis no disponible');
    });

    it('debería usar Error.message como fallback cuando el rechazo no trae { error: { error } }', async () => {
      conflictsSpy.getAnalysisPromise.and.returnValue(Promise.reject(new Error('fallo de red')));

      await init();

      expect(component.error).toBe('fallo de red');
    });

    it('debería mostrar el aviso de conectar Mercado Libre cuando mlConnected es false', async () => {
      conflictsSpy.getAnalysisPromise.and.returnValue(Promise.resolve(createAnalysis({ mlConnected: false })));

      await init();

      const el: HTMLElement = fixture.nativeElement;
      expect(el.textContent).toContain('Conectá Mercado Libre');
    });

    it('debería mostrar el aviso de conectar Tienda Nube cuando tnConnected es false', async () => {
      conflictsSpy.getAnalysisPromise.and.returnValue(Promise.resolve(createAnalysis({ tnConnected: false })));

      await init();

      const el: HTMLElement = fixture.nativeElement;
      expect(el.textContent).toContain('Conectá Tienda Nube');
    });

    it('debería mostrar el aviso de sesión de ML vencida cuando mlAuthError es true', async () => {
      conflictsSpy.getAnalysisPromise.and.returnValue(Promise.resolve(createAnalysis({ mlAuthError: true })));

      await init();

      const el: HTMLElement = fixture.nativeElement;
      expect(el.textContent).toContain('sesión de Mercado Libre venció');
    });

    it('refreshAnalysis debería forzar un refresh del análisis', async () => {
      conflictsSpy.getAnalysisPromise.and.returnValue(Promise.resolve(createAnalysis()));
      await init();

      component.refreshAnalysis();

      expect(conflictsSpy.forceRefresh).toHaveBeenCalled();
    });
  });

  describe('tabs', () => {
    beforeEach(async () => {
      conflictsSpy.getAnalysisPromise.and.returnValue(Promise.resolve(createAnalysis()));
      await init();
    });

    it('debería iniciar en la tab "resumen" y mostrar app-conflicts-resumen-tab', () => {
      expect(component.activeTab()).toBe('resumen');
      expect(fixture.nativeElement.querySelector('app-conflicts-resumen-tab')).not.toBeNull();
    });

    it('onTabChange debería cambiar la tab activa y resetear la página a 1', () => {
      component.currentPage.set(3);

      component.onTabChange('coincidencias');

      expect(component.activeTab()).toBe('coincidencias');
      expect(component.currentPage()).toBe(1);
    });

    it('debería renderizar app-conflicts-coincidencias-tab con los pares "matched" al cambiar de tab', fakeAsync(() => {
      component.onTabChange('coincidencias');
      fixture.detectChanges();
      tick(); // cambiar de tab arma un nuevo queryKey; hay que dejar resolver esa query
      fixture.detectChanges();

      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('app-conflicts-coincidencias-tab')).not.toBeNull();
      expect(el.querySelectorAll('.pair-card').length).toBe(1);
      expect(el.textContent).toContain('Producto Coincidente');
      flush();
    }));

    it('debería renderizar app-conflicts-solo-ml-tab con los rows "onlyML"', fakeAsync(() => {
      component.onTabChange('solo-ml');
      fixture.detectChanges();
      tick();
      fixture.detectChanges();

      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('app-conflicts-solo-ml-tab')).not.toBeNull();
      expect(el.textContent).toContain('Solo en ML');
      flush();
    }));

    it('debería renderizar app-conflicts-solo-tn-tab con los rows "onlyTN"', fakeAsync(() => {
      component.onTabChange('solo-tn');
      fixture.detectChanges();
      tick();
      fixture.detectChanges();

      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('app-conflicts-solo-tn-tab')).not.toBeNull();
      expect(el.textContent).toContain('Solo en TN');
      flush();
    }));

    it('debería renderizar app-conflicts-sin-sku-tab con noSkuML y noSkuTN', fakeAsync(() => {
      component.onTabChange('sin-sku');
      fixture.detectChanges();
      tick();
      fixture.detectChanges();

      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('app-conflicts-sin-sku-tab')).not.toBeNull();
      expect(el.textContent).toContain('Sin SKU ML');
      expect(el.textContent).toContain('Sin SKU TN');
      flush();
    }));

    it('debería renderizar app-conflicts-duplicados-tab con duplicateSkuML y duplicateSkuTN', fakeAsync(() => {
      component.onTabChange('duplicados');
      fixture.detectChanges();
      tick();
      fixture.detectChanges();

      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('app-conflicts-duplicados-tab')).not.toBeNull();
      expect(el.querySelectorAll('.dup-group.ml-group').length).toBe(1);
      expect(el.querySelectorAll('.dup-group.tn-group').length).toBe(1);
      flush();
    }));

    it('no debería mostrar la barra de búsqueda en la tab "resumen"', () => {
      expect(fixture.nativeElement.querySelector('zc-search-bar')).toBeNull();
    });

    it('debería mostrar la barra de búsqueda en cualquier otra tab', fakeAsync(() => {
      component.onTabChange('coincidencias');
      fixture.detectChanges();
      tick();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('zc-search-bar')).not.toBeNull();
      flush();
    }));

    it('conflictTabs debería calcular los contadores agregados de sin-sku y duplicados', () => {
      const tabs = component.conflictTabs(component.analysis!);
      const sinSku = tabs.find(t => t.key === 'sin-sku');
      const dups = tabs.find(t => t.key === 'duplicados');
      expect(sinSku?.count).toBe(2); // noSkuML + noSkuTN
      expect(dups?.count).toBe(2); // duplicateSkuML + duplicateSkuTN
    });
  });

  describe('búsqueda', () => {
    beforeEach(async () => {
      conflictsSpy.getAnalysisPromise.and.returnValue(Promise.resolve(createAnalysis()));
      await init();
    });

    it('onSearchChange debería actualizar searchQuery y resetear la página a 1', () => {
      component.currentPage.set(2);

      component.onSearchChange('cuaderno');

      expect(component.searchQuery()).toBe('cuaderno');
      expect(component.currentPage()).toBe(1);
    });

    it('debería refetchear con el término de búsqueda tras el debounce', fakeAsync(() => {
      conflictsSpy.getAnalysisPromise.calls.reset();
      component.onSearchChange('cuaderno');

      tick(350); // debounceTime(350) de searchQuery -> debouncedSearch
      fixture.detectChanges();
      tick(); // deja resolver la promesa mockeada del queryFn
      fixture.detectChanges();

      expect(conflictsSpy.getAnalysisPromise).toHaveBeenCalledWith(
        jasmine.objectContaining({ search: 'cuaderno' })
      );
      flush();
    }));
  });

  describe('vinculación manual (modal de link)', () => {
    beforeEach(async () => {
      conflictsSpy.getAnalysisPromise.and.returnValue(Promise.resolve(createAnalysis()));
      await init();
    });

    it('openLinkFromMl debería abrir el modal precargado con la fila de ML', () => {
      const ml = component.analysis!.onlyML[0];
      component.openLinkFromMl(ml);

      expect(component.showLinkModal).toBeTrue();
      expect(component.linkMl).toBe(ml);
      expect(component.linkTn).toBeNull();
      expect(component.linkSku).toBe(ml.sku!);
    });

    it('openLinkFromTn debería abrir el modal precargado con la fila de TN', () => {
      const tn = component.analysis!.onlyTN[0];
      component.openLinkFromTn(tn);

      expect(component.showLinkModal).toBeTrue();
      expect(component.linkTn).toBe(tn);
      expect(component.linkMl).toBeNull();
    });

    it('chooseTnForLink debería completar el otro lado del par y proponer SKU', () => {
      component.openLinkFromMl(component.analysis!.onlyML[0]);
      const tn = component.analysis!.onlyTN[0];

      component.chooseTnForLink(tn);

      expect(component.linkTn).toBe(tn);
      expect(component.linkSku).toBe(tn.sku!);
    });

    it('chooseMlForLink debería completar el otro lado del par y proponer SKU', () => {
      component.openLinkFromTn(component.analysis!.onlyTN[0]);
      const ml = component.analysis!.onlyML[0];

      component.chooseMlForLink(ml);

      expect(component.linkMl).toBe(ml);
      expect(component.linkSku).toBe(ml.sku!);
    });

    it('saveLink debería fallar con un mensaje si falta ML, TN o SKU', () => {
      component.showLinkModal = true;
      component.linkMl = null;
      component.linkTn = null;
      component.linkSku = '';

      component.saveLink();

      expect(component.linkError).toContain('Seleccioná');
      expect(conflictsSpy.linkManually).not.toHaveBeenCalled();
    });

    it('saveLink debería vincular, invalidar la caché y cerrar el modal en caso de éxito', () => {
      component.openLinkFromMl(component.analysis!.onlyML[0]);
      component.chooseTnForLink(component.analysis!.onlyTN[0]);
      component.linkSku = 'SKU-NUEVO';

      component.saveLink();

      expect(conflictsSpy.linkManually).toHaveBeenCalledWith(jasmine.objectContaining({ sku: 'SKU-NUEVO' }));
      expect(component.showLinkModal).toBeFalse();
      expect(component.savingLink).toBeFalse();
      expect(conflictsSpy.invalidateAnalysis).toHaveBeenCalled();
    });

    it('saveLink debería mostrar un aviso cuando el backend no pudo persistir en uno de los canales', () => {
      conflictsSpy.linkManually.and.returnValue(of({ ok: true, sku: 'SKU-NUEVO', persisted: { ml: false, tn: true } }));
      component.openLinkFromMl(component.analysis!.onlyML[0]);
      component.chooseTnForLink(component.analysis!.onlyTN[0]);
      component.linkSku = 'SKU-NUEVO';

      component.saveLink();

      expect(component.linkError).toContain('no se pudo encolar');
      expect(component.showLinkModal).toBeTrue();
    });

    it('saveLink debería exponer el error del backend cuando la request falla', () => {
      conflictsSpy.linkManually.and.returnValue(throwError(() => ({ error: { error: 'La publicación de ML no está activa' } })));
      component.openLinkFromMl(component.analysis!.onlyML[0]);
      component.chooseTnForLink(component.analysis!.onlyTN[0]);
      component.linkSku = 'SKU-NUEVO';

      component.saveLink();

      expect(component.linkError).toBe('La publicación de ML no está activa');
      expect(component.savingLink).toBeFalse();
    });

    it('closeLinkModal debería limpiar el estado del modal', () => {
      component.openLinkFromMl(component.analysis!.onlyML[0]);

      component.closeLinkModal();

      expect(component.showLinkModal).toBeFalse();
      expect(component.linkMl).toBeNull();
      expect(component.linkTn).toBeNull();
    });

    it('filteredLinkTnOptions debería filtrar por texto entre onlyTN y noSkuTN', () => {
      component.linkSearchQuery = 'sin sku tn';
      const opts = component.filteredLinkTnOptions;
      expect(opts.length).toBe(1);
      expect(opts[0].productName).toBe('Sin SKU TN');
    });

    it('filteredLinkMlOptions debería filtrar por texto entre onlyML y noSkuML', () => {
      component.linkSearchQuery = 'solo en ml';
      const opts = component.filteredLinkMlOptions;
      expect(opts.length).toBe(1);
      expect(opts[0].title).toBe('Solo en ML');
    });
  });

  describe('edición de SKU individual', () => {
    beforeEach(async () => {
      conflictsSpy.getAnalysisPromise.and.returnValue(Promise.resolve(createAnalysis()));
      await init();
    });

    it('openEditSku / onEditSku debería abrir el modal con el valor actual del SKU', () => {
      const ml = component.analysis!.onlyML[0];
      component.onEditSku({ channel: 'mercadolibre', row: ml });

      expect(component.showEditSkuModal).toBeTrue();
      expect(component.editSkuTarget).toEqual({ channel: 'mercadolibre', row: ml });
      expect(component.editSkuValue).toBe(ml.sku!);
    });

    it('saveEditSku debería actualizar el SKU, invalidar caché y cerrar el modal', () => {
      const ml = component.analysis!.onlyML[0];
      component.openEditSku('mercadolibre', ml);
      component.editSkuValue = 'SKU-EDITADO';

      component.saveEditSku();

      expect(conflictsSpy.updateSku).toHaveBeenCalledWith('mercadolibre', 'SKU-EDITADO', jasmine.objectContaining({ itemId: ml.itemId }));
      expect(component.showEditSkuModal).toBeFalse();
      expect(conflictsSpy.invalidateAnalysis).toHaveBeenCalled();
    });

    it('saveEditSku debería exponer el error del backend si la request falla', () => {
      conflictsSpy.updateSku.and.returnValue(throwError(() => ({ message: 'network error' })));
      const ml = component.analysis!.onlyML[0];
      component.openEditSku('mercadolibre', ml);
      component.editSkuValue = 'SKU-EDITADO';

      component.saveEditSku();

      expect(component.error).toBe('network error');
      expect(component.savingSku).toBeFalse();
      expect(component.showEditSkuModal).toBeTrue();
    });

    it('saveEditSku no debería hacer nada si el valor está vacío', () => {
      const ml = component.analysis!.onlyML[0];
      component.openEditSku('mercadolibre', ml);
      component.editSkuValue = '   ';

      component.saveEditSku();

      expect(conflictsSpy.updateSku).not.toHaveBeenCalled();
    });

    it('closeEditSkuModal debería limpiar el estado', () => {
      component.openEditSku('mercadolibre', component.analysis!.onlyML[0]);

      component.closeEditSkuModal();

      expect(component.showEditSkuModal).toBeFalse();
      expect(component.editSkuTarget).toBeNull();
    });

    it('getEditSkuLabel debería usar mlLabel o tnLabel según el canal', () => {
      component.openEditSku('mercadolibre', component.analysis!.onlyML[0]);
      expect(component.getEditSkuLabel()).toBe('Solo en ML');

      component.openEditSku('tiendanube', component.analysis!.onlyTN[0]);
      // Sin variantName, tnLabel() cae al fallback "<producto> – Var <id>".
      expect(component.getEditSkuLabel()).toBe('Solo en TN – Var 20');
    });

    it('getEditSkuLabel debería devolver string vacío si no hay un target abierto', () => {
      expect(component.editSkuTarget).toBeNull();
      expect(component.getEditSkuLabel()).toBe('');
    });
  });

  describe('edición de ambos SKU (par completo)', () => {
    beforeEach(async () => {
      conflictsSpy.getAnalysisPromise.and.returnValue(Promise.resolve(createAnalysis()));
      await init();
    });

    it('openEditBothSkuModal debería precargar ambos SKU del par', () => {
      const pair = component.analysis!.matched[0];
      component.openEditBothSkuModal(pair);

      expect(component.showEditBothSkuModal).toBeTrue();
      expect(component.editBothSkuML).toBe(pair.ml.sku!);
      expect(component.editBothSkuTN).toBe(pair.tn.sku!);
    });

    it('saveEditBothSku debería actualizar ML y TN y cerrar el modal cuando ambos cambian', () => {
      const pair = component.analysis!.matched[0];
      component.openEditBothSkuModal(pair);
      component.editBothSkuML = 'SKU-ML-NUEVO';
      component.editBothSkuTN = 'SKU-TN-NUEVO';

      component.saveEditBothSku();

      expect(conflictsSpy.updateSku).toHaveBeenCalledWith('mercadolibre', 'SKU-ML-NUEVO', jasmine.any(Object));
      expect(conflictsSpy.updateSku).toHaveBeenCalledWith('tiendanube', 'SKU-TN-NUEVO', jasmine.any(Object));
      expect(component.showEditBothSkuModal).toBeFalse();
      expect(conflictsSpy.invalidateAnalysis).toHaveBeenCalled();
    });

    it('saveEditBothSku debería actualizar solo TN si el campo de ML quedó vacío', () => {
      const pair = component.analysis!.matched[0];
      component.openEditBothSkuModal(pair);
      component.editBothSkuML = '';
      component.editBothSkuTN = 'SKU-TN-NUEVO';

      component.saveEditBothSku();

      expect(conflictsSpy.updateSku).toHaveBeenCalledWith('tiendanube', 'SKU-TN-NUEVO', jasmine.any(Object));
      expect(conflictsSpy.updateSku).toHaveBeenCalledTimes(1);
      expect(component.showEditBothSkuModal).toBeFalse();
    });

    it('saveEditBothSku debería propagar el error si falla la actualización de ML', () => {
      conflictsSpy.updateSku.and.returnValue(throwError(() => ({ error: { error: 'ML rechazó el SKU' } })));
      const pair = component.analysis!.matched[0];
      component.openEditBothSkuModal(pair);
      component.editBothSkuML = 'SKU-ML-NUEVO';
      component.editBothSkuTN = '';

      component.saveEditBothSku();

      expect(component.error).toBe('ML rechazó el SKU');
      expect(component.savingEditBoth).toBeFalse();
    });

    it('saveEditBothSku no debería hacer nada si ambos campos quedaron vacíos', () => {
      const pair = component.analysis!.matched[0];
      component.openEditBothSkuModal(pair);
      component.editBothSkuML = '';
      component.editBothSkuTN = '';

      component.saveEditBothSku();

      expect(conflictsSpy.updateSku).not.toHaveBeenCalled();
    });

    it('closeEditBothSkuModal debería limpiar el estado', () => {
      component.openEditBothSkuModal(component.analysis!.matched[0]);

      component.closeEditBothSkuModal();

      expect(component.showEditBothSkuModal).toBeFalse();
      expect(component.editBothPair).toBeNull();
    });

    it('saveEditBothSku debería propagar el error si falla la actualización de ML cuando cambian ambos', () => {
      conflictsSpy.updateSku.and.returnValue(throwError(() => ({ error: { error: 'ML rechazó el SKU' } })));
      const pair = component.analysis!.matched[0];
      component.openEditBothSkuModal(pair);
      component.editBothSkuML = 'SKU-ML-NUEVO';
      component.editBothSkuTN = 'SKU-TN-NUEVO';

      component.saveEditBothSku();

      expect(component.error).toBe('ML rechazó el SKU');
      expect(component.savingEditBoth).toBeFalse();
      expect(component.showEditBothSkuModal).toBeTrue();
    });

    it('saveEditBothSku debería propagar el error si ML actualiza bien pero falla TN', () => {
      conflictsSpy.updateSku.and.callFake((channel: string) =>
        channel === 'mercadolibre' ? of({ ok: true }) : throwError(() => ({ error: { error: 'TN rechazó el SKU' } }))
      );
      const pair = component.analysis!.matched[0];
      component.openEditBothSkuModal(pair);
      component.editBothSkuML = 'SKU-ML-NUEVO';
      component.editBothSkuTN = 'SKU-TN-NUEVO';

      component.saveEditBothSku();

      expect(component.error).toBe('TN rechazó el SKU');
      expect(component.savingEditBoth).toBeFalse();
      expect(component.showEditBothSkuModal).toBeTrue();
    });
  });

  describe('edición masiva de SKU (bulk, duplicados)', () => {
    beforeEach(async () => {
      conflictsSpy.getAnalysisPromise.and.returnValue(Promise.resolve(createAnalysis()));
      await init();
    });

    it('onBulkEditSku debería precargar el modal con SKUs propuestos por índice', () => {
      const group = component.analysis!.duplicateSkuML[0];
      component.onBulkEditSku({ channel: 'mercadolibre', sku: group.sku, items: group.items });

      expect(component.showBulkEditSkuModal).toBeTrue();
      expect(component.bulkEditItems.length).toBe(2);
      expect(component.bulkEditNewSkus).toEqual(['DUP-ML-1', 'DUP-ML-2']);
    });

    it('saveBulkEditSku no hace nada si no hay un canal de edición masiva abierto', () => {
      component.saveBulkEditSku();
      expect(conflictsSpy.updateSku).not.toHaveBeenCalled();
    });

    it('saveBulkEditSku debería fallar si ningún SKU nuevo difiere del actual', () => {
      const group = component.analysis!.duplicateSkuML[0];
      component.onBulkEditSku({ channel: 'mercadolibre', sku: group.sku, items: group.items });
      component.bulkEditNewSkus = [group.sku, group.sku];

      component.saveBulkEditSku();

      expect(component.bulkEditError).toContain('al menos un SKU distinto');
      expect(conflictsSpy.updateSku).not.toHaveBeenCalled();
    });

    it('saveBulkEditSku debería actualizar el único ítem modificado sin demora (index 0) y cerrar el modal', fakeAsync(() => {
      const group = component.analysis!.duplicateSkuML[0];
      component.onBulkEditSku({ channel: 'mercadolibre', sku: group.sku, items: group.items });
      component.bulkEditNewSkus = ['DUP-ML-NUEVO', group.sku]; // solo el primero cambia

      component.saveBulkEditSku();
      tick();

      expect(conflictsSpy.updateSku).toHaveBeenCalledWith('mercadolibre', 'DUP-ML-NUEVO', jasmine.any(Object));
      expect(conflictsSpy.updateSku).toHaveBeenCalledTimes(1);
      expect(component.showBulkEditSkuModal).toBeFalse();
      expect(component.savingBulkSku).toBeFalse();
      expect(conflictsSpy.invalidateAnalysis).toHaveBeenCalled();
    }));

    it('saveBulkEditSku debería actualizar dos ítems en secuencia respetando la pausa de 1s entre requests', fakeAsync(() => {
      const group = component.analysis!.duplicateSkuML[0];
      component.onBulkEditSku({ channel: 'mercadolibre', sku: group.sku, items: group.items });
      component.bulkEditNewSkus = ['DUP-ML-NUEVO-1', 'DUP-ML-NUEVO-2'];

      component.saveBulkEditSku();
      tick(0);
      // El segundo update se arma dentro del pipe pero su envío queda detrás del timer(1000):
      // el modal no debería cerrarse todavía (recién cierra cuando la secuencia completa).
      expect(component.showBulkEditSkuModal).toBeTrue();

      tick(1000);
      expect(conflictsSpy.updateSku).toHaveBeenCalledTimes(2);
      expect(component.showBulkEditSkuModal).toBeFalse();
    }));

    it('saveBulkEditSku debería exponer el error y detener el lote si una request falla', fakeAsync(() => {
      conflictsSpy.updateSku.and.returnValue(throwError(() => ({ error: { error: 'SKU duplicado en TN' } })));
      const group = component.analysis!.duplicateSkuML[0];
      component.onBulkEditSku({ channel: 'mercadolibre', sku: group.sku, items: group.items });
      component.bulkEditNewSkus = ['DUP-ML-NUEVO', group.sku];

      component.saveBulkEditSku();
      tick();

      expect(component.bulkEditError).toBe('SKU duplicado en TN');
      expect(component.savingBulkSku).toBeFalse();
      expect(component.showBulkEditSkuModal).toBeTrue();
    }));

    it('closeBulkEditSkuModal debería limpiar el estado del modal', () => {
      const group = component.analysis!.duplicateSkuML[0];
      component.onBulkEditSku({ channel: 'mercadolibre', sku: group.sku, items: group.items });

      component.closeBulkEditSkuModal();

      expect(component.showBulkEditSkuModal).toBeFalse();
      expect(component.bulkEditChannel).toBeNull();
      expect(component.bulkEditItems).toEqual([]);
    });

    it('getBulkEditRowTrackId / getBulkEditRowLabel deberían discriminar por canal', () => {
      component.bulkEditChannel = 'mercadolibre';
      const ml = component.analysis!.duplicateSkuML[0].items[0];
      expect(component.getBulkEditRowTrackId(ml)).toBe(ml.itemId);
      expect(component.getBulkEditRowLabel(ml)).toBe('Cuaderno A4 Rayado');

      component.bulkEditChannel = 'tiendanube';
      const tn = component.analysis!.duplicateSkuTN[0].items[0];
      expect(component.getBulkEditRowTrackId(tn)).toBe(`${tn.productId}${tn.variantId}`);
    });
  });
});
