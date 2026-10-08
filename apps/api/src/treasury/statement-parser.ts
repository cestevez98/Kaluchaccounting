import { BadRequestException } from '@nestjs/common';
import { parseDateEs, parseNumberEs } from '@kaluch/shared';
import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';

export interface ParsedLine {
  date: string;
  description: string;
  amount: string;
}

const norm = (s: unknown) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();

const DATE_H = ['fecha', 'fecha valor', 'fecha operacion', 'date', 'value date', 'f. valor'];
const DESC_H = ['concepto', 'descripcion', 'detalle', 'description', 'movimiento', 'referencia', 'concepto/desc, movimiento'];
const AMOUNT_H = ['importe', 'monto', 'amount', 'cantidad'];
const CREDIT_H = ['abono', 'abonos', 'credito', 'entrada', 'entradas', 'haber', 'credit', 'deposito'];
const DEBIT_H = ['cargo', 'cargos', 'debito', 'salida', 'salidas', 'debe', 'debit', 'retiro'];

function toIso(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 86_400_000)).toISOString().slice(0, 10);
  const s = String(v ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  try {
    return parseDateEs(s.replace(/-/g, '/').slice(0, 10));
  } catch {
    return null;
  }
}

function toAmount(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return String(v);
  try {
    return parseNumberEs(String(v).replace(/[€$\s]|USD|EUR|DOP|CUP/gi, ''));
  } catch {
    return null;
  }
}

/**
 * Lee un extracto CSV o XLSX. Detecta la fila de cabecera y las columnas de
 * fecha, concepto e importe (o cargo/abono). Fechas dd/mm/aaaa o ISO; números
 * en formato español o internacional.
 */
export async function parseStatement(buffer: Buffer, fileName: string): Promise<ParsedLine[]> {
  const wb = new ExcelJS.Workbook();
  if (/\.csv$/i.test(fileName)) {
    const text = buffer.toString('utf8').replace(/^﻿/, '');
    const delimiter = (text.split('\n')[0]!.match(/;/g)?.length ?? 0) > (text.split('\n')[0]!.match(/,/g)?.length ?? 0) ? ';' : ',';
    await wb.csv.read(Readable.from(text), { parserOptions: { delimiter }, map: (v: unknown) => v } as never);
  } else if (/\.xlsx$/i.test(fileName)) {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } else {
    throw new BadRequestException({ code: 'BAD_FILE', message: 'Formato no soportado: sube un .csv o .xlsx' });
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new BadRequestException({ code: 'BAD_FILE', message: 'El fichero está vacío' });

  const cellValue = (row: number, col: number) => {
    const v = ws.getCell(row, col).value as unknown;
    if (v && typeof v === 'object' && !(v instanceof Date) && 'result' in (v as object)) return (v as { result: unknown }).result;
    return v;
  };

  let headerRow = 0;
  let cols: { date?: number; desc?: number; amount?: number; credit?: number; debit?: number } = {};
  for (let r = 1; r <= Math.min(ws.rowCount, 30) && !headerRow; r++) {
    const found: typeof cols = {};
    for (let c = 1; c <= ws.columnCount; c++) {
      const h = norm(cellValue(r, c));
      if (!h) continue;
      if (found.date === undefined && DATE_H.includes(h)) found.date = c;
      else if (found.desc === undefined && DESC_H.includes(h)) found.desc = c;
      else if (found.amount === undefined && AMOUNT_H.includes(h)) found.amount = c;
      else if (found.credit === undefined && CREDIT_H.some((x) => h === x || h.startsWith(`${x} `))) found.credit = c;
      else if (found.debit === undefined && DEBIT_H.some((x) => h === x || h.startsWith(`${x} `))) found.debit = c;
    }
    if (found.date !== undefined && (found.amount !== undefined || (found.credit !== undefined && found.debit !== undefined))) {
      headerRow = r;
      cols = found;
    }
  }
  if (!headerRow) {
    throw new BadRequestException({
      code: 'BAD_FILE',
      message: 'No encuentro la cabecera: el extracto debe tener columnas Fecha, Concepto e Importe (o Cargo y Abono)',
    });
  }

  const lines: ParsedLine[] = [];
  const errors: string[] = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const rawDate = cellValue(r, cols.date!);
    if (rawDate === null || rawDate === undefined || rawDate === '') continue;
    const date = toIso(rawDate);
    let amount: string | null;
    if (cols.amount !== undefined) {
      amount = toAmount(cellValue(r, cols.amount));
    } else {
      const credit = toAmount(cellValue(r, cols.credit!)) ?? '0';
      const debit = toAmount(cellValue(r, cols.debit!)) ?? '0';
      amount = (Number(credit) !== 0 ? credit : Number(debit) !== 0 ? `-${debit.replace(/^-/, '')}` : null);
    }
    if (!date || amount === null) {
      errors.push(`fila ${r}`);
      continue;
    }
    if (Number(amount) === 0) continue;
    lines.push({ date, amount, description: String(cols.desc !== undefined ? cellValue(r, cols.desc) ?? '' : '').trim() });
  }
  if (errors.length > 0 && lines.length === 0) {
    throw new BadRequestException({ code: 'BAD_FILE', message: `No se pudo leer ninguna línea (${errors.slice(0, 5).join(', ')})` });
  }
  return lines;
}
