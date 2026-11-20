import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { QueryClient, provideTanStackQuery } from '@tanstack/angular-query-experimental';
import { UsuariosComponent } from './usuarios.component';
import { AppUser, UsuariosService } from '../../core/services/usuarios.service';
import { SessionService } from '../../core/services/session.service';

const users = [
  { id: 1, username: 'mica', displayName: 'Mica', role: 'admin', activo: true, lastLoginAt: null },
  { id: 2, username: 'deposito', displayName: 'Depósito Marañón', role: 'lectura', activo: true, lastLoginAt: null },
  { id: 3, username: 'contador', displayName: null, role: 'lectura', activo: false, lastLoginAt: null },
] as unknown as AppUser[];

describe('UsuariosComponent', () => {
  let fixture: ComponentFixture<UsuariosComponent>;
  let component: UsuariosComponent;

  async function create(phone: boolean): Promise<void> {
    spyOn(window, 'matchMedia').and.returnValue({ matches: phone, addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as MediaQueryList);
    const service = jasmine.createSpyObj<UsuariosService>('UsuariosService', ['getAll', 'create', 'update', 'cerrarSesiones', 'delete']);
    service.getAll.and.returnValue(of({ items: users }));
    TestBed.configureTestingModule({
      imports: [UsuariosComponent],
      providers: [
        provideTanStackQuery(new QueryClient({ defaultOptions: { queries: { retry: false } } })),
        { provide: UsuariosService, useValue: service },
        { provide: SessionService, useValue: { user: () => ({ id: 1 }) } },
      ],
    });
    fixture = TestBed.createComponent(UsuariosComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r));
    fixture.detectChanges();
  }

  afterEach(() => fixture?.destroy());

  it('escritorio: la tabla de siempre', async () => {
    await create(false);
    expect(fixture.nativeElement.querySelector('.us-table')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.us-list')).toBeNull();
  });

  it('celular: lista compacta y hoja con las acciones', async () => {
    await create(true);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.us-table')).toBeNull();
    expect(el.querySelectorAll('.us-row').length).toBe(3);
    expect(el.textContent).toContain('Desactivado');

    (el.querySelectorAll('.us-row')[0] as HTMLElement).click();
    fixture.detectChanges();
    expect(component.openSheet()?.id).toBe(1);
    expect(el.textContent).toContain('No podés borrarte a vos misma');
  });

  it('iniciales del avatar', async () => {
    await create(true);
    expect(component.initials(users[0])).toBe('MI');
    expect(component.initials(users[1])).toBe('DM');
    expect(component.initials(users[2])).toBe('CO');
  });
});
