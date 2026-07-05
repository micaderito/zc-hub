import { TestBed } from '@angular/core/testing';
import { ThemeService } from './theme.service';

describe('ThemeService', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
  });

  it('arranca en "light" si <html> no tiene data-theme', () => {
    document.documentElement.removeAttribute('data-theme');
    const service = TestBed.inject(ThemeService);
    expect(service.theme()).toBe('light');
  });

  it('arranca en "dark" si <html data-theme="dark"> ya estaba seteado (script anti-FOUC)', () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    const service = TestBed.inject(ThemeService);
    expect(service.theme()).toBe('dark');
  });

  it('set() actualiza el signal y el atributo data-theme del documento', () => {
    const service = TestBed.inject(ThemeService);
    service.set('dark');
    expect(service.theme()).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('set() persiste el tema en localStorage', () => {
    const service = TestBed.inject(ThemeService);
    service.set('dark');
    expect(localStorage.getItem('zc-theme')).toBe('dark');
    localStorage.removeItem('zc-theme');
  });

  it('toggle() alterna entre light y dark', () => {
    document.documentElement.setAttribute('data-theme', 'light');
    const service = TestBed.inject(ThemeService);
    expect(service.theme()).toBe('light');

    service.toggle();
    expect(service.theme()).toBe('dark');

    service.toggle();
    expect(service.theme()).toBe('light');
  });

  it('set() no rompe si localStorage.setItem lanza una excepción', () => {
    const service = TestBed.inject(ThemeService);
    spyOn(localStorage, 'setItem').and.throwError('storage no disponible');
    expect(() => service.set('dark')).not.toThrow();
    expect(service.theme()).toBe('dark');
  });
});
