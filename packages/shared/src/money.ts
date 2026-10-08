import Decimal from 'decimal.js';

/**
 * Aritmética monetaria exacta. Nunca usar `number` para importes.
 * Importes: 4 decimales (NUMERIC(18,4)). Tasas: 10 decimales (NUMERIC(20,10)).
 */
export const Money = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });
export type Money = Decimal;

export const AMOUNT_SCALE = 4;
export const RATE_SCALE = 10;

export type DecimalLike = Decimal.Value | { toString(): string };

export function money(value: DecimalLike): Decimal {
  return new Money(typeof value === 'object' && !(value instanceof Decimal) ? value.toString() : value);
}

/** Redondea a la escala de importes (4 d, half-even). */
export function roundAmount(value: DecimalLike): Decimal {
  return money(value).toDecimalPlaces(AMOUNT_SCALE, Decimal.ROUND_HALF_EVEN);
}

export function roundRate(value: DecimalLike): Decimal {
  return money(value).toDecimalPlaces(RATE_SCALE, Decimal.ROUND_HALF_EVEN);
}

export function sum(values: DecimalLike[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(money(v)), new Money(0));
}

/** Representación canónica para persistir (string con 4 decimales). */
export function toAmountString(value: DecimalLike): string {
  return roundAmount(value).toFixed(AMOUNT_SCALE);
}
