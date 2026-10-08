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
  ['846.9990', '925.9990'],
  ['846.8880', '925.8880'],
  ['845.9990', '924.9990'],
  ['845.8881', '924.8881'],
  ['845.8880', '924.8880'],
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

  const matchesPrefix = (code: string) => !p.codePrefixes?.length || p.codePrefixes.some((pre) => code === pre || code.startsWith(`${pre}.`));
  const rows: BcCompareRow[] = [];
  for (const r of tb.rows) {
    if (!matchesPrefix(r.displayCode)) continue;
    const acc = accounts.get(r.accountId);
    const ref = acc ? refByRow.get(acc.sortOrder) : undefined;
    const system = money(r.bcValue).times(excelSign(r.classification));
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
