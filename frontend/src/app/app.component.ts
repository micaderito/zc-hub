import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { GlobalErrorService } from './core/services/global-error.service';
import { UpdateBannerComponent } from './shared/components/update-banner/update-banner.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, UpdateBannerComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent {
  title = 'Zona Cuaderno Hub';
  readonly globalError = inject(GlobalErrorService);
}
