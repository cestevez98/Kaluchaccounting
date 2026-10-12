import ExcelJS from 'exceljs';
import { formulaOrder } from '@kaluch/shared';
import { describe, expect, it } from 'vitest';
import {
  accountCodeFromCell, completeBalanceSheet, parseCashFlowSheet, parseStatementSheet, STATEMENT_SHEETS, translateTotalFormula,
} from './statements-import';

const f = (formula: string, result: unknown) => ({ formula, result }) as never;

/** Hoja ES sintética con la estructura del Excel (sin datos reales). */
function esSheet() {
  const ws = new ExcelJS.Workbook().addWorksheet('ES');
  ws.getRow(1).values = ['ESTADO DE SITUACIÓN', 2026, 2026];
  ws.getRow(2).values = [null, 5, 6];
  const rows: [number, string, [unknown, unknown], string | null, number | string | null][] = [
    [3, 'ACTIVOS', [f('+B4+B7', 130), f('+C4+C7', 160)], null, null],
    [4, 'Efectivo', [f('SUM(B5:B6)', 100), f('SUM(C5:C6)', 120)], null, null],
    [5, 'Efectivo en caja', [f('SUMIFS(Efectivo_Caja[Mov],x,1)', 60), f('SUMIFS(Efectivo_Caja[Mov],x,1)', 70)], '-', 101],
    [6, 'Efectivo en banco', [f('SUMIFS(Banco[Mov],x,1)', 40), f('SUMIFS(Banco[Mov],x,1)', 50)], '-', 109],
    [7, 'Mercancía', [30, 40], '-', 180],
    [9, 'PATRIMONIO + PASIVO', [f('+B10+B14', 80), f('+C10+C14', 90)], null, null],
    [10, 'PASIVOS', [f('+B11', 70), f('+C11', 80)], null, null],
    [11, 'Proveedores', [f('SUMIFS(Deuda[A pagar],x,1)', 70), f('SUMIFS(Deuda[A pagar],x,1)', 80)], '-', 406],
    [12, 'Comisiones', [f('SUMIFS(Comisiones[A pagar],x,1)', 10), f('SUMIFS(Comisiones[A pagar],x,1)', 10)], '-', 410],
    [14, 'PATRIMONIO', [f('+B15', 0), f('+C15', 0)], null, null],
    [15, 'Capital', [null, null], null, null],
  ];
  for (const [r, label, [b, c], , code] of rows) {
    ws.getCell(r, 1).value = label;
    if (b !== null) ws.getCell(r, 2).value = b as never;
    if (c !== null) ws.getCell(r, 3).value = c as never;
    if (code !== null) ws.getCell(r, 30).value = code;
  }
  // Comprobación del propio Excel (2 = cuadra con el BC) en la columna de mayo.
  ws.getCell(2, 29).value = 5;
  ws.getCell(5, 29).value = f('IF(B5=SUMIFS(BC!H:H,BC!$B:$B,$AD5),2,0)', 2);
  ws.getCell(6, 29).value = f('IF(B6=SUMIFS(BC!H:H,BC!$B:$B,$AD6),2,0)', 0);
  return ws;
}

describe('ETL: plantillas de los estados financieros', () => {
  it('códigos de cuenta como los escribe el BC', () => {
    expect(accountCodeFromCell(849.888)).toBe('849.8880');
    expect(accountCodeFromCell(926.8882)).toBe('926.8882');
    expect(accountCodeFromCell(101)).toBe('101');
    expect(accountCodeFromCell('843.999-AL')).toBe('843.999-AL');
    expect(accountCodeFromCell('-')).toBeNull();
  });

  it('traduce los totales del Excel a fórmulas entre líneas', () => {
    expect(translateTotalFormula('=+B4+B13+B19', 'B')).toBe('[F4]+[F13]+[F19]');
    expect(translateTotalFormula('=SUM(C3:C5)', 'C')).toBe('SUM([F3]:[F5])');
    // Las fórmulas compartidas llegan con el texto de la celda maestra (otra columna): se aceptan si citan una sola columna.
    expect(translateTotalFormula('=+B4+B13', 'I')).toBe('[F4]+[F13]');
    expect(translateTotalFormula('=IF(DATE(B$1,B$2,1)>TODAY(),0,-1500)', 'B')).toBe('-1500');
    expect(translateTotalFormula('=IF(DATE(B$1,B$2,1)>TODAY(),0,IF(-B$50*0.05*0.9>0,0,-B$50*0.05*0.9))', 'B')).toBe('MIN(0,-[F50]*0.05*0.9)');
    expect(translateTotalFormula('=SUMIFS(Tabla[Importe],Tabla[Fecha],">="&B1)', 'B')).toBeNull();
    expect(translateTotalFormula('=IF(-SUM(H53:J53)*0.05>0,0,-SUM(H53:J53)*0.05)', 'J')).toBeNull();
  });

  it('lee líneas, cuentas, totales, cifras y la comprobación del Excel', () => {
    const p = parseStatementSheet(esSheet(), STATEMENT_SHEETS[0]!);
    const byKey = Object.fromEntries(p.lines.map((l) => [l.key, l]));
    expect(byKey.F3).toMatchObject({ source: 'FORMULA', formula: '[F4]+[F7]', bold: true });
    expect(byKey.F4).toMatchObject({ source: 'FORMULA', formula: 'SUM([F5]:[F6])' });
    expect(byKey.F5).toMatchObject({ source: 'ACCOUNTS', accounts: ['101'] });
    expect(byKey.F15).toMatchObject({ source: 'NONE', label: 'Capital' });
    const ref = (k: string, m: number) => p.references.find((r) => r.lineKey === k && r.month === m);
    expect(ref('F5', 5)).toMatchObject({ valueUsd: '60.0000', excelCheck: true, manual: false });
    expect(ref('F6', 5)).toMatchObject({ excelCheck: false });
    expect(ref('F7', 6)).toMatchObject({ valueUsd: '40.0000', manual: true });
  });

  it('completa el estado de situación: patrimonio, cuentas sin línea y totales que no suman todas sus líneas', () => {
    const p = completeBalanceSheet(parseStatementSheet(esSheet(), STATEMENT_SHEETS[0]!));
    const byKey = Object.fromEntries(p.lines.map((l) => [l.key, l]));
    expect(byKey.F3!.formula).toBe('[F4]+[F7]+[ACT_OTROS]');
    // PASIVOS (=B11) no sumaba Comisiones (fila 12).
    expect(byKey.F10!.formula).toBe('[F11]+[F12]+[PAS_OTROS]');
    expect(p.notes.some((n) => n.includes('PASIVOS no sumaba "Comisiones"'))).toBe(true);
    expect(byKey.F14!.formula).toBe('[PN_CAPITAL]+[PN_RETENIDAS]+[PN_OTRAS]+[PN_SIN_CERRAR]+[PN_RESULTADO]+[PN_PENDIENTE]');
    expect(byKey.PN_CAPITAL).toMatchObject({ source: 'ACCOUNTS', accounts: ['600'] });
    expect(byKey.CONTROL!.formula).toBe('[F3]-[F9]');
    expect(() => formulaOrder(p.lines)).not.toThrow();
  });

  it('flujo de efectivo: actividades y categorías de la hoja EFE, con el resto de cada actividad', () => {
    const ws = new ExcelJS.Workbook().addWorksheet('EFE');
    ws.getCell('B2').value = 'ESTADO DE FLUJO DE EFECTIVO';
    ws.getCell('A6').value = 'Saldo inicial';
    ws.getCell('B8').value = 'Explotación';
    ws.getCell('A10').value = 'Ventas mayoristas';
    ws.getCell('A11').value = 'Salarios';
    ws.getCell('B13').value = 'Financiación';
    ws.getCell('A15').value = 'Aporte del socio';
    const p = parseCashFlowSheet(ws, STATEMENT_SHEETS.find((s) => s.code === 'EFE')!);
    const byKey = Object.fromEntries(p.lines.map((l) => [l.key, l]));
    expect(byKey.F8!.formula).toBe('[F10]+[F11]+[OTROS_OPER]');
    expect(byKey.F10).toMatchObject({ source: 'CASH', categories: ['Ventas mayoristas'], cashFlow: 'OPER' });
    expect(byKey.F15).toMatchObject({ cashFlow: 'FIN' });
    expect(byKey.SALDO_CALCULADO!.formula).toBe('[SALDO_INICIAL]+[F8]+[F13]+[FX]');
    expect(byKey.CONTROL!.formula).toBe('[SALDO_CALCULADO]-[SALDO_FINAL]');
  });
});
