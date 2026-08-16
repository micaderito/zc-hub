import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { SessionService } from '../../core/services/session.service';

/** Pantalla de login del hub: usuario y contraseña, sin sidebar. */
@Component({
  selector: 'app-login',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss',
})
export class LoginComponent {
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);

  readonly username = signal('');
  readonly password = signal('');
  readonly loading = signal(false);
  readonly errorMsg = signal<string | null>(null);

  constructor() {
    // Ya logueada (token válido en localStorage) y entra a /login igual: no tiene sentido pedirle
    // de nuevo, la manda directo adentro.
    if (this.session.isAuthenticated()) this.router.navigateByUrl('/');
  }

  async submit(): Promise<void> {
    const username = this.username().trim();
    const password = this.password();
    if (!username || !password) {
      this.errorMsg.set('Usuario y contraseña son requeridos');
      return;
    }
    this.loading.set(true);
    this.errorMsg.set(null);
    try {
      await this.session.login(username, password);
      this.router.navigateByUrl('/');
    } catch (e) {
      this.errorMsg.set((e as { error?: { error?: string } })?.error?.error ?? 'No se pudo iniciar sesión');
    } finally {
      this.loading.set(false);
    }
  }
}
