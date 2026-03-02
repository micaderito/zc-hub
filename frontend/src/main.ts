import { bootstrapApplication } from '@angular/platform-browser';
import { registerLocaleData } from '@angular/common';
import localeEsAr from '@angular/common/locales/es-AR';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';

registerLocaleData(localeEsAr, 'es-AR');

bootstrapApplication(AppComponent, appConfig)
  .catch((err) => console.error(err));
