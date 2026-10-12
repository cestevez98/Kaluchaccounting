import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { evalFormula, FormulaError, formulaOrder, parseFormula, reportLineInputSchema } from './statements';

const order = ['A', 'B', 'C', 'T', 'N'];
const vals: Record<string, string> = { A: '10', B: '-4.5', C: '2', N: '-200' };
const v = (k: string) => new Decimal(vals[k] ?? 0);
const calc = (f: string) => evalFormula(parseFormula(f), v, order).toString();

describe('fórmulas de los estados financieros', () => {
  it('suma, resta, producto, paréntesis y signo', () => {
    expect(calc('[A]+[B]')).toBe('5.5');
    expect(calc('+[A]-[C]*2')).toBe('6');
    expect(calc('([A]+[B])*2')).toBe('11');
    expect(calc('-[A]')).toBe('-10');
    expect(calc('[A]/0')).toBe('0');
  });

  it('SUM con rangos en el orden de la plantilla, MIN, MAX y ABS', () => {
    expect(calc('SUM([A]:[C])')).toBe('7.5');
    expect(calc('SUM([C]:[A])')).toBe('7.5');
    // Participación del 5 % × 0,9 sobre una utilidad negativa: 0 (como el Excel).
    expect(calc('MIN(0, -[A]*0.05*0.9)')).toBe('-0.45');
    expect(calc('MIN(0, -[N]*0.05*0.9)')).toBe('0');
    expect(calc('MAX([A],[B],[C])')).toBe('10');
    expect(calc('ABS([B])')).toBe('4.5');
  });

  it('errores de sintaxis legibles', () => {
    expect(() => parseFormula('[A]+')).toThrow(FormulaError);
    expect(() => parseFormula('[A')).toThrow('Falta cerrar');
    expect(() => parseFormula('FOO([A])')).toThrow('no válido');
    expect(() => parseFormula('')).toThrow('vacía');
  });

  it('orden de evaluación y ciclos', () => {
    const lines = [
      { key: 'A' }, { key: 'T', formula: '[S]+[A]' }, { key: 'S', formula: '[A]*2' },
    ];
    const o = formulaOrder(lines);
    expect(o.indexOf('S')).toBeLessThan(o.indexOf('T'));
    expect(() => formulaOrder([{ key: 'X', formula: '[Y]' }, { key: 'Y', formula: '[X]' }])).toThrow('circular');
    expect(() => formulaOrder([{ key: 'X', formula: '[Z]' }])).toThrow('no existe');
  });

  it('valida las líneas del diseñador', () => {
    expect(reportLineInputSchema.safeParse({ key: 'X', label: 'x', source: 'FORMULA', formula: '[A]+' }).success).toBe(false);
    expect(reportLineInputSchema.safeParse({ key: 'X', label: 'x', source: 'ACCOUNTS' }).success).toBe(false);
    expect(reportLineInputSchema.safeParse({ key: 'X', label: 'x', source: 'ACCOUNTS', accounts: ['101'] }).success).toBe(true);
  });
});
