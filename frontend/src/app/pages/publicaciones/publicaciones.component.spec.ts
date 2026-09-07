import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTanStackQuery, QueryClient } from '@tanstack/angular-query-experimental';
import { CatalogService, PublishJobRow, PublishUnit } from '../../core/services/catalog.service';
import { PublicacionesComponent } from './publicaciones.component';

/** Deja pasar microtasks + un turno de macrotask (para que resuelvan los queries y el debounce). */
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function jobRow(over: Partial<PublishJobRow> = {}): PublishJobRow {
  return {
    id: 'j1',
    draftId: 'd1',
    draftName: 'Agenda 2027',
    draftSku: '30562',
    channels: 'ml,tn',
    status: 'error',
    attempts: 1,
    lastError: 'tn: 500',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    finishedAt: null,
    unitsTotal: 4,
    unitsOk: 3,
    unitsErr: 1,
    ...over,
  };
}

class CatalogMock {
  listPublishJobs = jasmine.createSpy('listPublishJobs').and.callFake(() => Promise.resolve({ rows: [jobRow()], total: 1 }));
  getPublishJob = jasmine.createSpy('getPublishJob').and.callFake((id: string) =>
    Promise.resolve({
      job: { id, draftId: 'd1', channels: 'ml,tn', status: 'error', attempts: 1, lastError: null, createdAt: '', updatedAt: '', finishedAt: null },
      units: [
        { channel: 'ml', unitKey: '', seq: 0, status: 'ok', externalId: 'MLA123', detail: 'creada', updatedAt: '' },
        { channel: 'tn', unitKey: '', seq: 1, status: 'error', externalId: null, detail: 'TN 500', updatedAt: '' },
      ] as PublishUnit[],
    })
  );
  retryPublishJob = jasmine.createSpy('retryPublishJob').and.resolveTo({ ok: true });
  cancelPublishJob = jasmine.createSpy('cancelPublishJob').and.resolveTo({ ok: true });
  deletePublishJob = jasmine.createSpy('deletePublishJob').and.resolveTo({ ok: true });
}

describe('PublicacionesComponent', () => {
  let fixture: ComponentFixture<PublicacionesComponent>;
  let component: PublicacionesComponent;
  let catalog: CatalogMock;

  beforeEach(async () => {
    catalog = new CatalogMock();
    await TestBed.configureTestingModule({
      imports: [PublicacionesComponent],
      providers: [
        provideTanStackQuery(new QueryClient({ defaultOptions: { queries: { gcTime: 0, retry: false } } })),
        { provide: CatalogService, useValue: catalog },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(PublicacionesComponent);
    component = fixture.componentInstance;
  });

  it('carga el historial y lo pinta', async () => {
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
    expect(catalog.listPublishJobs).toHaveBeenCalled();
    expect(component.rows().length).toBe(1);
    expect(fixture.nativeElement.textContent).toContain('Agenda 2027');
  });

  it('expandir una fila trae el detalle de las unidades con su id externo', async () => {
    fixture.detectChanges();
    await settle();
    component.toggle('j1');
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
    expect(catalog.getPublishJob).toHaveBeenCalledWith('j1');
    expect(component.detailUnits().length).toBe(2);
    expect(fixture.nativeElement.textContent).toContain('MLA123');
  });

  it('externalUrl arma el link de ML y no el de TN', () => {
    expect(component.externalUrl({ channel: 'ml', externalId: 'MLA987', status: 'ok' } as PublishUnit)).toContain('MLA-987');
    expect(component.externalUrl({ channel: 'tn', externalId: '55', status: 'ok' } as PublishUnit)).toBeNull();
  });

  it('statusClass mapea a las clases del badge', () => {
    expect(component.statusClass('done')).toBe('ok');
    expect(component.statusClass('error')).toBe('err');
    expect(component.statusClass('cancelled')).toBe('warn');
    expect(component.statusClass('processing')).toBe('busy');
  });

  it('cambiar un filtro vuelve a la página 1', async () => {
    fixture.detectChanges();
    await settle();
    component.page.set(3);
    component.statusFilter.set('error');
    fixture.detectChanges(); // dispara el effect que resetea la página
    await settle();
    expect(component.page()).toBe(1);
  });

  it('Reintentar llama al endpoint y refetchea', async () => {
    fixture.detectChanges();
    await settle();
    await component.retry(jobRow(), new Event('click'));
    await settle();
    expect(catalog.retryPublishJob).toHaveBeenCalledWith('j1');
    expect(catalog.listPublishJobs.calls.count()).toBeGreaterThan(1);
  });
});
