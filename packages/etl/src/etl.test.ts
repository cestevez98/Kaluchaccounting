import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { parseChartOfAccounts } from './coa';
import { parseRates } from './rates';
import { asIsoDate, readCell } from './workbook';

/** Hoja BC sintética con la misma estructura que el Excel (sin datos reales). */
function bcSheet() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('BC');
  ws.getRow(1).values = [null, null, null, null, null, null, 2026, 2026];
  ws.getRow(2).values = ['Descripcion de la cuenta', 'No. usado', 'Naturaleza', 'Clasificacion', 'Cuenta', 'Subcuenta', 4, 5];
  ws.getRow(3).values = ['Efectivo en Caja', '101', 'Deudora', 'AC', 101, null, 150, 200];
  ws.getRow(4).values = ['Efectivo en Caja - CUP', '101.0001', 'Deudora', 'AC', 101, '0001'];
  ws.getCell('G4').value = { formula: 'SUMIFS(Efectivo_Caja[Entrada CUP])/SUMIFS(Tasas[CUP/USD (IC)],Tasas[Tasa 1USD=],1)', result: 100 } as never;
  ws.getCell('H4').value = { formula: 'x', result: 120 } as never;
  ws.getRow(5).values = ['Efectivo en Caja - USD', '101.0002', 'Deudora', 'AC', 101, '0002', 50, 80];
  ws.getRow(6).values = ['Efectivo en Caja - CAD', '101.0004', 'Deudora', 'AC', 101, '0004'];
  ws.getCell('G6').value = { formula: 'SUMIFS(x)/SUMIFS(Tasas[MLC/USD (IC)],y)', result: 3 } as never;
  ws.getRow(7).values = ['Banco EUR - Demo', '110.3803', 'Deudora', 'AC', 110, 3803, 10, 10];
  ws.getRow(8).values = ['Banco EUR - Demo 2', '110.3803', 'Deudora', 'AC', 110, 3803, 0, 0];
  ws.getRow(9).values = ['Ventas de Bienes Internas', '1900', 'Deudora', 'CNA', 1900, null, 5, 5];
  ws.getRow(10).values = ['Mercancías', '1181', 'Acreedora', 'AC', 1181, null];
  ws.getCell('G10').value = { error: '#REF!' } as never;
  ws.getRow(12).values = ['ING 777', null, null, null, null, null, 42, 43];
  return ws;
}

describe('ETL: plan de cuentas desde BC', () => {
  const r = parseChartOfAccounts(bcSheet());

  it('detecta meses, cuentas, jerarquía y subcuentas', () => {
    expect(r.months).toEqual([{ col: 7, year: 2026, month: 4 }, { col: 8, year: 2026, month: 5 }]);
    expect(r.accounts.map((a) => `${a.code}${a.subcode ? '.' + a.subcode : ''}`)).toEqual([
      '101', '101.0001', '101.0002', '101.0004', '110.3803', '110.3803', '1900', '1181',
    ]);
  });

  it('toma el tipo de tasa de la fórmula y bloquea la moneda en tesorería', () => {
    const cup = r.accounts.find((a) => a.subcode === '0001')!;
    expect(cup).toMatchObject({ revalRateType: 'IC', revalCurrency: 'CUP', currencyLock: 'CUP' });
    const usd = r.accounts.find((a) => a.subcode === '0002')!;
    expect(usd).toMatchObject({ revalRateType: null, currencyLock: 'USD' });
  });

  it('omite la caja CAD (decisión P3) conservando su moneda real', () => {
    const cad = r.accounts.find((a) => a.subcode === '0004')!;
    expect(cad).toMatchObject({ active: false, currencyLock: 'CAD', revalRateType: null });
    expect(cad.anomaly).toMatch(/omitida/);
  });

  it('marca anomalías de naturaleza y cuentas intercompañía', () => {
    expect(r.accounts.find((a) => a.code === '1900')).toMatchObject({ isIntercompany: true, anomaly: expect.stringMatching(/deudora incoherente con clasificación CNA/) });
    expect(r.accounts.find((a) => a.code === '1181')!.anomaly).toMatch(/acreedora incoherente con clasificación AC/);
  });

  it('extrae valores de referencia, totales de control y registra errores del Excel', () => {
    expect(r.references.filter((x) => x.fullCode === '101.0001').map((x) => x.valueUsd)).toEqual(['100.0000', '120.0000']);
    expect(r.references.find((x) => x.fullCode === 'CONTROL:ING 777' && x.month === 5)?.valueUsd).toBe('43.0000');
    expect(r.issues.some((i) => i.includes('#REF!'))).toBe(true);
  });
});

describe('ETL: tasas', () => {
  it('mapea columnas, descarta 0 y avisa de fechas repetidas', () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Tasas');
    ws.getRow(1).values = ['Tasa 1USD=', 'CUP/USD (IC)', 'EUR/USD (OUE)', 'CUP/EUR (OC)', 'XYZ'];
    ws.getRow(2).values = [new Date(Date.UTC(2026, 3, 30)), 400, 0.87, 0, 1];
    ws.getRow(3).values = [new Date(Date.UTC(2026, 3, 30)), 401, 0.88, 0, 1];
    ws.getRow(4).values = [46143, 405, 0.9, 470, 1];
    const r = parseRates(ws);
    expect(r.unknownColumns).toEqual(['XYZ']);
    expect(r.duplicateDates).toEqual(['2026-04-30']);
    expect(r.skipped).toBe(1);
    expect(r.rows).toContainEqual({ rateDate: '2026-04-30', currency: 'CUP', rateType: 'IC', base: 'USD', rate: '400.0000000000' });
    expect(r.rows).toContainEqual({ rateDate: '2026-05-01', currency: 'CUP', rateType: 'OC', base: 'EUR', rate: '470.0000000000' });
  });
});

describe('ETL: utilidades', () => {
  it('convierte fechas serial de Excel (Banco_Emp_Cuba)', () => {
    expect(asIsoDate(45414)).toBe('2024-05-02');
    expect(asIsoDate(46174)).toBe('2026-06-01');
    expect(asIsoDate('texto')).toBeNull();
  });
  it('lee errores de celda', () => {
    const ws = new ExcelJS.Workbook().addWorksheet('x');
    ws.getCell('A1').value = { error: '#DIV/0!' } as never;
    expect(readCell(ws, 1, 1).error).toBe('#DIV/0!');
  });
});
