/**
 * "1/10" de un día del informe. El backend lo manda como timestamp (`date_trunc` → medianoche UTC),
 * y `new Date()` en la hora argentina lo corría al día anterior ("30/9" para el 1/10): se usa la fecha
 * tal cual viene, sin pasarla por la zona horaria.
 */
export function formatDay(iso: string): string {
  const [, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d}/${m}`;
}

/** Un mes calendario, para el select de presets del toolbar. */
export interface MonthOption {
  value: string; // 'YYYY-MM'
  label: string;
  from: string; // 'YYYY-MM-DD'
  to: string;
}
