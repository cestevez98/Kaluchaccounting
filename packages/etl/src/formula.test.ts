import { describe, expect, it } from 'vitest';
import { normalizeReference, knownCategoryFor, guessKind } from './categories';
import { excelCriterionMatches, parseSumifs, termMatchesRow } from './formula';

const BANK = `=(SUMIFS(Banco_Emp_Cuba[Entradas CUP],Banco_Emp_Cuba[Propietario],"Dmilio",Banco_Emp_Cuba[Banco],"Metropolitano",Banco_Emp_Cuba[Fecha],"<="&EOMONTH(DATE(G$1,G$2,1),0))
-SUMIFS(Banco_Emp_Cuba[Salidas CUP],Banco_Emp_Cuba[Propietario],"Dmilio",Banco_Emp_Cuba[Banco],"Metropolitano",Banco_Emp_Cuba[Fecha],"<="&EOMONTH(DATE(G$1,G$2,1),0)))
/SUMIFS(Tasas[CUP/USD (IC)],Tasas[Tasa 1USD=],EOMONTH(DATE(G$1,G$2,1),0))`;

const CASH = `=(SUMIFS(Efectivo_Caja[Entrada CUP],Efectivo_Caja[FECHA],"<="&EOMONTH(DATE(G$1,G$2,1),0))
+SUMIFS(Efectivo_Caja[Salida CUP],Efectivo_Caja[FECHA],"<="&EOMONTH(DATE(G$1,G$2,1),0)))/SUMIFS(Tasas[CUP/USD (IC)],Tasas[Tasa 1USD=],EOMONTH(DATE(G$1,G$2,1),0))`;

describe('fórmulas SUMIFS del BC', () => {
  it('extrae términos con signo, columna, moneda y criterios (sin fecha ni Tasas)', () => {
    expect(parseSumifs(BANK)).toEqual([
      { sign: 1, sheet: 'Banco_Emp_Cuba', column: 'Entradas CUP', currency: 'CUP', criteria: [{ column: 'Propietario', value: 'Dmilio' }, { column: 'Banco', value: 'Metropolitano' }] },
      { sign: -1, sheet: 'Banco_Emp_Cuba', column: 'Salidas CUP', currency: 'CUP', criteria: [{ column: 'Propietario', value: 'Dmilio' }, { column: 'Banco', value: 'Metropolitano' }] },
    ]);
  });
  it('en caja las salidas se suman (vienen en negativo en el Excel)', () => {
    expect(parseSumifs(CASH).map((t) => [t.sign, t.column])).toEqual([[1, 'Entrada CUP'], [1, 'Salida CUP']]);
  });
});

describe('criterios de Excel', () => {
  it('no distinguen mayúsculas', () => {
    expect(excelCriterionMatches('STRIPE', 'Stripe')).toBe(true);
  });
  it('soportan comodines * y ?, y ~ como escape', () => {
    expect(excelCriterionMatches('Fincimex *6530', 'Fincimex *6530')).toBe(true);
    expect(excelCriterionMatches('Fincimex 1236530', 'Fincimex *6530')).toBe(true);
    expect(excelCriterionMatches('Fincimex 6531', 'Fincimex *6530')).toBe(false);
    expect(excelCriterionMatches('AB', 'A?')).toBe(true);
    expect(excelCriterionMatches('A*', 'A~*')).toBe(true);
    expect(excelCriterionMatches('AB', 'A~*')).toBe(false);
  });
  it('no es un "contiene": Metropolitano no coincide con MetropolitanoG', () => {
    expect(excelCriterionMatches('MetropolitanoG', 'Metropolitano')).toBe(false);
  });
  it('vacío solo coincide con vacío', () => {
    expect(excelCriterionMatches(null, '')).toBe(true);
    expect(excelCriterionMatches('x', '')).toBe(false);
  });
  it('aplica todos los criterios del término a la fila', () => {
    const [t] = parseSumifs(BANK);
    expect(termMatchesRow(t!, { Propietario: 'DMILIO', Banco: 'Metropolitano' })).toBe(true);
    expect(termMatchesRow(t!, { Propietario: 'Grupo Roca', Banco: 'Metropolitano' })).toBe(false);
  });
});

describe('categorías', () => {
  it('normaliza variantes de "Referencia cruzada"', () => {
    expect(normalizeReference('  Seguridad ')).toBe('seguridad');
    expect(normalizeReference('Financiamiento')).toBe('financiamientos');
    expect(normalizeReference('?')).toBeNull();
  });
  it('resuelve categorías que dependen de la hoja', () => {
    expect(knownCategoryFor('Banco_Emp_Cuba', 'impuesto')?.code).toBe('IMPUESTO_ONAT');
    expect(knownCategoryFor('Banco_Emp_Exterior', 'impuesto')?.code).toBe('IMPUESTO_DGII');
    expect(knownCategoryFor('Efectivo_Caja', 'seguridad almacén')?.code).toBe('SEGURIDAD_DIST');
    expect(guessKind('deuda eduardo')).toBe('DEBT');
  });
});
