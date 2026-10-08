import { describe, expect, it } from 'vitest';
import { criterionMatches, isNegationOf, linearize, normalize, UnsupportedFormula } from './linear';
import { excelNumber } from './workbook';

const EOM = '"<="&EOMONTH(DATE(G$1,G$2,1),0)';

describe('linealización de fórmulas del BC', () => {
  it('IF(A>B, A−B, 0) es un saldo partido por signo con la forma A−B', () => {
    const f = normalize(linearize(
      `IF(SUMIFS(T[CxC],T[[FECHA ]],${EOM})>SUMIFS(T[CxP],T[[FECHA ]],${EOM}),SUMIFS(T[CxC],T[[FECHA ]],${EOM})-SUMIFS(T[CxP],T[[FECHA ]],${EOM}),0)`,
      () => null,
    ));
    expect(f.split).toBe(true);
    expect(f.terms.map((t) => [t.coef, t.sheet, t.column, t.dateColumn])).toEqual([[1, 'T', 'CxC', 'FECHA '], [-1, 'T', 'CxP', 'FECHA ']]);
  });

  it('detecta la cuenta opuesta del par (135.x ↔ 405.x)', () => {
    const a = linearize(`IF(SUMIFS(T[M],T[F],${EOM})<0,-SUMIFS(T[M],T[F],${EOM}),0)`, () => null);
    const b = linearize(`IF(SUMIFS(T[M],T[F],${EOM})>0,SUMIFS(T[M],T[F],${EOM}),0)`, () => null);
    expect(isNegationOf(a, b)).toBe(true);
    expect(isNegationOf(a, a)).toBe(false);
  });

  it('la división por una tasa marca la moneda y los criterios de texto y número se conservan', () => {
    const f = linearize(`(SUMIFS(T[EUR],T[Fecha],${EOM},T[Recibido],1,T[Empresa],"KEI")-SUMIFS(T[PAGO],T[Fecha],${EOM}))/SUMIFS(Tasas[EUR/USD (OUE)],Tasas[Tasa 1USD=],EOMONTH(DATE(G$1,G$2,1),0))`, () => null);
    expect(f.rateColumn).toBe('EUR/USD (OUE)');
    expect(f.terms[0]!.criteria).toEqual([{ column: 'Recibido', value: '1' }, { column: 'Empresa', value: 'KEI' }]);
  });

  it('sustituye referencias a otras filas del BC (409 = total − 406 − 408)', () => {
    const cells: Record<number, string> = {
      133: `SUMIFS(P[A pagar USD],P[Fecha],${EOM},P[Empresa],"KEI")`,
      134: `SUMIFS(P[A pagar USD],P[Fecha],${EOM},P[Empresa],"GR")`,
    };
    const f = normalize(linearize(`SUMIFS(P[A pagar USD],P[Fecha],${EOM})-G133-G134`, (r) => cells[r] ?? null));
    expect(f.terms.map((t) => [t.coef, t.criteria.map((c) => c.value).join()])).toEqual([[1, ''], [-1, 'KEI'], [-1, 'GR']]);
  });

  it('marca los importes del mes (">=" primer día) y rechaza lo no lineal', () => {
    const f = linearize(`SUMIFS(T[X],T[F],">="&DATE(G$1,G$2,1),T[F],${EOM})`, () => null);
    expect(f.terms[0]!.monthly).toBe(true);
    expect(() => linearize(`SUMIFS(T[X],T[F],${EOM})*2`, () => null)).toThrow(UnsupportedFormula);
    expect(() => linearize(`SUMIFS(T[X],T[Y],"a")`, () => null)).toThrow(/sin fecha de corte/);
  });

  it('criterios con "<>" y números con formato de fecha', () => {
    expect(criterionMatches('MPM DMILIO', '<>MPM DMILIO')).toBe(false);
    expect(criterionMatches('PALCO', '<>MPM DMILIO')).toBe(true);
    expect(excelNumber(new Date(Math.round((45000.5 - 25569) * 86_400_000)))).toBeCloseTo(45000.5, 8);
    expect(excelNumber('12')).toBeNull();
    expect(excelNumber(-3.5)).toBe(-3.5);
  });
});
