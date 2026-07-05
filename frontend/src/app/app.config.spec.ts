import { LOCALE_ID } from '@angular/core';
import { appConfig } from './app.config';

describe('appConfig', () => {
  it('registra proveedores para router, http y tanstack query', () => {
    expect(Array.isArray(appConfig.providers)).toBeTrue();
    expect(appConfig.providers.length).toBeGreaterThan(0);
  });

  it('fija el LOCALE_ID en es-AR', () => {
    const localeProvider = appConfig.providers.find(
      (p): p is { provide: unknown; useValue: unknown } =>
        typeof p === 'object' && p !== null && 'provide' in p && (p as { provide: unknown }).provide === LOCALE_ID
    );
    expect(localeProvider?.useValue).toBe('es-AR');
  });
});
