import type { AccountSeedRow } from '@kaluch/db';
import type ExcelJS from 'exceljs';
import { RATE_COLUMNS, rateColumnsInFormula } from './rate-columns';
import { asString, readCell } from './workbook';

/**
 * Hoja BC → plan de cuentas + valores de referencia por mes.
 * Mapeo de columnas (fila 2 = cabecera, fila 1 = años):
 *   A Descripción · B "No. usado" (código mostrado) · C Naturaleza · D Clasificación
 *   E Cuenta · F Subcuenta · G..O meses (año en fila 1, mes en fila 2) · P control interno.
 * Las filas sin Cuenta tras el plan (ING 777, GAS 777, ACTIVOS…) son totales de control.
 */
export interface BcRefRow {
  fullCode: string;
  excelRow: number;
  label: string;
  year: number;
  month: number;
  valueUsd: string;
}

export interface ChartParseResult {
  accounts: (AccountSeedRow & { excelRow: number })[];
  references: BcRefRow[];
  /** Totales de control del BC (ING/GAS/UT 777/888/999…) y las filas que suman. */
  controls: { name: string; excelRow: number; rows: number[] }[];
  issues: string[];
  months: { col: number; year: number; month: number }[];
}

const NATURE: Record<string, AccountSeedRow['nature']> = { Deudora: 'DEUDORA', Acreedora: 'ACREEDORA', Mixta: 'MIXTA' };
const CLASSES = new Set(['AC', 'PC', 'CC', 'CND', 'CNA']);
const TREASURY_CODES = new Set(['101', '109', '110', '111', '112', '113', '114']);
const INTERCOMPANY = new Set(['1900', '1814', '1815', '1816', '1817', '696']);
const PENDING_EXPORT = new Set(['2900', '2814', '2815', '2816']);

/** Decisión P3 (08/10/2026): la caja CAD se omite (el Excel la convierte con la tasa MLC por error). */
export const OMITTED_ACCOUNTS: Record<string, string> = {
  '101.0004': 'Caja CAD omitida por decisión (el Excel la convertía con la tasa MLC/USD por error)',
};

function natureIncoherence(nature: AccountSeedRow['nature'], cls: AccountSeedRow['classification']): string | null {
  if (nature === 'MIXTA') return null;
  const expected = cls === 'AC' || cls === 'CND' ? 'DEUDORA' : 'ACREEDORA';
  return nature !== expected ? `Naturaleza ${nature.toLowerCase()} incoherente con clasificación ${cls}` : null;
}

function normSubcode(v: unknown): string | null {
  const s = asString(v);
  if (s === null) return null;
  return /^\d+$/.test(s) ? s.padStart(4, '0') : s;
}

export function parseChartOfAccounts(ws: ExcelJS.Worksheet): ChartParseResult {
  const issues: string[] = [];
  const months: ChartParseResult['months'] = [];
  for (let col = 7; col <= ws.columnCount; col++) {
    const year = Number(readCell(ws, 1, col).value);
    const month = Number(readCell(ws, 2, col).value);
    if (year > 2000 && month >= 1 && month <= 12) months.push({ col, year, month });
  }

  const accounts: ChartParseResult['accounts'] = [];
  const references: BcRefRow[] = [];
  const controls: ChartParseResult['controls'] = [];
  let inControl = false;

  for (let r = 3; r <= ws.rowCount; r++) {
    const name = asString(readCell(ws, r, 1).value);
    const codeRaw = asString(readCell(ws, r, 5).value);
    if (!name && !codeRaw) continue;

    let fullCode: string;
    if (codeRaw && !inControl) {
      const code = codeRaw.replace(/\.0+$/, '');
      const subcode = normSubcode(readCell(ws, r, 6).value);
      const natureRaw = asString(readCell(ws, r, 3).value) ?? '';
      const cls = asString(readCell(ws, r, 4).value) ?? '';
      const nature = NATURE[natureRaw];
      if (!nature || !CLASSES.has(cls)) {
        issues.push(`Fila ${r} (${code}${subcode ? '.' + subcode : ''}): naturaleza "${natureRaw}" o clasificación "${cls}" no reconocida`);
        continue;
      }
      const classification = cls as AccountSeedRow['classification'];
      const displayCode = subcode ? `${code}.${subcode}` : code;
      const anomalies = [natureIncoherence(nature, classification), OMITTED_ACCOUNTS[displayCode]].filter(Boolean);

      // Tipo de tasa de revaluación: el que usa la fórmula de la fila en el BC (decisión P4).
      let revalRateType: string | null = null;
      let revalCurrency: string | null = null;
      let currencyLock: string | null = null;
      if (subcode) {
        const formula = months[0] ? readCell(ws, r, months[0].col).formula : null;
        const cols = rateColumnsInFormula(formula);
        if (cols.length === 1) {
          const rc = RATE_COLUMNS[cols[0]!]!;
          revalRateType = rc.base === 'USD' ? rc.rateType : null;
          revalCurrency = rc.currency;
          if (rc.base !== 'USD') anomalies.push(`Usa la tasa ${cols[0]} (base EUR)`);
        } else if (cols.length > 1) {
          anomalies.push(`Fórmula con varias tasas: ${cols.join(', ')}`);
        }
        if (TREASURY_CODES.has(code)) {
          if (revalCurrency) currencyLock = revalCurrency;
          else if (/\bUSD\b/.test(name ?? '')) currencyLock = 'USD';
        }
      }

      if (OMITTED_ACCOUNTS[displayCode]) {
        // La cuenta se conserva inactiva con su moneda real y sin revaluación.
        const cur = /\b(CAD|USD|EUR|CUP|MLC|DOP|GBP)\b/.exec(name ?? '')?.[1] ?? null;
        currencyLock = cur;
        revalCurrency = cur;
        revalRateType = null;
      }
      accounts.push({
        excelRow: r,
        code,
        subcode,
        name: name ?? displayCode,
        nature,
        classification,
        currencyLock,
        revalRateType,
        revalCurrency,
        isIntercompany: INTERCOMPANY.has(code),
        isPendingExport: PENDING_EXPORT.has(code),
        anomaly: anomalies.length ? anomalies.join('; ') : null,
        active: !OMITTED_ACCOUNTS[displayCode],
        sortOrder: r,
      });
      fullCode = displayCode;
    } else {
      // Totales de control (ING 777, UT 888 PRESENTADA, ACTIVOS…)
      inControl = true;
      if (!name) continue;
      fullCode = `CONTROL:${name}`;
      // La primera columna de mes con fórmula (en abril algunas filas de control están vacías).
      const formula = months.map((m) => readCell(ws, r, m.col).formula).find((f) => !!f) ?? null;
      const rows = controlRows(formula);
      if (rows) controls.push({ name, excelRow: r, rows });
    }

    for (const m of months) {
      const c = readCell(ws, r, m.col);
      if (c.error) {
        issues.push(`Fila ${r} ${fullCode} ${m.month}/${m.year}: error ${c.error} en el Excel`);
        continue;
      }
      // Los totales de control vacíos (abril) no se calculan en el Excel: sin valor de referencia.
      if (fullCode.startsWith('CONTROL:') && (c.value === null || c.value === undefined) && !c.formula) continue;
      const n = typeof c.value === 'number' ? c.value : c.value === null ? 0 : Number(c.value);
      if (!Number.isFinite(n)) continue;
      references.push({ fullCode, excelRow: r, label: name ?? fullCode, year: m.year, month: m.month, valueUsd: n.toFixed(4) });
    }
  }
  return { accounts, references, controls, issues, months };
}

/** Filas que suma un total de control: "=+H268+H270", "=SUBTOTAL(9,H314:H315)", "=SUM(H331:H332)". Null si cita otra hoja. */
export function controlRows(formula: string | null): number[] | null {
  if (!formula || formula.includes('!')) return null;
  const f = formula.replace(/\$/g, '');
  if (!/^[+\s]*(SUBTOTAL\(9,|SUM\()?[A-Z]+\d+(:[A-Z]+\d+)?([+,][A-Z]+\d+(:[A-Z]+\d+)?)*\)?$/.test(f)) return null;
  const rows: number[] = [];
  for (const m of f.matchAll(/[A-Z]+(\d+)(?::[A-Z]+(\d+))?/g)) {
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let r = a; r <= b; r++) rows.push(r);
  }
  return rows;
}
