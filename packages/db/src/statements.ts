import { endOfMonth, evalFormula, formulaOrder, formulaRefs, FUNCTIONAL_CURRENCY, isNominal, money, parseFormula, type Classification } from '@kaluch/shared';
import type Decimal from 'decimal.js';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { Tx } from './client';
import { trialBalance } from './reports';

type Db = PrismaClient | Tx;

/**
 * Estados financieros desde los saldos del mayor con las plantillas de líneas (ES, ER, EFE…).
 *
 * Signo del Excel en todas las líneas: activos en positivo, pasivo y patrimonio en positivo, en
 * resultados los ingresos en positivo y los gastos en negativo (igual que el BC del Excel).
 * - Estado de situación (BALANCE): saldo a fin de cada mes.
 * - Estado de resultados (INCOME): movimiento del mes; la columna total suma los meses.
 * - Flujo de efectivo (CASHFLOW, método directo): movimientos de las cuentas de caja y bancos
 *   por categoría de tesorería; los cambios entre cuentas propias y la revaluación van aparte.
 */

export type StatementView = 'REAL' | 'FISCAL';

export interface StatementParams {
  templateCode: string;
  companyIds: string[];
  year: number;
  fromMonth: number;
  toMonth: number;
  view?: StatementView;
  segmentIds?: string[];
  /** Elimina las cuentas intercompañía de los resultados (consolidado). */
  eliminate?: boolean;
  /** Fecha de hoy (para no calcular meses futuros); por defecto, la del sistema. */
  today?: string;
}

export type CompareStatus = 'OK' | 'DIFF' | 'EXPLAINED' | 'NO_REF';

export interface StatementColumn {
  key: string;
  label: string;
  year: number;
  /** null = columna total del periodo. */
  month: number | null;
}

export interface StatementLineResult {
  key: string;
  label: string;
  source: string;
  indent: number;
  bold: boolean;
  /** Importes por columna (4 decimales), ya con el signo de presentación. */
  values: string[];
  /** Detalle por cuenta (líneas de cuentas y de cuentas sin línea). */
  accounts: { code: string; name: string; values: string[] }[];
  /** Detalle por categoría de tesorería (líneas de flujo de caja). */
  categories: { name: string; values: string[] }[];
  /** Cifras del Excel por columna de mes (null si no hay o es un error). */
  excel: (string | null)[] | null;
  status: (CompareStatus | null)[] | null;
  explanations: (string | null)[] | null;
}

export interface StatementResult {
  template: { id: string; code: string; name: string; kind: string; notes: string; origin: string };
  columns: StatementColumn[];
  lines: StatementLineResult[];
  /** Cuentas con saldo o movimiento que no están en ninguna línea (estados completos). */
  unmapped: { code: string; name: string; classification: string; value: string }[];
  /** Cuentas intercompañía eliminadas del consolidado y su neto (debe ser 0 si son recíprocas). */
  eliminated: { code: string; name: string; value: string }[];
  warnings: string[];
  comparison: Record<CompareStatus, number> | null;
}

const MONTHS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

const sign = (c: Classification) => (c === 'AC' ? 1 : -1);

/** Clave de comparación de códigos: "849.888" y "849.8880" son la misma cuenta. */
export function codeKey(code: string): string {
  return /^\d+(\.\d+)?$/.test(code) ? String(Number(code)) : code.trim().toUpperCase();
}

const norm = (s: string) =>
  s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w)).join(' ');

interface AccountInfo {
  id: string;
  parentId: string | null;
  displayCode: string;
  name: string;
  classification: Classification;
  isIntercompany: boolean;
  isPendingExport: boolean;
}

/** Índice de cuentas: código → cuentas de detalle (una cuenta de grupo incluye sus subcuentas). */
export async function accountIndex(db: Db) {
  const accounts = (await db.account.findMany({
    select: { id: true, parentId: true, code: true, displayCode: true, name: true, classification: true, isIntercompany: true, isPendingExport: true, sortOrder: true },
    orderBy: [{ sortOrder: 'asc' }, { fullCode: 'asc' }],
  })) as (AccountInfo & { sortOrder: number; code: string })[];
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const children = new Map<string, string[]>();
  for (const a of accounts) if (a.parentId) children.set(a.parentId, [...(children.get(a.parentId) ?? []), a.id]);
  const byCode = new Map<string, string[]>();
  for (const a of accounts) byCode.set(codeKey(a.displayCode), [...(byCode.get(codeKey(a.displayCode)) ?? []), a.id]);
  const subtree = (id: string): string[] => [id, ...(children.get(id) ?? []).flatMap(subtree)];
  const byBase = new Map<string, string[]>();
  for (const a of accounts) byBase.set(a.code, [...(byBase.get(a.code) ?? []), a.id]);
  /**
   * Cuentas de un código. Si no hay ninguna con ese código completo, las del código base
   * (el Excel cita "844" y en el plan es 844.9990, su única subcuenta).
   */
  const resolve = (code: string): string[] => {
    const direct = byCode.get(codeKey(code)) ?? (/^\d+$/.test(code.trim()) ? byBase.get(code.trim()) ?? [] : []);
    return [...new Set(direct.flatMap(subtree))];
  };
  return { accounts, byId, resolve };
}

/** Movimiento (debe − haber) por cuenta y mes del año; el índice 0 es todo lo anterior al año. */
async function movements(db: Db, p: { companyIds: string[]; year: number; toMonth: number; books: string[]; segmentIds?: string[] }) {
  if (!p.companyIds.length) return new Map<string, Decimal[]>();
  const seg = p.segmentIds?.length ? Prisma.sql`AND lb.segment_key = ANY(${p.segmentIds}::uuid[])` : Prisma.empty;
  const rows = await db.$queryRaw<{ account_id: string; m: number; v: Prisma.Decimal }[]>`
    SELECT lb.account_id, CASE WHEN lb.year < ${p.year} THEN 0 ELSE lb.month END::int AS m, sum(lb.debit_usd - lb.credit_usd) AS v
    FROM ledger_balance lb
    WHERE lb.company_id = ANY(${p.companyIds}::uuid[]) AND lb.book::text = ANY(${p.books}::text[])
      AND (lb.year < ${p.year} OR (lb.year = ${p.year} AND lb.month <= ${p.toMonth}))
      ${seg}
    GROUP BY 1, 2`;
  const out = new Map<string, Decimal[]>();
  for (const r of rows) {
    const arr = out.get(r.account_id) ?? Array.from({ length: 13 }, () => money(0));
    arr[r.m] = arr[r.m]!.plus(money(r.v));
    out.set(r.account_id, arr);
  }
  return out;
}

interface CashFlowRow { m: number; category_id: string | null; cls: string; internal: boolean; v: Prisma.Decimal }

/** Movimientos de las cuentas de caja y bancos por mes, categoría y actividad. */
async function cashFlows(db: Db, p: { companyIds: string[]; year: number; fromMonth: number; toMonth: number; books: string[]; cashAccounts: string[] }) {
  if (!p.companyIds.length || !p.cashAccounts.length) return [];
  const from = `${p.year}-${String(p.fromMonth).padStart(2, '0')}-01`;
  const to = endOfMonth(p.year, p.toMonth);
  return db.$queryRaw<CashFlowRow[]>`
    SELECT EXTRACT(MONTH FROM jl.entry_date)::int AS m, tm.category_id,
      coalesce(cc.cash_flow_category, jl.cash_flow_category, 'OPER') AS cls,
      (je.kind IN ('REVAL', 'OPENING') OR coalesce(tm.kind::text, '') IN ('TRANSFER', 'EXCHANGE', 'OPENING')) AS internal,
      sum(jl.amount_usd) AS v
    FROM journal_line jl
    JOIN journal_entry je ON je.id = jl.entry_id
    JOIN fiscal_period fp ON fp.id = je.period_id
    LEFT JOIN treasury_movement tm ON tm.id = je.document_id
    LEFT JOIN cash_category cc ON cc.id = tm.category_id
    WHERE jl.company_id = ANY(${p.companyIds}::uuid[]) AND je.book::text = ANY(${p.books}::text[])
      AND jl.account_id = ANY(${p.cashAccounts}::uuid[])
      AND jl.entry_date BETWEEN ${from}::date AND ${to}::date AND fp.month BETWEEN 1 AND 12
    GROUP BY 1, 2, 3, 4`;
}

/** Calcula un estado financiero con su plantilla. */
export async function computeStatement(db: Db, p: StatementParams): Promise<StatementResult> {
  const template = await db.reportTemplate.findUnique({
    where: { code: p.templateCode },
    include: { lines: { orderBy: { sortOrder: 'asc' } }, references: true },
  });
  if (!template) throw new Error(`No existe la plantilla ${p.templateCode}`);
  const books = p.view === 'FISCAL' ? ['BASE', 'FISCAL'] : ['BASE', 'REAL'];
  const warnings: string[] = [];
  // No se calculan meses futuros (las fórmulas de participaciones darían importes de meses sin datos).
  const today = p.today ?? new Date().toISOString().slice(0, 10);
  const [ty, tm] = today.split('-').map(Number) as [number, number];
  let toMonth = p.toMonth;
  if (p.year === ty && toMonth > tm) toMonth = tm;
  if (p.year > ty) toMonth = 0;
  const fromMonth = Math.min(p.fromMonth, Math.max(toMonth, 1));
  if (toMonth < p.toMonth) warnings.push(`Se muestra hasta ${MONTHS[toMonth - 1] ?? '—'} ${p.year}: los meses siguientes aún no han terminado.`);
  const months = toMonth >= 1 ? Array.from({ length: toMonth - fromMonth + 1 }, (_, i) => fromMonth + i) : [];
  const columns: StatementColumn[] = [
    ...months.map((m) => ({ key: `${p.year}-${m}`, label: `${MONTHS[m - 1]} ${p.year}`, year: p.year, month: m })),
  ];
  if (months.length > 1) {
    columns.push({
      key: 'total', year: p.year, month: null,
      label: template.kind === 'BALANCE' ? `Saldo a ${MONTHS[toMonth - 1]}` : `Total ${MONTHS[fromMonth - 1]}–${MONTHS[toMonth - 1]}`,
    });
  }
  const nCols = columns.length;
  const zeros = () => Array.from({ length: nCols }, () => money(0));

  const idx = await accountIndex(db);
  const mov = await movements(db, { companyIds: p.companyIds, year: p.year, toMonth: Math.max(toMonth, 0), books, segmentIds: p.segmentIds });
  const eliminate = (p.eliminate ?? true) && p.companyIds.length > 1;
  const isExcluded = (a: AccountInfo) => eliminate && a.isIntercompany && template.kind === 'INCOME';

  /** Valores por columna de una cuenta de detalle, con el signo del Excel. */
  const accountValues = (id: string): Decimal[] => {
    const a = idx.byId.get(id)!;
    const arr = mov.get(id);
    if (!arr) return zeros();
    const s = sign(a.classification);
    const at = (m: number) => {
      if (template.kind === 'BALANCE') {
        let acc = money(0);
        for (let i = 0; i <= m; i++) acc = acc.plus(arr[i]!);
        return acc.times(s);
      }
      return arr[m]!.times(s);
    };
    const vals = months.map(at);
    if (nCols > months.length) {
      vals.push(template.kind === 'BALANCE' ? at(toMonth) : vals.reduce((x, y) => x.plus(y), money(0)));
    }
    return vals;
  };
  const sumVals = (xs: Decimal[][]) => xs.reduce((acc, v) => acc.map((x, i) => x.plus(v[i]!)), zeros());
  const nonZero = (v: Decimal[]) => v.some((x) => !x.isZero());

  // Cuentas de cada línea.
  const lineAccounts = new Map<string, string[]>();
  const mapped = new Set<string>();
  for (const l of template.lines) {
    if (l.source !== 'ACCOUNTS') continue;
    const ids: string[] = [];
    for (const code of l.accounts) {
      const r = idx.resolve(code);
      if (!r.length) warnings.push(`La línea "${l.label || l.key}" cita la cuenta ${code}, que no existe en el plan de cuentas.`);
      ids.push(...r);
    }
    const unique = [...new Set(ids)].filter((id) => !isExcluded(idx.byId.get(id)!));
    lineAccounts.set(l.key, unique);
    unique.forEach((id) => mapped.add(id));
  }
  const withValues = [...mov.keys()].filter((id) => idx.byId.has(id));

  // Flujo de caja.
  const cashAccounts = template.kind === 'CASHFLOW'
    ? [...new Set((await db.treasuryAccount.findMany({ select: { glAccountId: true } })).map((t) => t.glAccountId))]
    : [];
  const flows = template.kind === 'CASHFLOW'
    ? await cashFlows(db, { companyIds: p.companyIds, year: p.year, fromMonth, toMonth, books, cashAccounts })
    : [];
  const categories = template.kind === 'CASHFLOW' ? await db.cashCategory.findMany() : [];
  const catById = new Map(categories.map((c) => [c.id, c]));
  const catLine = new Map<string, string>();
  if (template.kind === 'CASHFLOW') {
    for (const l of template.lines) {
      if (l.source !== 'CASH') continue;
      for (const text of l.categories) {
        const n = norm(text);
        const found = categories.filter((c) => [c.code, c.name, ...c.aliases].some((x) => norm(x) === n));
        for (const c of found) if (!catLine.has(c.id)) catLine.set(c.id, l.key);
      }
    }
  }
  const catchAll = new Map<string, string>();
  for (const l of template.lines) if (l.source === 'CASH' && !l.categories.length && l.cashFlow && !catchAll.has(l.cashFlow)) catchAll.set(l.cashFlow, l.key);
  const flowByLine = new Map<string, Decimal[]>();
  const flowCats = new Map<string, Map<string, Decimal[]>>();
  const colOfMonth = (m: number) => months.indexOf(m);
  const addFlow = (lineKey: string, catName: string, m: number, v: Decimal) => {
    const c = colOfMonth(m);
    if (c < 0) return;
    const arr = flowByLine.get(lineKey) ?? zeros();
    arr[c] = arr[c]!.plus(v);
    if (nCols > months.length) arr[nCols - 1] = arr[nCols - 1]!.plus(v);
    flowByLine.set(lineKey, arr);
    const cats = flowCats.get(lineKey) ?? new Map<string, Decimal[]>();
    const ca = cats.get(catName) ?? zeros();
    ca[c] = ca[c]!.plus(v);
    if (nCols > months.length) ca[nCols - 1] = ca[nCols - 1]!.plus(v);
    cats.set(catName, ca);
    flowCats.set(lineKey, cats);
  };
  const fxLine = template.lines.find((l) => l.source === 'CASH_FX')?.key;
  let unplacedFlows = money(0);
  for (const f of flows) {
    const v = money(f.v);
    const catName = f.category_id ? (catById.get(f.category_id)?.name ?? 'Sin categoría') : 'Sin categoría de tesorería';
    if (f.internal) {
      if (fxLine) addFlow(fxLine, f.category_id ? catName : 'Revaluación y saldos migrados', f.m, v);
      else unplacedFlows = unplacedFlows.plus(v);
      continue;
    }
    const target = (f.category_id && catLine.get(f.category_id)) || catchAll.get(f.cls) || catchAll.get('OPER');
    if (target) addFlow(target, catName, f.m, v);
    else unplacedFlows = unplacedFlows.plus(v);
  }
  if (!unplacedFlows.isZero()) warnings.push(`Hay ${unplacedFlows.toFixed(2)} USD de movimientos de caja sin línea en la plantilla.`);
  const cashBalance = (option: string | null): Decimal[] => {
    const at = (m: number) => cashAccounts.reduce((acc, id) => {
      const arr = mov.get(id);
      if (!arr) return acc;
      let s = money(0);
      for (let i = 0; i <= m; i++) s = s.plus(arr[i]!);
      return acc.plus(s);
    }, money(0));
    const opening = option === 'OPENING';
    const vals = months.map((m) => at(opening ? m - 1 : m));
    if (nCols > months.length) vals.push(at(opening ? fromMonth - 1 : toMonth));
    return vals;
  };

  // Resultado del ejercicio y de ejercicios sin cerrar (cuentas de ingresos y gastos).
  const nominal = withValues.filter((id) => isNominal(idx.byId.get(id)!.classification));
  /**
   * Resultado del ejercicio hasta cada mes. option: REALIZADO = sin las ventas y costos de exportación
   * pendientes de cierre (2900, 28xx); PENDIENTE = solo esas cuentas; vacío = todas las de resultados.
   */
  const resultYtd = (option: string | null): Decimal[] => {
    const ids = nominal.filter((id) => {
      const pending = idx.byId.get(id)!.isPendingExport;
      return option === 'REALIZADO' ? !pending : option === 'PENDIENTE' ? pending : true;
    });
    const at = (m: number) => ids.reduce((acc, id) => {
      const arr = mov.get(id)!;
      if (template.kind !== 'BALANCE') return acc.minus(arr[m]!);
      let s = money(0);
      for (let i = 1; i <= m; i++) s = s.plus(arr[i]!);
      return acc.minus(s);
    }, money(0));
    const vals = months.map(at);
    if (nCols > months.length) vals.push(template.kind === 'BALANCE' ? at(toMonth) : vals.reduce((x, y) => x.plus(y), money(0)));
    return vals;
  };
  const resultPrior = (): Decimal[] => {
    if (template.kind !== 'BALANCE') return zeros();
    const v = nominal.reduce((acc, id) => acc.minus(mov.get(id)![0]!), money(0));
    return Array.from({ length: nCols }, () => v);
  };

  // Valor de cada línea.
  const values = new Map<string, Decimal[]>();
  const details = new Map<string, { code: string; name: string; values: Decimal[] }[]>();
  const accountDetail = (ids: string[]) => ids
    .map((id) => ({ id, v: accountValues(id) }))
    .filter((x) => nonZero(x.v))
    .map((x) => ({ code: idx.byId.get(x.id)!.displayCode, name: idx.byId.get(x.id)!.name, values: x.v }));
  for (const l of template.lines) {
    if (l.source === 'ACCOUNTS') {
      const ids = lineAccounts.get(l.key) ?? [];
      values.set(l.key, sumVals(ids.map(accountValues)));
      details.set(l.key, accountDetail(ids));
    } else if (l.source === 'UNMAPPED') {
      const classes = new Set(l.accounts);
      const ids = withValues.filter((id) => {
        const a = idx.byId.get(id)!;
        return classes.has(a.classification) && !mapped.has(id) && !isExcluded(a);
      });
      ids.forEach((id) => mapped.add(id));
      values.set(l.key, sumVals(ids.map(accountValues)));
      details.set(l.key, accountDetail(ids));
    } else if (l.source === 'RESULT_YTD') values.set(l.key, resultYtd(l.option));
    else if (l.source === 'RESULT_PRIOR') values.set(l.key, resultPrior());
    else if (l.source === 'CASH' || l.source === 'CASH_FX') values.set(l.key, flowByLine.get(l.key) ?? zeros());
    else if (l.source === 'CASH_BALANCE') values.set(l.key, cashBalance(l.option));
  }
  const order = template.lines.map((l) => l.key);
  const formulas = new Map(template.lines.filter((l) => l.source === 'FORMULA' && l.formula).map((l) => [l.key, parseFormula(l.formula!)]));
  let evalOrder: string[] = order;
  try {
    evalOrder = formulaOrder(template.lines);
  } catch (e) {
    warnings.push(`Error en las fórmulas de la plantilla: ${(e as Error).message}`);
  }
  for (const k of evalOrder) {
    const f = formulas.get(k);
    if (!f) continue;
    try {
      values.set(k, Array.from({ length: nCols }, (_, c) => evalFormula(f, (ref) => values.get(ref)?.[c] ?? money(0), order)));
    } catch (e) {
      warnings.push(`Fórmula de "${k}": ${(e as Error).message}`);
    }
  }

  // Cuentas sin línea (estados completos).
  const unmapped: StatementResult['unmapped'] = [];
  if (template.checkCoverage) {
    const relevant = (a: AccountInfo) => (template.kind === 'BALANCE' ? !isNominal(a.classification) : isNominal(a.classification));
    for (const id of withValues) {
      const a = idx.byId.get(id)!;
      if (mapped.has(id) || !relevant(a) || isExcluded(a)) continue;
      const v = accountValues(id);
      if (!nonZero(v)) continue;
      unmapped.push({ code: a.displayCode, name: a.name, classification: a.classification, value: v.at(-1)!.toFixed(2) });
    }
    if (unmapped.length) warnings.push(`${unmapped.length} cuentas con importe no están en ninguna línea de la plantilla.`);
  }
  const eliminated: StatementResult['eliminated'] = [];
  if (eliminate && template.kind === 'INCOME') {
    for (const id of withValues) {
      const a = idx.byId.get(id)!;
      if (!a.isIntercompany || !isNominal(a.classification)) continue;
      const v = accountValues(id);
      if (nonZero(v)) eliminated.push({ code: a.displayCode, name: a.name, value: v.at(-1)!.toFixed(2) });
    }
  }
  const control = template.lines.find((l) => l.key === 'CONTROL');
  if (control) {
    const bad = (values.get('CONTROL') ?? []).findIndex((v) => v.abs().gt('0.01'));
    if (bad >= 0) warnings.push(`${control.label}: ${values.get('CONTROL')![bad]!.toFixed(2)} en ${columns[bad]!.label}.`);
  }

  // Comparación con el Excel.
  const refs = new Map(template.references.map((r) => [`${r.lineKey}|${r.year}|${r.month}`, r]));
  const hasRefs = template.references.length > 0;
  const comparison: Record<CompareStatus, number> | null = hasRefs ? { OK: 0, DIFF: 0, EXPLAINED: 0, NO_REF: 0 } : null;
  const explanations = hasRefs ? await db.bcExplanation.findMany() : [];
  const explainAccount = (id: string, m: number) => {
    const a = idx.byId.get(id)!;
    return explanations.find((e) => e.fullCode === a.displayCode && (e.year === null || e.year === p.year) && (e.month === null || e.month === m))?.reason ?? null;
  };
  const tolerance = new Map<string, Decimal>();
  const tolOf = (k: string): Decimal => {
    const cached = tolerance.get(k);
    if (cached) return cached;
    const l = template.lines.find((x) => x.key === k);
    let t = money('0.01');
    if (l?.source === 'ACCOUNTS') t = money('0.01').times(Math.max(1, l.accounts.length));
    const f = formulas.get(k);
    if (f) t = formulaRefs(f, order).reduce((s, r) => s.plus(r === k ? 0 : tolOf(r)), money(0)).plus('0.01');
    tolerance.set(k, t);
    return t;
  };
  // Valores del BC del Excel por fila (cuenta) y mes, para las líneas de cuentas.
  const lastBc = hasRefs ? await db.importBatch.findFirst({ where: { tableName: 'BC:referencia' }, orderBy: { createdAt: 'desc' } }) : null;
  const bcRefs = lastBc ? await db.bcReference.findMany({ where: { importId: lastBc.id, year: p.year } }) : [];
  const bcByRow = new Map(bcRefs.map((r) => [`${r.excelRow}|${r.month}`, r]));
  const bcSum = (codes: string[], month: number): Decimal | null => {
    let total = money(0);
    for (const code of codes) {
      const accs = idx.accounts.filter((a) => codeKey(a.displayCode) === codeKey(code));
      const list = accs.length ? accs : idx.accounts.filter((a) => a.code === code.trim());
      if (!list.length) return null;
      for (const a of list.slice(0, 1)) {
        const r = bcByRow.get(`${a.sortOrder}|${month}`);
        if (!r || r.valueUsd === null) return null;
        total = total.plus(money(r.valueUsd));
      }
    }
    return total;
  };
  // Estado de la comparación por línea y columna, en el orden de las fórmulas (las líneas citadas primero).
  const cmp = new Map<string, { excel: (string | null)[]; status: (CompareStatus | null)[]; why: (string | null)[] }>();
  const refKeys = new Set(template.references.map((r) => r.lineKey));
  const lineByKey = new Map(template.lines.map((l) => [l.key, l]));
  if (hasRefs) {
    for (const k of evalOrder) {
      const l = lineByKey.get(k)!;
      if (!refKeys.has(k)) continue;
      const vals = values.get(k) ?? zeros();
      const out = { excel: [] as (string | null)[], status: [] as (CompareStatus | null)[], why: [] as (string | null)[] };
      for (let c = 0; c < nCols; c++) {
        const col = columns[c]!;
        const ref = col.month ? refs.get(`${k}|${col.year}|${col.month}`) : undefined;
        if (!col.month || !ref) {
          out.excel.push(null);
          out.status.push(null);
          out.why.push(null);
          continue;
        }
        if (ref.valueUsd === null) {
          out.excel.push(null);
          out.status.push('NO_REF');
          out.why.push(ref.error ? `El Excel da ${ref.error}` : 'Sin cifra en el Excel');
          comparison!.NO_REF++;
          continue;
        }
        const ev = money(ref.valueUsd);
        out.excel.push(ev.toFixed(4));
        const diff = vals[c]!.minus(ev);
        let st: CompareStatus = diff.abs().lte(tolOf(k)) ? 'OK' : 'DIFF';
        let why: string | null = null;
        if (st === 'DIFF') {
          const f = formulas.get(k);
          const reasons: string[] = [];
          if (ref.manual) reasons.push('En el Excel es un importe escrito a mano, no calculado');
          else if (l.source === 'NONE') reasons.push('La plantilla no calcula esta línea (sin cuentas ni fórmula traducible)');
          else if (l.source === 'ACCOUNTS') {
            // ¿El sistema coincide con el BC del Excel para esas cuentas? Entonces la hoja no cuadra con su BC.
            const bc = bcSum(l.accounts, col.month);
            if (bc !== null && vals[c]!.minus(bc).abs().lte(tolOf(k))) {
              reasons.push(`La hoja del Excel no coincide con su propio BC (BC ${bc.toFixed(2)}); el sistema coincide con el BC`);
            } else if (ref.excelCheck === false) reasons.push('El propio Excel marca que esta línea no coincide con su BC');
          }
          if (!reasons.length && f) {
            const refsOf = [...new Set(formulaRefs(f, order))].filter((r) => r !== k);
            const excelOf = (r: string) => {
              const x = refs.get(`${r}|${col.year}|${col.month}`);
              return x?.valueUsd !== undefined && x?.valueUsd !== null ? money(x.valueUsd) : null;
            };
            // sistema − Excel = (diferencias de las líneas citadas) + (líneas sin cifra en el Excel) + (estructura del total).
            const excelEval = evalFormula(f, (r) => excelOf(r) ?? money(0), order);
            const added = refsOf.filter((r) => excelOf(r) === null && (values.get(r)?.[c] ?? money(0)).abs().gt('0.01'));
            const childDiff = refsOf.filter((r) => cmp.get(r)?.status[c] === 'DIFF');
            const childExplained = refsOf.filter((r) => cmp.get(r)?.status[c] === 'EXPLAINED');
            if (!childDiff.length) {
              if (excelEval.minus(ev).abs().gt(tolOf(k))) reasons.push('El total del Excel no suma las mismas líneas (corregido en el sistema)');
              if (added.length) reasons.push(`Incluye líneas que el Excel no tiene o deja vacías: ${added.map((r) => lineByKey.get(r)?.label || r).join(', ')}`);
              if (childExplained.length) reasons.push(`Por las diferencias explicadas de: ${childExplained.map((r) => lineByKey.get(r)?.label || r).join(', ')}`);
            }
          }
          if (!reasons.length) {
            const ids = l.source === 'ACCOUNTS' ? lineAccounts.get(k) ?? [] : collectAccounts(k);
            reasons.push(...new Set(ids.map((id) => explainAccount(id, col.month!)).filter((x): x is string => !!x)));
          }
          why = reasons.length ? reasons.join(' · ') : null;
          if (why) st = 'EXPLAINED';
        }
        out.status.push(st);
        out.why.push(why);
        comparison![st]++;
      }
      cmp.set(k, out);
    }
  }
  const lineResults: StatementLineResult[] = template.lines.map((l) => {
    const vals = values.get(l.key) ?? zeros();
    const neg = (v: Decimal) => (l.negate ? v.neg() : v);
    const c = cmp.get(l.key);
    return {
      key: l.key, label: l.label, source: l.source, indent: l.indent, bold: l.bold,
      values: vals.map((v) => neg(v).toFixed(4)),
      accounts: (details.get(l.key) ?? []).map((d) => ({ ...d, values: d.values.map((v) => neg(v).toFixed(4)) })),
      categories: [...(flowCats.get(l.key) ?? new Map<string, Decimal[]>()).entries()]
        .map(([name, v]) => ({ name, values: v.map((x) => neg(x).toFixed(4)) }))
        .sort((a, b) => money(b.values.at(-1)!).abs().comparedTo(money(a.values.at(-1)!).abs())),
      excel: c?.excel ?? null, status: c?.status ?? null, explanations: c?.why ?? null,
    };
  });
  function collectAccounts(k: string, seen = new Set<string>()): string[] {
    if (seen.has(k)) return [];
    seen.add(k);
    const f = formulas.get(k);
    if (!f) return lineAccounts.get(k) ?? [];
    return formulaRefs(f, order).flatMap((r) => collectAccounts(r, seen));
  }

  return {
    template: { id: template.id, code: template.code, name: template.name, kind: template.kind, notes: template.notes, origin: template.origin },
    columns, lines: lineResults, unmapped, eliminated, warnings, comparison,
  };
}

// ───────────── Alertas ─────────────

export interface StatementAlert {
  key: string;
  severity: 'error' | 'warning' | 'info';
  title: string;
  detail: string;
}

/** Alertas de los estados: descuadres, puente con saldo antiguo, tasas faltantes e intercompañía. */
export async function statementAlerts(db: Db, p: { companyIds: string[]; year: number; month: number }): Promise<StatementAlert[]> {
  const alerts: StatementAlert[] = [];
  const companies = await db.company.findMany({ where: { id: { in: p.companyIds } }, orderBy: { code: 'asc' } });
  // 1. Activo = Pasivo + Patrimonio (+ resultado) por empresa.
  for (const c of companies) {
    const tb = await trialBalance(db, { companyIds: [c.id], year: p.year, month: p.month, books: ['BASE', 'REAL'] });
    if (!tb.summary.balanced) {
      alerts.push({
        key: `balance-${c.code}`, severity: 'error', title: `${c.code}: el activo no es igual al pasivo más el patrimonio`,
        detail: `Diferencia ${money(tb.summary.difference).toFixed(2)} USD a ${endOfMonth(p.year, p.month)}.`,
      });
    }
  }
  // 2. Cuentas puente (699) con saldo de hace más de dos meses.
  const bridge = await db.account.findMany({ where: { OR: [{ code: '699' }, { displayCode: { startsWith: '699' } }], postable: true } });
  if (bridge.length) {
    const ids = bridge.map((b) => b.id);
    const m2 = p.month - 2 > 0 ? { y: p.year, m: p.month - 2 } : { y: p.year - 1, m: p.month + 10 };
    const balanceAt = async (y: number, m: number) => db.$queryRaw<{ company_id: string; account_id: string; v: Prisma.Decimal }[]>`
      SELECT company_id, account_id, sum(debit_usd - credit_usd) AS v FROM ledger_balance
      WHERE account_id = ANY(${ids}::uuid[]) AND company_id = ANY(${p.companyIds}::uuid[]) AND book::text IN ('BASE', 'REAL')
        AND year * 100 + month <= ${y * 100 + m}
      GROUP BY 1, 2`;
    const [now, before] = await Promise.all([balanceAt(p.year, p.month), balanceAt(m2.y, m2.m)]);
    const prev = new Map(before.map((b) => [`${b.company_id}|${b.account_id}`, money(b.v)]));
    for (const r of now) {
      const v = money(r.v);
      const old = prev.get(`${r.company_id}|${r.account_id}`) ?? money(0);
      if (v.abs().lt('0.01') || old.abs().lt('0.01')) continue;
      const acc = bridge.find((b) => b.id === r.account_id)!;
      const comp = companies.find((c) => c.id === r.company_id);
      alerts.push({
        key: `bridge-${r.company_id}-${acc.displayCode}`, severity: 'warning',
        title: `${comp?.code ?? ''}: ${acc.displayCode} ${acc.name} tiene saldo desde hace más de dos meses`,
        detail: `Saldo ${v.toFixed(2)} USD; ya tenía ${old.toFixed(2)} USD a ${endOfMonth(m2.y, m2.m)}. Revisa las partidas pendientes de asignar.`,
      });
    }
  }
  // 3. Tasas del último día del mes para las monedas con saldo.
  const eom = endOfMonth(p.year, p.month);
  const currencies = await db.journalLine.groupBy({
    by: ['currency'], where: { companyId: { in: p.companyIds }, entryDate: { lte: new Date(`${eom}T00:00:00Z`) }, currency: { not: FUNCTIONAL_CURRENCY } },
    _sum: { amount: true },
  });
  const withBalance = currencies.filter((c) => !money(c._sum.amount ?? 0).isZero()).map((c) => c.currency);
  const rated = new Set((await db.exchangeRate.findMany({ where: { rateDate: new Date(`${eom}T00:00:00Z`), currency: { in: withBalance } }, select: { currency: true } })).map((r) => r.currency));
  const missing = withBalance.filter((c) => !rated.has(c));
  if (missing.length) {
    alerts.push({
      key: 'rates', severity: 'warning', title: 'Faltan tasas de cambio del último día del mes',
      detail: `${missing.join(', ')} a ${eom.split('-').reverse().join('/')}: los saldos en esas monedas no se pueden revaluar.`,
    });
  }
  // 4. Intercompañía: las cuentas entre empresas del grupo deben compensarse en el consolidado.
  if (companies.length > 1) {
    const ic = await db.account.findMany({ where: { isIntercompany: true } });
    if (ic.length) {
      const rows = await db.$queryRaw<{ account_id: string; company_id: string; v: Prisma.Decimal }[]>`
        SELECT account_id, company_id, sum(debit_usd - credit_usd) AS v FROM ledger_balance
        WHERE account_id = ANY(${ic.map((a) => a.id)}::uuid[]) AND company_id = ANY(${p.companyIds}::uuid[])
          AND book::text IN ('BASE', 'REAL') AND year = ${p.year} AND month BETWEEN 1 AND ${p.month}
        GROUP BY 1, 2`;
      const balance = await db.$queryRaw<{ account_id: string; company_id: string; v: Prisma.Decimal }[]>`
        SELECT account_id, company_id, sum(debit_usd - credit_usd) AS v FROM ledger_balance
        WHERE account_id = ANY(${ic.map((a) => a.id)}::uuid[]) AND company_id = ANY(${p.companyIds}::uuid[])
          AND book::text IN ('BASE', 'REAL') AND year * 100 + month <= ${p.year * 100 + p.month}
        GROUP BY 1, 2`;
      const byCompany = (list: typeof rows, nominalOnly: boolean) => {
        const m = new Map<string, Decimal>();
        for (const r of list) {
          const a = ic.find((x) => x.id === r.account_id)!;
          if (isNominal(a.classification as Classification) !== nominalOnly) continue;
          m.set(r.company_id, (m.get(r.company_id) ?? money(0)).plus(money(r.v)));
        }
        return m;
      };
      const describe = (m: Map<string, Decimal>) =>
        [...m.entries()].filter(([, v]) => !v.isZero()).map(([cid, v]) => `${companies.find((c) => c.id === cid)?.code}: ${v.toFixed(2)}`).join(' · ');
      const results = byCompany(rows, true);
      const netResult = [...results.values()].reduce((s, v) => s.plus(v), money(0));
      if (netResult.abs().gt('0.01')) {
        alerts.push({
          key: 'intercompany-results', severity: 'warning', title: 'Ventas y costos internos no recíprocos en el año',
          detail: `Las ventas internas (1900) y sus costos (18xx) no se compensan: neto ${netResult.neg().toFixed(2)} USD (${describe(results)}). El consolidado los elimina; la diferencia es margen interno.`,
        });
      }
      const balances = byCompany(balance, false);
      const netBalance = [...balances.values()].reduce((s, v) => s.plus(v), money(0));
      if (netBalance.abs().gt('0.01')) {
        alerts.push({
          key: 'intercompany-balances', severity: 'warning', title: 'Saldos entre empresas del grupo no recíprocos',
          detail: `Las cuentas de operaciones entre empresas no suman 0 en el grupo: ${netBalance.toFixed(2)} USD (${describe(balances)}).`,
        });
      }
    }
  }
  return alerts;
}
