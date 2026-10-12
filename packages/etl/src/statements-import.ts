import { DEFAULT_TEMPLATE_ORIGIN, type PrismaClient } from '@kaluch/db';
import { formulaOrder, formulaRefs, parseFormula, type ReportLineInput } from '@kaluch/shared';
import type ExcelJS from 'exceljs';
import { basename } from 'node:path';
import { asString, excelNumber, readCell, type loadWorkbook } from './workbook';

type Workbook = Awaited<ReturnType<typeof loadWorkbook>>;

/**
 * Plantillas de los estados financieros desde las hojas del Excel (ES, ER, ERE 888, ERD 999,
 * ERDop 777 y EFE). Cada hoja tiene:
 * - en la columna A, el texto de cada línea;
 * - en las filas 1 y 2, el año y el mes de cada columna de importes (B, C…);
 * - a la derecha, las cuentas del BC de cada línea y la comprobación del Excel (2 = cuadra con el BC).
 * Los totales son fórmulas sobre otras filas de la misma columna (SUM, +, −), que se traducen a
 * fórmulas entre líneas; las líneas con cuentas se calculan desde el mayor.
 */
export interface StatementSheetSpec {
  sheet: string;
  code: string;
  name: string;
  kind: 'BALANCE' | 'INCOME' | 'CASHFLOW';
  checkCoverage: boolean;
  sortOrder: number;
}

export const STATEMENT_SHEETS: StatementSheetSpec[] = [
  { sheet: 'ES', code: 'ES', name: 'Estado de situación', kind: 'BALANCE', checkCoverage: true, sortOrder: 10 },
  { sheet: 'ER', code: 'ER', name: 'Estado de resultados (consolidado)', kind: 'INCOME', checkCoverage: true, sortOrder: 20 },
  { sheet: 'ERE 888', code: 'ERE888', name: 'Estado de resultados · Exportación (888)', kind: 'INCOME', checkCoverage: false, sortOrder: 30 },
  { sheet: 'ERD 999', code: 'ERD999', name: 'Estado de resultados · Distribución (999)', kind: 'INCOME', checkCoverage: false, sortOrder: 40 },
  { sheet: 'ERDop 777', code: 'ERDOP777', name: 'Estado de resultados · Doping (777)', kind: 'INCOME', checkCoverage: false, sortOrder: 50 },
  { sheet: 'EFE', code: 'EFE', name: 'Estado de flujo de efectivo', kind: 'CASHFLOW', checkCoverage: false, sortOrder: 60 },
];

export interface ParsedReference {
  lineKey: string;
  year: number;
  month: number;
  valueUsd: string | null;
  error: string | null;
  excelCheck: boolean | null;
  manual: boolean;
}

export interface ParsedStatement {
  spec: StatementSheetSpec;
  lines: ReportLineInput[];
  references: ParsedReference[];
  /** Correcciones y avisos (totales del Excel que no suman alguna línea, fórmulas no traducibles…). */
  notes: string[];
}

const ACCOUNT_CODE = /^\d{3,4}(\.[0-9A-Za-z-]+)?$/;

/** Código de cuenta tal como lo escribe el BC: los números pierden los ceros (849.888 → 849.8880). */
export function accountCodeFromCell(v: unknown): string | null {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    if (Number.isInteger(v)) return String(v);
    const [int, dec] = v.toFixed(4).split('.');
    return `${int}.${dec}`;
  }
  const s = asString(v);
  return s && ACCOUNT_CODE.test(s) ? s : null;
}

const colName = (c: number): string => {
  let s = '';
  for (let n = c; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/**
 * Traduce una fórmula de totales del Excel a la sintaxis de las líneas, o null si no es
 * aritmética sobre filas de la misma columna (p. ej. un SUMIFS sobre otra hoja).
 */
export function translateTotalFormula(excel: string, col?: string): string | null {
  let f = excel.replace(/^=/, '').replace(/\s+/g, '');
  // IF(DATE(año,mes,1)>TODAY(),0,X): en el sistema solo se calculan meses ya cerrados → X.
  const future = /^\+?IF\(DATE\([^()]*\)>TODAY\(\),0,(.*)\)$/i.exec(f);
  if (future) f = future[1]!;
  // IF(X>0,0,X) → MIN(0,X) (participación que solo se calcula sobre utilidad positiva).
  const floor = /^\+?IF\((.+)>0,0,(.+)\)$/i.exec(f);
  if (floor && floor[1] === floor[2]) f = `MIN(0,${floor[1]})`;
  if (/[!"&]|SUMIFS|IFERROR|#REF/i.test(f)) return null;
  // Todas las referencias deben ser de una misma columna (las fórmulas compartidas de exceljs llegan
  // con el texto de la celda maestra, de otra columna).
  const cols = new Set<string>();
  const out = f.replace(/\$?([A-Z]{1,3})\$?(\d+)/g, (_m, c: string, r: string) => {
    cols.add(c);
    return `[F${r}]`;
  });
  if (cols.size > 1 || (cols.size === 1 && col && ![...cols][0])) return null;
  const cleaned = out.replace(/^\+/, '');
  try {
    parseFormula(cleaned);
  } catch {
    return null;
  }
  return cleaned;
}

interface SheetLayout {
  /** Columnas de importes: columna → año/mes. */
  months: { col: number; year: number; month: number }[];
  /** Columnas de la comprobación con el BC por mes. */
  checks: Map<number, number>;
  /** Columnas con los códigos de cuenta de cada línea. */
  accountCols: number[];
  lastRow: number;
}

function layoutOf(ws: ExcelJS.Worksheet, headerRow = 1): SheetLayout {
  const months: SheetLayout['months'] = [];
  for (let c = 2; c <= ws.columnCount; c++) {
    const y = excelNumber(readCell(ws, headerRow, c).value);
    const m = excelNumber(readCell(ws, headerRow + 1, c).value);
    if (!y || y < 2000 || !m || m < 1 || m > 12) break;
    months.push({ col: c, year: y, month: m });
  }
  const checks = new Map<number, number>();
  const accountCols = new Set<number>();
  const lastRow = ws.actualRowCount ? ws.rowCount : 0;
  for (let c = (months.at(-1)?.col ?? 1) + 1; c <= ws.columnCount; c++) {
    let isCheck = false;
    for (let r = headerRow + 2; r <= lastRow; r++) {
      const cell = readCell(ws, r, c);
      if (cell.formula && /SUMIFS\(BC!/i.test(cell.formula)) isCheck = true;
      if (!cell.formula && accountCodeFromCell(cell.value)) accountCols.add(c);
    }
    const m = excelNumber(readCell(ws, headerRow + 1, c).value);
    if (isCheck && m && m >= 1 && m <= 12) checks.set(m, c);
  }
  return { months, checks, accountCols: [...accountCols].sort((a, b) => a - b), lastRow };
}

const key = (row: number) => `F${row}`;

/** Lee una hoja de estado (ES / ER*) como plantilla de líneas y cifras de referencia. */
export function parseStatementSheet(ws: ExcelJS.Worksheet, spec: StatementSheetSpec): ParsedStatement {
  const layout = layoutOf(ws);
  const notes: string[] = [];
  const lines: ReportLineInput[] = [];
  const references: ParsedReference[] = [];
  const lastMonthCol = layout.months.at(-1)?.col;
  let lastUsed = 2;
  for (let r = 3; r <= layout.lastRow; r++) {
    const has = asString(readCell(ws, r, 1).value) !== null || layout.months.some((m) => {
      const c = readCell(ws, r, m.col);
      return c.formula !== null || c.value !== null || c.error !== null;
    });
    if (has) lastUsed = r;
  }
  for (let r = 3; r <= lastUsed; r++) {
    const rawLabel = String(readCell(ws, r, 1).value ?? '').replace(/\s+$/, '');
    const label = rawLabel.trim();
    const indent = Math.min(3, Math.floor((rawLabel.length - rawLabel.trimStart().length) / 4));
    const accounts = [...new Set(layout.accountCols.map((c) => accountCodeFromCell(readCell(ws, r, c).value)).filter((x): x is string => !!x))];
    // Fórmula representativa: la de la última columna de mes que tenga fórmula.
    let total: string | null = null;
    let anyFormula = false;
    let untranslated: string | null = null;
    for (let i = layout.months.length - 1; i >= 0; i--) {
      const m = layout.months[i]!;
      const cell = readCell(ws, r, m.col);
      if (!cell.formula) continue;
      anyFormula = true;
      total = translateTotalFormula(cell.formula, colName(m.col));
      if (!total && !accounts.length && !/SUMIFS/i.test(cell.formula)) untranslated = cell.formula;
      break;
    }
    const line: ReportLineInput = {
      key: key(r), label, source: 'NONE', accounts: [], categories: [], cashFlow: null, formula: null,
      negate: false, indent, bold: false, option: null,
    };
    if (accounts.length) {
      line.source = 'ACCOUNTS';
      line.accounts = accounts;
    } else if (total) {
      line.source = 'FORMULA';
      line.formula = total;
      line.bold = !/^-?\d+(\.\d+)?$/.test(total) && indent === 0;
    } else if (untranslated) {
      notes.push(`"${label}" (fila ${r}) usa una fórmula que no se puede traducir (${untranslated.slice(0, 80)}); queda sin importe.`);
    } else if (anyFormula && label) {
      notes.push(`"${label}" (fila ${r}) se calcula en el Excel desde otras hojas y no tiene cuentas del BC asignadas; queda sin importe.`);
    }
    if (label && label === label.toUpperCase() && /[A-ZÁÉÍÓÚÑ]/.test(label)) line.bold = true;
    lines.push(line);
    for (const m of layout.months) {
      const cell = readCell(ws, r, m.col);
      if (!label && cell.value === null && !cell.error) continue;
      const n = excelNumber(cell.value);
      const checkCol = layout.checks.get(m.month);
      const check = checkCol ? readCell(ws, r, checkCol) : null;
      const checkValue = check ? excelNumber(check.value) : null;
      references.push({
        lineKey: key(r), year: m.year, month: m.month,
        valueUsd: cell.error || n === null ? null : n.toFixed(4),
        error: cell.error ?? (n === null && cell.value !== null && typeof cell.value === 'string' ? String(cell.value).slice(0, 40) : null),
        excelCheck: checkValue === null ? null : checkValue === 2,
        manual: !cell.formula && n !== null,
      });
    }
  }
  if (lastMonthCol === undefined) notes.push('La hoja no tiene columnas de meses (año en la fila 1 y mes en la fila 2).');
  return { spec, lines, references: references.filter((x) => x.valueUsd !== null || x.error), notes };
}

const isValueLine = (l: ReportLineInput) => l.source !== 'NONE' && l.source !== 'FORMULA';

/** Claves que suma una línea, directa o indirectamente. */
function coveredBy(lines: ReportLineInput[], k: string): Set<string> {
  const order = lines.map((l) => l.key);
  const seen = new Set<string>();
  const walk = (key: string) => {
    const line = lines.find((l) => l.key === key);
    if (!line?.formula) return;
    for (const ref of formulaRefs(parseFormula(line.formula), order)) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      walk(ref);
    }
  };
  walk(k);
  return seen;
}

const findLabel = (lines: ReportLineInput[], label: string) =>
  lines.findIndex((l) => l.label.trim().toUpperCase() === label);

/**
 * Completa el estado de situación del Excel para que cuadre: el patrimonio del Excel no tiene
 * cuentas, y sus totales no suman algunas líneas (p. ej. PASIVOS no suma Comisiones ni Nóminas).
 * - Patrimonio: capital (600), utilidades retenidas (630), otras cuentas de patrimonio, resultados
 *   sin cerrar y resultado del ejercicio.
 * - Líneas "sin línea" de activo y pasivo para las cuentas que el Excel no presenta.
 * - Cada total de sección suma todas las líneas de su sección exactamente una vez.
 * - Línea de control ACTIVOS − (PASIVOS + PATRIMONIO).
 */
export function completeBalanceSheet(p: ParsedStatement): ParsedStatement {
  const lines = p.lines.map((l) => ({ ...l }));
  const notes = [...p.notes];
  const iAssets = findLabel(lines, 'ACTIVOS');
  const iTotal = findLabel(lines, 'PATRIMONIO + PASIVO');
  const iLiab = findLabel(lines, 'PASIVOS');
  const iEquity = findLabel(lines, 'PATRIMONIO');
  if ([iAssets, iTotal, iLiab, iEquity].some((i) => i < 0)) {
    notes.push('No se encuentran las secciones ACTIVOS / PASIVOS / PATRIMONIO: el estado no se ha completado.');
    return { ...p, lines, notes };
  }
  const mk = (k: string, label: string, extra: Partial<ReportLineInput>): ReportLineInput => ({
    key: k, label, source: 'NONE', accounts: [], categories: [], cashFlow: null, formula: null, negate: false, indent: 1,
    bold: false, option: null, ...extra,
  });
  // Patrimonio: se rehace (en el Excel no tiene cuentas).
  const equityRows = lines.slice(iEquity + 1).filter((l) => l.label);
  const equity: ReportLineInput[] = [
    mk('PN_CAPITAL', 'Capital', { source: 'ACCOUNTS', accounts: ['600'] }),
    mk('PN_RETENIDAS', 'Utilidades retenidas', { source: 'ACCOUNTS', accounts: ['630'] }),
    mk('PN_OTRAS', 'Otras cuentas de patrimonio', { source: 'UNMAPPED', accounts: ['CC'] }),
    mk('PN_SIN_CERRAR', 'Resultados de ejercicios anteriores sin cerrar', { source: 'RESULT_PRIOR' }),
    mk('PN_RESULTADO', 'Resultado del período', { source: 'RESULT_YTD', option: 'REALIZADO' }),
    mk('PN_PENDIENTE', 'Exportación pendiente de cierre (ventas − costos de facturas sin cerrar)', { source: 'RESULT_YTD', option: 'PENDIENTE' }),
  ];
  if (equityRows.length) {
    notes.push(`Patrimonio: el Excel no asigna cuentas a ${equityRows.map((l) => `"${l.label}"`).join(', ')}; se presentan capital (600), utilidades retenidas (630), otras cuentas de patrimonio y el resultado.`);
  }
  const equityHead = { ...lines[iEquity]!, source: 'FORMULA' as const, formula: equity.map((l) => `[${l.key}]`).join('+'), bold: true };
  const before = lines.slice(0, iEquity);
  // Otros activos / pasivos sin línea, al final de su sección.
  const otherAssets = mk('ACT_OTROS', 'Otros activos (cuentas sin línea en el Excel)', { source: 'UNMAPPED', accounts: ['AC'] });
  const otherLiab = mk('PAS_OTROS', 'Otros pasivos (cuentas sin línea en el Excel)', { source: 'UNMAPPED', accounts: ['PC'] });
  const assetsEnd = iTotal;
  const withOthers = [
    ...before.slice(0, assetsEnd), otherAssets, ...before.slice(assetsEnd, iEquity), otherLiab,
  ];
  const result = [...withOthers, equityHead, ...equity];
  result.push(mk('', '', {}), mk('CONTROL', 'Diferencia ACTIVOS − (PASIVOS + PATRIMONIO)', {
    source: 'FORMULA', formula: `[${lines[iAssets]!.key}]-[${lines[iTotal]!.key}]`, indent: 0, bold: true,
  }));
  const fixed = result.map((l, i) => (l.key ? l : { ...l, key: `BL${i}` }));

  // Cada total de sección suma todas sus líneas.
  const sectionFix = (headKey: string, fromIdx: number, toIdx: number, name: string) => {
    const head = fixed.find((l) => l.key === headKey)!;
    const inSection = fixed.slice(fromIdx, toIdx).filter((l) => l.key !== headKey);
    const covered = coveredBy(fixed, headKey);
    const missing = inSection.filter((l) => isValueLine(l) && !covered.has(l.key));
    const add = new Set<string>();
    for (const m of missing) {
      // Si un subtotal de la sección ya la suma (y el total no suma ese subtotal), se añade el subtotal.
      const parents = inSection.filter((s) => s.formula && s.key !== m.key && !covered.has(s.key) && coveredBy(fixed, s.key).has(m.key));
      const top = parents.find((q) => !parents.some((o) => o.key !== q.key && coveredBy(fixed, o.key).has(q.key)));
      add.add(top ? top.key : m.key);
    }
    if (!add.size) return;
    head.formula = `${head.formula}+${[...add].map((k) => `[${k}]`).join('+')}`;
    const labels = [...add].map((k) => fixed.find((l) => l.key === k)!.label).filter(Boolean);
    if (labels.some((l) => !/sin línea/.test(l))) {
      notes.push(`Corregido respecto al Excel: el total ${name} no sumaba ${labels.filter((l) => !/sin línea/.test(l)).map((l) => `"${l}"`).join(', ')}.`);
    }
  };
  const idx = (k: string) => fixed.findIndex((l) => l.key === k);
  const assetsKey = lines[iAssets]!.key;
  const liabKey = lines[iLiab]!.key;
  sectionFix(assetsKey, idx(assetsKey), idx(lines[iTotal]!.key), 'ACTIVOS');
  sectionFix(liabKey, idx(liabKey), idx(lines[iEquity]!.key), 'PASIVOS');
  formulaOrder(fixed);
  return { ...p, lines: fixed, notes };
}

const norm = (s: string) =>
  s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Flujo de efectivo: la hoja EFE del Excel (rota con #REF!) da la estructura por categorías. */
export function parseCashFlowSheet(ws: ExcelJS.Worksheet, spec: StatementSheetSpec): ParsedStatement {
  const notes: string[] = [
    'En el Excel el EFE no calcula (#REF! en todas las celdas): se usa su estructura (actividades y categorías de caja) con los movimientos de caja y bancos del sistema.',
  ];
  const lines: ReportLineInput[] = [];
  const base = { accounts: [], categories: [], cashFlow: null, formula: null, negate: false, indent: 0, bold: false, option: null };
  const sections: { key: string; flow: 'OPER' | 'INV' | 'FIN'; children: string[]; label: string }[] = [];
  let current: (typeof sections)[number] | null = null;
  const flowOf = (t: string): 'OPER' | 'INV' | 'FIN' | null => {
    const n = norm(t);
    if (n.startsWith('explotacion') || n.startsWith('operacion')) return 'OPER';
    if (n.startsWith('inversion')) return 'INV';
    if (n.startsWith('financiacion') || n.startsWith('financiamiento')) return 'FIN';
    return null;
  };
  lines.push({ ...base, key: 'SALDO_INICIAL', label: 'Saldo inicial de caja y bancos', source: 'CASH_BALANCE', option: 'OPENING', bold: true });
  for (let r = 1; r <= ws.rowCount; r++) {
    const a = asString(readCell(ws, r, 1).value);
    const b = asString(readCell(ws, r, 2).value);
    const flow = b ? flowOf(b) : null;
    if (flow && !a) {
      current = { key: `F${r}`, flow, children: [], label: b! };
      sections.push(current);
      lines.push({ ...base, key: current.key, label: b!, source: 'FORMULA', formula: '0', bold: true });
      continue;
    }
    if (a && current && norm(a) !== 'saldo inicial') {
      current.children.push(`F${r}`);
      lines.push({ ...base, key: `F${r}`, label: a, source: 'CASH', categories: [a], cashFlow: current.flow, indent: 1 });
    }
  }
  for (const s of sections) {
    const otherKey = `OTROS_${s.flow}`;
    const idx = lines.findIndex((l) => l.key === (s.children.at(-1) ?? s.key));
    lines.splice(idx + 1, 0, {
      ...base, key: otherKey, label: `Otros cobros y pagos de ${s.label.toLowerCase()} (categorías sin línea)`, source: 'CASH', cashFlow: s.flow, indent: 1,
    });
    const head = lines.find((l) => l.key === s.key)!;
    head.formula = [...s.children, otherKey].map((k) => `[${k}]`).join('+');
  }
  lines.push(
    { ...base, key: 'FX', label: 'Diferencias de cambio, cambios entre cuentas propias y saldos migrados', source: 'CASH_FX' },
    {
      ...base, key: 'SALDO_CALCULADO', label: 'Saldo final calculado', source: 'FORMULA', bold: true,
      formula: ['SALDO_INICIAL', ...sections.map((s) => s.key), 'FX'].map((k) => `[${k}]`).join('+'),
    },
    { ...base, key: 'SALDO_FINAL', label: 'Saldo final de caja y bancos', source: 'CASH_BALANCE', option: 'CLOSING', bold: true },
    { ...base, key: 'CONTROL', label: 'Diferencia (debe ser 0)', source: 'FORMULA', formula: '[SALDO_CALCULADO]-[SALDO_FINAL]' },
  );
  if (!sections.length) notes.push('No se encuentran las actividades (Explotación, Inversión, Financiación) en la columna B.');
  return { spec, lines, references: [], notes };
}

/** Importa las plantillas de los estados y las cifras del Excel para compararlas. */
export async function importStatements(prisma: PrismaClient, w: Workbook, file: string) {
  const batch = await prisma.importBatch.create({ data: { sourceFile: basename(file), fileHash: w.hash, tableName: 'Estados:plantillas', stats: {} } });
  const result: { code: string; lines: number; references: number; kept: boolean; notes: string[] }[] = [];
  for (const spec of STATEMENT_SHEETS) {
    const ws = w.wb.getWorksheet(spec.sheet);
    if (!ws) {
      result.push({ code: spec.code, lines: 0, references: 0, kept: false, notes: [`No está la hoja "${spec.sheet}"`] });
      continue;
    }
    let parsed = spec.kind === 'CASHFLOW' ? parseCashFlowSheet(ws, spec) : parseStatementSheet(ws, spec);
    if (spec.kind === 'BALANCE') parsed = completeBalanceSheet(parsed);
    formulaOrder(parsed.lines);
    const existing = await prisma.reportTemplate.findUnique({ where: { code: spec.code } });
    // Una plantilla modificada en el diseñador no se sobrescribe (solo se actualizan las cifras del Excel);
    // las del Excel y las predeterminadas (generadas desde el plan de cuentas) sí.
    const kept = !!existing && existing.origin !== 'EXCEL' && existing.origin !== DEFAULT_TEMPLATE_ORIGIN;
    await prisma.$transaction(async (tx) => {
      const data = {
        name: spec.name, kind: spec.kind, notes: parsed.notes.join('\n'), sheetName: spec.sheet, sortOrder: spec.sortOrder,
        checkCoverage: spec.checkCoverage,
      };
      const t = existing
        ? kept
          ? existing
          : await tx.reportTemplate.update({ where: { id: existing.id }, data: { ...data, origin: 'EXCEL' } })
        : await tx.reportTemplate.create({ data: { ...data, code: spec.code, origin: 'EXCEL' } });
      if (!kept) {
        await tx.reportLine.deleteMany({ where: { templateId: t.id } });
        await tx.reportLine.createMany({
          data: parsed.lines.map((l, i) => ({
            templateId: t.id, sortOrder: (i + 1) * 10, key: l.key, label: l.label, source: l.source, accounts: l.accounts,
            categories: l.categories, cashFlow: l.cashFlow ?? null, formula: l.formula ?? null, negate: l.negate, indent: l.indent,
            bold: l.bold, option: l.option ?? null, excelRow: /^F\d+$/.test(l.key) ? Number(l.key.slice(1)) : null,
          })),
        });
      }
      await tx.reportReference.deleteMany({ where: { templateId: t.id } });
      await tx.reportReference.createMany({
        data: parsed.references
          .filter((r) => parsed.lines.some((l) => l.key === r.lineKey))
          .map((r) => ({ ...r, templateId: t.id, importId: batch.id })),
      });
    });
    result.push({ code: spec.code, lines: parsed.lines.length, references: parsed.references.length, kept, notes: parsed.notes });
  }
  await prisma.importBatch.update({ where: { id: batch.id }, data: { stats: { templates: result } } });
  return result;
}
