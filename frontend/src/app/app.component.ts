import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { GlobalErrorService } from './core/services/global-error.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent {
  title = 'Zona Cuaderno Hub';
  readonly globalError = inject(GlobalErrorService);
}
