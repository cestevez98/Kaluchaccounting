import { money, type DecimalLike } from './money';

/**
 * Formatos es-ES. Nota: Intl con 'es-ES' no agrupa números de 4 cifras
 * (muestra "1234,56"); se fuerza `useGrouping: 'always'` para obtener "1.234,56".
 */
const formatters = new Map<number, Intl.NumberFormat>();

function formatter(decimals: number): Intl.NumberFormat {
  let f = formatters.get(decimals);
  if (!f) {
    f = new Intl.NumberFormat('es-ES', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      // 'always' es válido en Intl.NumberFormat v3 (Node 20+, navegadores actuales).
      useGrouping: 'always' as unknown as boolean,
    });
    formatters.set(decimals, f);
  }
  return f;
}

/** 1234.5 → "1.234,50". Formatea por string para no perder precisión en importes grandes. */
export function formatNumber(value: DecimalLike | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || value === '') return '';
  const d = money(value).toDecimalPlaces(decimals);
  const negative = d.isNegative() && !d.isZero();
  const [intPart = '0', fracPart = ''] = d.abs().toFixed(decimals).split('.');
  const grouped = formatter(0).format(BigInt(intPart));
  return `${negative ? '-' : ''}${grouped}${decimals > 0 ? ',' + fracPart : ''}`;
}

/**
 * "1.234,56" → "1234.56". En es-ES el punto agrupa miles: "40.000" → "40000".
 * Sin coma, un único punto que no separa grupos de 3 cifras se toma como decimal ("10.5").
 */
export function parseNumberEs(input: string): string {
  const s = input.trim().replace(/\s/g, '');
  if (s === '') throw new Error('Número vacío');
  let normalized: string;
  if (s.includes(',')) normalized = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) normalized = s.replace(/\./g, '');
  else normalized = s;
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) throw new Error(`Número no válido: ${input}`);
  return normalized;
}

/** "2026-04-30" (o Date) → "30/04/2026". Las fechas contables no tienen zona horaria. */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '';
  const iso = typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** "30/04/2026" → "2026-04-30". */
export function parseDateEs(input: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(input.trim());
  if (!m) throw new Error(`Fecha no válida (dd/mm/aaaa): ${input}`);
  const [, d, mo, y] = m;
  const iso = `${y}-${mo!.padStart(2, '0')}-${d!.padStart(2, '0')}`;
  const check = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== iso) {
    throw new Error(`Fecha inexistente: ${input}`);
  }
  return iso;
}

export const MONTH_NAMES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
] as const;
