import { Component, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { GlobalErrorService } from './core/services/global-error.service';
import { ThemeService } from './core/services/theme.service';

interface NavItem {
  path: string;
  label: string;
  icon: string;
  exact?: boolean;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent {
  title = 'Zona Cuaderno Hub';
  readonly globalError = inject(GlobalErrorService);
  readonly theme = inject(ThemeService);
  readonly collapsed = signal(false);

  toggleSidebar() {
    this.collapsed.update(v => !v);
  }

  readonly nav: NavItem[] = [
    { path: '/', label: 'Inicio', icon: 'ti-layout-dashboard', exact: true },
    { path: '/precio-stock', label: 'Productos', icon: 'ti-box' },
    { path: '/crear', label: 'Crear producto', icon: 'ti-plus' },
    { path: '/conflictos', label: 'Conflictos', icon: 'ti-alert-triangle' },
    { path: '/sincronizacion', label: 'Sincronización', icon: 'ti-refresh' }
  ];
}
