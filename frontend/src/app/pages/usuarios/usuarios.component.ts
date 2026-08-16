import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { injectQuery } from '@tanstack/angular-query-experimental';
import { firstValueFrom } from 'rxjs';
import { UsuariosService, AppUser } from '../../core/services/usuarios.service';
import { SessionService } from '../../core/services/session.service';
import { ConfirmDialogComponent } from '../../shared/components/confirm-dialog/confirm-dialog.component';

/** Estado del formulario de alta/edición de un usuario. */
interface UserForm {
  id: number | null;
  username: string;
  displayName: string;
  activo: boolean;
  password: string;
}

function emptyForm(): UserForm {
  return { id: null, username: '', displayName: '', activo: true, password: '' };
}

/**
 * Panel de administración de usuarios del hub (sin roles). Calcado de la página de Depósito
 * Marañón: mismo patrón de signals, modal de alta/edición y refetch tras guardar.
 */
@Component({
  selector: 'app-usuarios',
  standalone: true,
  imports: [FormsModule, DatePipe, ConfirmDialogComponent],
  templateUrl: './usuarios.component.html',
  styleUrl: './usuarios.component.scss',
})
export class UsuariosComponent {
  private readonly usuarios = inject(UsuariosService);
  private readonly session = inject(SessionService);

  readonly currentUserId = computed(() => this.session.user()?.id ?? null);

  readonly itemsQuery = injectQuery(() => ({
    queryKey: ['usuarios', 'items'],
    queryFn: () => firstValueFrom(this.usuarios.getAll()),
    staleTime: 15_000,
  }));

  readonly items = computed<AppUser[]>(() => this.itemsQuery.data()?.items ?? []);

  // ── Modal de alta/edición ──
  readonly showForm = signal(false);
  readonly form = signal<UserForm>(emptyForm());
  readonly saving = signal(false);
  readonly errorMsg = signal<string | null>(null);

  openCreate(): void {
    this.form.set(emptyForm());
    this.errorMsg.set(null);
    this.showForm.set(true);
  }

  openEdit(item: AppUser): void {
    this.form.set({
      id: item.id, username: item.username, displayName: item.displayName ?? '',
      activo: item.activo, password: '',
    });
    this.errorMsg.set(null);
    this.showForm.set(true);
  }

  updateForm<K extends keyof UserForm>(key: K, value: UserForm[K]): void {
    this.form.update((f) => ({ ...f, [key]: value }));
  }

  async save(): Promise<void> {
    const f = this.form();
    if (f.username.trim().length < 3) { this.errorMsg.set('El usuario debe tener al menos 3 caracteres'); return; }
    if (f.id == null && f.password.length < 8) { this.errorMsg.set('La contraseña debe tener al menos 8 caracteres'); return; }
    if (f.password && f.password.length < 8) { this.errorMsg.set('La contraseña debe tener al menos 8 caracteres'); return; }
    this.saving.set(true);
    this.errorMsg.set(null);
    try {
      const payload = {
        username: f.username.trim(),
        displayName: f.displayName.trim() || null,
        activo: f.activo,
        ...(f.password ? { password: f.password } : {}),
      };
      if (f.id != null) {
        await firstValueFrom(this.usuarios.update(f.id, payload));
      } else {
        await firstValueFrom(this.usuarios.create(payload as { username: string; password: string }));
      }
      await this.itemsQuery.refetch();
      this.showForm.set(false);
    } catch (e) {
      this.errorMsg.set((e as { error?: { error?: string } })?.error?.error ?? 'No se pudo guardar');
    } finally {
      this.saving.set(false);
    }
  }

  // ── Cerrar sesiones ──
  readonly closingSessionsId = signal<number | null>(null);

  async cerrarSesiones(item: AppUser): Promise<void> {
    this.closingSessionsId.set(item.id);
    try {
      await firstValueFrom(this.usuarios.cerrarSesiones(item.id));
      await this.itemsQuery.refetch();
    } catch (e) {
      this.errorMsg.set((e as { error?: { error?: string } })?.error?.error ?? 'No se pudo cerrar la sesión');
    } finally {
      this.closingSessionsId.set(null);
    }
  }

  // ── Borrar (con confirmación) ──
  readonly deletingItem = signal<AppUser | null>(null);

  confirmDelete(item: AppUser): void {
    this.deletingItem.set(item);
  }

  async doDelete(): Promise<void> {
    const item = this.deletingItem();
    if (!item) return;
    try {
      await firstValueFrom(this.usuarios.delete(item.id));
      await this.itemsQuery.refetch();
    } catch (e) {
      this.errorMsg.set((e as { error?: { error?: string } })?.error?.error ?? 'No se pudo borrar');
    } finally {
      this.deletingItem.set(null);
    }
  }
}
