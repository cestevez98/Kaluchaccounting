import { describe, expect, it } from 'vitest';
import {
  trialBalanceQuerySchema,
  convertLines, endOfMonth, formatDate, formatNumber, hasPermission, money, parseDateEs,
  parseNumberEs, roundAmount, toUsd,
} from './index';

describe('dinero', () => {
  it('redondea half-even a 4 decimales', () => {
    expect(roundAmount('1.00005').toFixed(4)).toBe('1.0000');
    expect(roundAmount('1.00015').toFixed(4)).toBe('1.0002');
    expect(roundAmount('-2.00025').toFixed(4)).toBe('-2.0002');
  });
  it('no pierde precisión con importes grandes', () => {
    expect(money('99999999999999.9999').plus('0.0001').toFixed(4)).toBe('100000000000000.0000');
  });
});

describe('conversión a USD (1 USD = X unidades)', () => {
  it('CUP con tasa informal', () => {
    expect(toUsd('12000', '400').toFixed(4)).toBe('30.0000');
  });
  it('EUR con tasa < 1', () => {
    expect(toUsd('890', '0.9').toFixed(4)).toBe('988.8889');
  });
  it('rechaza tasa 0 (origen de los #DIV/0! del Excel)', () => {
    expect(() => toUsd('10', '0')).toThrow(/Tasa inválida/);
  });
  it('calcula el residuo de redondeo de un asiento multimoneda', () => {
    const { usd, residual } = convertLines([
      { amount: '100', rate: '3' },
      { amount: '-100', rate: '3' },
      { amount: '0.01', rate: '1' },
      { amount: '-0.01', rate: '1' },
    ]);
    expect(usd.map((u) => u.toFixed(4))).toEqual(['33.3333', '-33.3333', '0.0100', '-0.0100']);
    expect(residual.isZero()).toBe(true);
  });
  it('fin de mes', () => {
    expect(endOfMonth(2026, 2)).toBe('2026-02-28');
    expect(endOfMonth(2024, 2)).toBe('2024-02-29');
    expect(endOfMonth(2026, 12)).toBe('2026-12-31');
  });
});

describe('formatos es-ES', () => {
  it('agrupa miles también con 4 cifras', () => {
    expect(formatNumber('1234.56')).toBe('1.234,56');
    expect(formatNumber('-1234567.891', 2)).toBe('-1.234.567,89');
    expect(formatNumber('0.5', 4)).toBe('0,5000');
    expect(formatNumber('12345678901234.5678', 4)).toBe('12.345.678.901.234,5678');
  });
  it('parsea números en formato español', () => {
    expect(parseNumberEs('1.234,56')).toBe('1234.56');
    expect(parseNumberEs('-10')).toBe('-10');
    expect(parseNumberEs('40.000')).toBe('40000');
    expect(parseNumberEs('1.234.567')).toBe('1234567');
    expect(parseNumberEs('10.5')).toBe('10.5');
    expect(parseNumberEs('0.9')).toBe('0.9');
    expect(() => parseNumberEs('abc')).toThrow();
  });
  it('fechas dd/mm/aaaa', () => {
    expect(formatDate('2026-04-30')).toBe('30/04/2026');
    expect(parseDateEs('1/4/2026')).toBe('2026-04-01');
    expect(() => parseDateEs('31/02/2026')).toThrow(/inexistente/);
  });
});

describe('permisos', () => {
  it('comodín y permiso concreto', () => {
    expect(hasPermission(['*'], 'ledger:post')).toBe(true);
    expect(hasPermission(['ledger:read'], 'ledger:post')).toBe(false);
    expect(hasPermission(['ledger:post'], 'ledger:post')).toBe(true);
  });
});

describe('esquemas', () => {
  it('interpreta booleanos de query string correctamente', () => {
    const base = { year: '2026', month: '5' };
    expect(trialBalanceQuerySchema.parse({ ...base, includeZero: 'false' }).includeZero).toBe(false);
    expect(trialBalanceQuerySchema.parse({ ...base, includeZero: 'true' }).includeZero).toBe(true);
    expect(trialBalanceQuerySchema.parse(base).includeZero).toBe(false);
  });
});
