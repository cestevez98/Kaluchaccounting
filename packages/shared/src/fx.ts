import Decimal from 'decimal.js';
import { money, roundAmount, sum, type DecimalLike } from './money';

/** Moneda funcional y de reporte del grupo. */
export const FUNCTIONAL_CURRENCY = 'USD';

export const CURRENCIES = ['USD', 'CUP', 'MLC', 'EUR', 'DOP', 'CAD', 'GBP'] as const;
export type CurrencyCode = (typeof CURRENCIES)[number];

/** Tipos de tasa según su fuente (hoja "Tasas" del Excel). */
export const RATE_TYPES = {
  OC: 'Oficial',
  IC: 'Informal',
  OUE: 'Oficial Unión Europea',
  ORD: 'Oficial República Dominicana',
} as const;
export type RateTypeCode = keyof typeof RATE_TYPES;

/** Tipo de tasa por defecto por moneda (valor inicial del parámetro fx.default_rate_type). */
export const DEFAULT_RATE_TYPES: Record<string, RateTypeCode> = {
  CUP: 'IC', MLC: 'IC', EUR: 'IC', DOP: 'ORD', CAD: 'OUE', GBP: 'OUE',
};

/**
 * Convención (igual que el Excel): la tasa expresa cuántas unidades de la moneda
 * equivalen a 1 USD ("Tasa 1USD="). Por tanto: importe_usd = importe / tasa.
 * Ejemplo: CUP/USD (IC) = 400 → 12.000 CUP = 30 USD.
 */
export function toUsd(amount: DecimalLike, rate: DecimalLike): Decimal {
  const r = money(rate);
  if (r.lte(0)) {
    throw new Error(`Tasa inválida (${r.toString()}): debe ser mayor que 0`);
  }
  return roundAmount(money(amount).div(r));
}

export interface FxLineInput {
  amount: DecimalLike;
  rate: DecimalLike;
}

/**
 * Convierte líneas a USD y calcula el residuo de redondeo del asiento.
 * El residuo (Σ USD) debe ser 0 en un asiento cuadrado; si es distinto de 0 pero
 * está dentro de la tolerancia, se compensa con una línea de redondeo.
 */
export function convertLines(lines: FxLineInput[]): { usd: Decimal[]; residual: Decimal } {
  const usd = lines.map((l) => toUsd(l.amount, l.rate));
  return { usd, residual: sum(usd) };
}

/** Tasa de cierre: el último día del mes (YYYY-MM-DD). */
export function endOfMonth(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month, 0));
  return d.toISOString().slice(0, 10);
}
