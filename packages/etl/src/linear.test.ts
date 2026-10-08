import { describe, expect, it } from 'vitest';
import { criterionMatches, isNegationOf, linearize, normalize, UnsupportedFormula, ROW_PREFIX } from './linear';
import { controlRows } from './coa';
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
    // Sin fecha de corte: estado actual (todas las filas).
    expect(linearize(`SUMIFS(T[X],T[Y],"")`, () => null).terms[0]!.dateColumn).toBeNull();
  });

  it('criterios con "<>" y números con formato de fecha', () => {
    expect(criterionMatches('MPM DMILIO', '<>MPM DMILIO')).toBe(false);
    expect(criterionMatches('PALCO', '<>MPM DMILIO')).toBe(true);
    expect(linearize(`SUMIFS(T[X],T[F],${EOM},T[P],"<>"&"*Doping*",T[C],"<="&0)`, () => null).terms[0]!.criteria)
      .toEqual([{ column: 'P', value: '<>*Doping*' }, { column: 'C', value: '<=0' }]);
    expect(criterionMatches(-5, '<=0')).toBe(true);
    expect(criterionMatches(3, '<=0')).toBe(false);
    expect(criterionMatches(null, '<=0')).toBe(false);
    expect(criterionMatches('Doping Cola', '<>*Doping*')).toBe(false);
    expect(criterionMatches('x', '<>')).toBe(true);
    expect(criterionMatches(null, '<>')).toBe(false);
    expect(criterionMatches(1, '1')).toBe(true);
    expect(excelNumber(new Date(Math.round((45000.5 - 25569) * 86_400_000)))).toBeCloseTo(45000.5, 8);
    expect(excelNumber('12')).toBeNull();
    expect(excelNumber(-3.5)).toBe(-3.5);
  });
});

describe('fase 4: criterios con celda del BC y filas enteras de otra hoja', () => {
  it('un criterio que cita una celda del BC toma su valor', () => {
    const f = linearize(
      'SUMIFS(Efectivo_Caja[Mov USD],Efectivo_Caja[FECHA],">="&DATE(H$1,H$2,1),Efectivo_Caja[FECHA],"<="&EOMONTH(DATE(H$1,H$2,1),0),Efectivo_Caja[Referencia Cruzada],$A239)',
      () => null, 0, (col, row) => (col === 'A' && row === 239 ? 'Gastos por Inversión - Mercado 1ra y 12' : null),
    );
    expect(f.terms[0]).toMatchObject({ sheet: 'Efectivo_Caja', monthly: true, criteria: [{ column: 'Referencia Cruzada', value: 'Gastos por Inversión - Mercado 1ra y 12' }] });
  });

  it('SUMIFS sobre una fila de otra hoja con las fechas en la fila 1', () => {
    const f = linearize('SUMIFS(Capital!20:20,Capital!$1:$1,">="&DATE(H$1,H$2,1),Capital!$1:$1,"<="&EOMONTH(DATE(H$1,H$2,1),0))', () => null);
    expect(f.terms).toEqual([{ coef: 1, sheet: 'Capital!20', column: `${ROW_PREFIX}20`, dateColumn: `${ROW_PREFIX}1`, monthly: true, criteria: [] }]);
  });

  it('filas que suma un total de control', () => {
    expect(controlRows('+H166+H171+H179')).toEqual([166, 171, 179]);
    expect(controlRows('SUBTOTAL(9,H314:H315)')).toEqual([314, 315]);
    expect(controlRows("+'ERDop 777'!C21")).toBeNull();
  });
});
