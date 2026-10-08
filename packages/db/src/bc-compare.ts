import { money } from '@kaluch/shared';
import type { PrismaClient } from '@prisma/client';
import type { Tx } from './client';
import { trialBalance } from './reports';

type Db = PrismaClient | Tx;

export type BcStatus = 'OK' | 'EXPLAINED' | 'DIFF' | 'ONLY_SYSTEM';

/**
 * Signo del Excel: activos con saldo deudor en positivo; pasivo y patrimonio con saldo acreedor
 * en positivo; en resultados, ingresos en positivo y gastos en negativo.
 */
export function excelSign(classification: string): 1 | -1 {
  return classification === 'AC' ? 1 : -1;
}

/**
 * Pares gasto/ingreso que el Excel compensa: pone el resultado neto del mes en una sola de las
 * dos cuentas según su signo. Se comparan por el neto.
 */
export const NETTED_PAIRS: [string, string][] = [
  ['845', '924'],
  ['846', '925'],
  ['846.9990', '925.9990'],
  ['846.8880', '925.8880'],
  ['845.9990', '924.9990'],
  ['845.8881', '924.8881'],
  ['845.8880', '924.8880'],
  // Otros gastos / otros ingresos (diferencias de cobro y pago, gastos recuperados) e impuestos adicionales.
  ['847', '926'],
  ['847.8880', '926.8880'],
  ['847.8881', '926.8881'],
  ['847.9990', '926.9990'],
  ['847.9991', '926.9991'],
  ['847.9992', '926.9992'],
  ['848', '920'],
  ['848.9990', '920.9990'],
  ['848.8880', '920.8880'],
];

export interface BcCompareRow {
  displayCode: string;
  name: string;
  excelRow: number | null;
  year: number;
  month: number;
  excel: string | null;
  system: string;
  diff: string;
  status: BcStatus;
  explanation: string | null;
}

/**
 * Compara el "Valor BC" del sistema (consolidado, vista Real) con los valores del
 * BC del Excel guardados por el ETL. Las cuentas se emparejan por fila del Excel
 * (sort_order), así funcionan también los códigos duplicados.
 */
export async function compareWithBc(
  db: Db,
  p: { year: number; month: number; codePrefixes?: string[]; tolerance?: string },
): Promise<{ rows: BcCompareRow[]; summary: Record<BcStatus, number>; importId: string | null }> {
  const tolerance = money(p.tolerance ?? '0.01');
  const lastImport = await db.importBatch.findFirst({ where: { tableName: 'BC:referencia' }, orderBy: { createdAt: 'desc' } });
  const companies = await db.company.findMany({ where: { consolidates: true } });
  const tb = await trialBalance(db, {
    companyIds: companies.map((c) => c.id), year: p.year, month: p.month, books: ['BASE', 'REAL'], includeZero: true,
  });
  const refs = lastImport
    ? await db.bcReference.findMany({ where: { importId: lastImport.id, year: p.year, month: p.month } })
    : [];
  const refByRow = new Map(refs.map((r) => [r.excelRow, r]));
  const accounts = new Map((await db.account.findMany({ select: { id: true, sortOrder: true, createdAt: true, anomaly: true } })).map((a) => [a.id, a]));
  const treasuryCreated = new Set(
    (await db.treasuryAccount.findMany({ where: { createdByEtl: true }, select: { glAccountId: true } })).map((t) => t.glAccountId),
  );
  const explanations = await db.bcExplanation.findMany();
  const explain = (code: string) =>
    explanations.find((e) => e.fullCode === code && (e.year === null || e.year === p.year) && (e.month === null || e.month === p.month))?.reason ?? null;

  // Las cuentas de sistema (699.999x) no existen en el Excel: no cuentan en el total de su grupo.
  const systemAccounts = new Set([...accounts.entries()].filter(([, a]) => a.anomaly?.startsWith('Cuenta de sistema')).map(([id]) => id));
  const systemByParent = new Map<string, ReturnType<typeof money>>();
  for (const r of tb.rows) {
    if (!systemAccounts.has(r.accountId) || !r.parentId) continue;
    systemByParent.set(r.parentId, money(systemByParent.get(r.parentId) ?? 0).plus(money(r.bcValue)));
  }
  const matchesPrefix = (code: string) => !p.codePrefixes?.length || p.codePrefixes.some((pre) => code === pre || code.startsWith(`${pre}.`));
  const rows: BcCompareRow[] = [];
  for (const r of tb.rows) {
    if (!matchesPrefix(r.displayCode)) continue;
    const acc = accounts.get(r.accountId);
    const ref = acc ? refByRow.get(acc.sortOrder) : undefined;
    const system = money(r.bcValue).minus(systemByParent.get(r.accountId) ?? 0).times(excelSign(r.classification));
    if (!ref) {
      if (system.isZero() && !treasuryCreated.has(r.accountId)) continue;
      rows.push({
        displayCode: r.displayCode, name: r.name, excelRow: null, year: p.year, month: p.month, excel: null,
        system: system.toFixed(2), diff: system.toFixed(2), status: 'ONLY_SYSTEM', explanation: explain(r.displayCode),
      });
      continue;
    }
    const excel = money(ref.valueUsd);
    const diff = system.minus(excel);
    const explanation = explain(r.displayCode);
    rows.push({
      displayCode: r.displayCode, name: r.name, excelRow: ref.excelRow, year: p.year, month: p.month,
      excel: excel.toFixed(2), system: system.toFixed(2), diff: diff.toFixed(2),
      status: diff.abs().lte(tolerance) ? 'OK' : explanation ? 'EXPLAINED' : 'DIFF',
      explanation,
    });
  }
  // Pares compensados: si el neto coincide, las dos cuentas quedan explicadas.
  for (const [loss, gain] of NETTED_PAIRS) {
    const a = rows.find((r) => r.displayCode === loss);
    const b = rows.find((r) => r.displayCode === gain);
    if (!a || !b || a.excel === null || b.excel === null) continue;
    if (a.status === 'OK' && b.status === 'OK') continue;
    const netExcel = money(a.excel).plus(money(b.excel));
    const netSystem = money(a.system).plus(money(b.system));
    if (netSystem.minus(netExcel).abs().lte(tolerance)) {
      const reason = `El Excel compensa ${loss} y ${gain} en el mes; el neto coincide (${netSystem.toFixed(2)})`;
      for (const r of [a, b]) if (r.status !== 'OK') Object.assign(r, { status: 'EXPLAINED' as BcStatus, explanation: r.explanation ?? reason });
    }
  }
  const summary: Record<BcStatus, number> = { OK: 0, EXPLAINED: 0, DIFF: 0, ONLY_SYSTEM: 0 };
  rows.forEach((r) => summary[r.status]++);
  return { rows, summary, importId: lastImport?.id ?? null };
}

export interface BcControlRow {
  name: string;
  excelRow: number;
  year: number;
  month: number;
  excel: string;
  system: string;
  diff: string;
  status: BcStatus;
  /** Cuentas que explican la diferencia (con explicación) y las que no (aún sin conciliar). */
  explainedBy: string[];
  pending: string[];
}

/**
 * Totales de control del BC (ING/GAS/UT 777/888/999): suma de filas del BC. El valor del sistema es la suma
 * de los valores del sistema de esas filas; la diferencia queda explicada si sale entera de cuentas con
 * diferencia explicada.
 */
export async function compareControls(db: Db, p: { year: number; month: number; tolerance?: string }): Promise<BcControlRow[]> {
  const tolerance = money(p.tolerance ?? '0.01');
  const lastImport = await db.importBatch.findFirst({ where: { tableName: 'BC:referencia' }, orderBy: { createdAt: 'desc' } });
  const controls = ((lastImport?.stats as { controls?: { name: string; excelRow: number; rows: number[] }[] } | null)?.controls ?? []);
  if (!lastImport || !controls.length) return [];
  const refs = await db.bcReference.findMany({ where: { importId: lastImport.id, year: p.year, month: p.month, fullCode: { startsWith: 'CONTROL:' } } });
  const cmp = await compareWithBc(db, { year: p.year, month: p.month, tolerance: p.tolerance });
  const byRow = new Map(cmp.rows.filter((r) => r.excelRow !== null).map((r) => [r.excelRow!, r]));
  const controlByRow = new Map(controls.map((c) => [c.excelRow, c]));
  const system = (row: number, seen = new Set<number>()): { value: ReturnType<typeof money>; explained: string[]; pending: string[]; explainedDiff: ReturnType<typeof money>; accounts: number } => {
    const out = { value: money(0), explained: [] as string[], pending: [] as string[], explainedDiff: money(0), accounts: 0 };
    const ctl = controlByRow.get(row);
    if (!ctl) {
      const r = byRow.get(row);
      if (!r) return out;
      out.value = money(r.system);
      out.accounts = 1;
      if (r.status === 'EXPLAINED') { out.explained.push(r.displayCode); out.explainedDiff = money(r.diff); }
      if (r.status === 'DIFF') out.pending.push(r.displayCode);
      return out;
    }
    if (seen.has(row)) return out;
    seen.add(row);
    for (const child of ctl.rows) {
      const c = system(child, seen);
      out.value = out.value.plus(c.value);
      out.explained.push(...c.explained);
      out.pending.push(...c.pending);
      out.explainedDiff = out.explainedDiff.plus(c.explainedDiff);
      out.accounts += c.accounts;
    }
    return out;
  };
  const excelOf = (row: number): ReturnType<typeof money> => {
    const ctl = controlByRow.get(row);
    const stored = money(refs.find((r) => r.excelRow === row)?.valueUsd ?? 0);
    // UT = SUBTOTAL(ING:GAS): el archivo guarda 0 como valor calculado; se toma la suma de sus totales.
    if (ctl && stored.isZero() && ctl.rows.every((r) => controlByRow.has(r))) return ctl.rows.reduce((s, r) => s.plus(excelOf(r)), money(0));
    return stored;
  };
  const hasRef = (row: number): boolean => {
    const ctl = controlByRow.get(row);
    if (refs.some((r) => r.excelRow === row)) return true;
    return !!ctl && ctl.rows.every((r) => controlByRow.has(r)) && ctl.rows.every(hasRef);
  };
  // Sin valor en el Excel ese mes (abril): no se compara.
  return controls.filter((c) => hasRef(c.excelRow)).map((c) => {
    const excel = excelOf(c.excelRow);
    const s = system(c.excelRow);
    const diff = s.value.minus(excel);
    // Cada cuenta se compara al céntimo: el total admite el redondeo de todas sus cuentas.
    const tol = tolerance.times(Math.max(1, s.accounts));
    const status: BcStatus = diff.abs().lte(tol) ? 'OK'
      : !s.pending.length && diff.minus(s.explainedDiff).abs().lte(tol) ? 'EXPLAINED' : 'DIFF';
    return {
      name: c.name, excelRow: c.excelRow, year: p.year, month: p.month, excel: excel.toFixed(2), system: s.value.toFixed(2), diff: diff.toFixed(2), status,
      explainedBy: status === 'OK' ? [] : [...new Set(s.explained)], pending: [...new Set(s.pending)],
    };
  });
}
