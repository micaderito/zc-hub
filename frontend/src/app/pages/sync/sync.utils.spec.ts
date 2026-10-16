import { channelLabel, errorMessage, formatDate } from './sync.utils';

describe('sync.utils', () => {
  it('channelLabel() traduce los canales', () => {
    expect(channelLabel('mercadolibre')).toBe('Mercado Libre');
    expect(channelLabel('tiendanube')).toBe('Tienda Nube');
  });

  it('formatDate() formatea o devuelve "—" si no hay fecha', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate(undefined)).toBe('—');
    expect(formatDate('2026-01-01T10:00:00Z')).not.toBe('—');
  });

  it('errorMessage() prefiere el error del backend, después el de la request, después el default', () => {
    expect(errorMessage({ error: { error: 'del backend' }, message: 'http' }, 'x')).toBe('del backend');
    expect(errorMessage({ message: 'http' }, 'x')).toBe('http');
    expect(errorMessage({}, 'x')).toBe('x');
    expect(errorMessage(null, 'x')).toBe('x');
  });
});
