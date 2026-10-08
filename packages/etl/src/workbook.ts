import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';

export async function loadWorkbook(path: string) {
  const buf = await readFile(path);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return { wb, hash: createHash('sha256').update(buf).digest('hex') };
}

export interface CellInfo {
  /** Valor calculado (resultado de la fórmula si la hay). */
  value: unknown;
  /** Texto de la fórmula (resolviendo fórmulas compartidas). */
  formula: string | null;
  error: string | null;
}

/** Lee una celda de exceljs normalizando fórmulas, fórmulas compartidas y errores (#REF!, #DIV/0!). */
export function readCell(ws: ExcelJS.Worksheet, row: number, col: number): CellInfo {
  const cell = ws.getCell(row, col);
  const v = cell.value as unknown;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const o = v as { formula?: string; sharedFormula?: string; result?: unknown; error?: string; richText?: { text: string }[] };
    if (o.richText) return { value: o.richText.map((t) => t.text).join(''), formula: null, error: null };
    if (o.error) return { value: null, formula: null, error: o.error };
    if ('formula' in o || 'sharedFormula' in o) {
      let formula = o.formula ?? null;
      if (!formula && o.sharedFormula) formula = ws.getCell(o.sharedFormula).formula ?? null;
      const r = o.result as { error?: string } | undefined;
      if (r && typeof r === 'object' && 'error' in r) return { value: null, formula, error: r.error ?? '#ERROR' };
      return { value: o.result ?? null, formula, error: null };
    }
  }
  return { value: v ?? null, formula: null, error: null };
}

export function asString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** Fecha de Excel → AAAA-MM-DD. Acepta Date, serial numérico (p. ej. Banco_Emp_Cuba) o texto ISO. */
export function asIsoDate(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    // Serial de Excel (sistema 1900): día 25569 = 01/01/1970.
    return new Date(Math.round((v - 25569) * 86_400_000)).toISOString().slice(0, 10);
  }
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  return null;
}
