import type ExcelJS from 'exceljs';
import { RATE_COLUMNS } from './rate-columns';
import { asIsoDate, asString, readCell } from './workbook';

export interface RateRow {
  rateDate: string;
  currency: string;
  rateType: string;
  base: string;
  rate: string;
}

/**
 * Hoja "Tasas": columna A = fecha ("Tasa 1USD="), resto = una columna por par y tipo.
 * Se descartan valores vacíos, 0 o negativos (las filas futuras del Excel tienen 0).
 */
export function parseRates(ws: ExcelJS.Worksheet): {
  rows: RateRow[];
  skipped: number;
  unknownColumns: string[];
  duplicateDates: string[];
} {
  const header: (string | null)[] = [];
  for (let c = 1; c <= ws.columnCount; c++) header.push(asString(readCell(ws, 1, c).value));
  const unknownColumns = header.slice(1).filter((h): h is string => !!h && !RATE_COLUMNS[h]);
  const rows: RateRow[] = [];
  const seenDates = new Set<string>();
  const duplicateDates: string[] = [];
  let skipped = 0;
  for (let r = 2; r <= ws.rowCount; r++) {
    const date = asIsoDate(readCell(ws, r, 1).value);
    if (!date) continue;
    // Si una fecha aparece dos veces, prevalece la primera fila y se avisa.
    if (seenDates.has(date)) {
      duplicateDates.push(date);
      continue;
    }
    seenDates.add(date);
    for (let c = 2; c <= header.length; c++) {
      const h = header[c - 1];
      const map = h ? RATE_COLUMNS[h] : undefined;
      if (!map) continue;
      const v = readCell(ws, r, c).value;
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n) || n <= 0) {
        skipped++;
        continue;
      }
      rows.push({ rateDate: date, ...map, rate: n.toFixed(10) });
    }
  }
  return { rows, skipped, unknownColumns, duplicateDates };
}
