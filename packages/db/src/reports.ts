import { isNominal, money, type Classification } from '@kaluch/shared';
import type Decimal from 'decimal.js';
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import type { Tx } from './client';

type Db = PrismaClient | Tx;

export interface TrialBalanceParams {
  companyIds: string[];
  year: number;
  month: number;
  books: ('BASE' | 'REAL' | 'FISCAL')[];
  segmentIds?: string[];
  includeZero?: boolean;
}

export interface CurrencyBalance {
  currency: string;
  closingOrig: string;
  closingUsd: string;
}

export interface TrialBalanceRow {
  accountId: string;
  parentId: string | null;
  displayCode: string;
  name: string;
  nature: string;
  classification: Classification;
  postable: boolean;
  level: number;
  opening: string;
  debit: string;
  credit: string;
  closing: string;
  /** Valor comparable con el BC del Excel: saldo para cuentas de balance, movimiento del mes para nominales. */
  bcValue: string;
  byCurrency: CurrencyBalance[];
  anomaly: string | null;
}

export interface TrialBalance {
  year: number;
  month: number;
  rows: TrialBalanceRow[];
  totals: { opening: string; debit: string; credit: string; closing: string };
  summary: {
    assets: string;
    liabilities: string;
    equity: string;
    income: string;
    expenses: string;
    /** Activo − (Pasivo + Patrimonio + Resultado acumulado). Debe ser 0. */
    difference: string;
    balanced: boolean;
  };
}

interface RawBalance {
  account_id: string;
  currency: string;
  opening: Prisma.Decimal;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  opening_orig: Prisma.Decimal;
  period_orig: Prisma.Decimal;
}

/**
 * Balance de comprobación desde los saldos materializados (ledger_balance):
 * no recorre las líneas del diario.
 */
export async function trialBalance(db: Db, p: TrialBalanceParams): Promise<TrialBalance> {
  const key = p.year * 100 + p.month;
  const segmentFilter =
    p.segmentIds && p.segmentIds.length > 0
      ? Prisma.sql`AND lb.segment_key = ANY(${p.segmentIds}::uuid[])`
      : Prisma.empty;
  const raw = p.companyIds.length
    ? await db.$queryRaw<RawBalance[]>`
      SELECT lb.account_id, lb.currency,
        coalesce(sum(lb.debit_usd - lb.credit_usd) FILTER (WHERE lb.year * 100 + lb.month < ${key}), 0) AS opening,
        coalesce(sum(lb.debit_usd) FILTER (WHERE lb.year * 100 + lb.month = ${key}), 0) AS debit,
        coalesce(sum(lb.credit_usd) FILTER (WHERE lb.year * 100 + lb.month = ${key}), 0) AS credit,
        coalesce(sum(lb.amount_orig) FILTER (WHERE lb.year * 100 + lb.month < ${key}), 0) AS opening_orig,
        coalesce(sum(lb.amount_orig) FILTER (WHERE lb.year * 100 + lb.month = ${key}), 0) AS period_orig
      FROM ledger_balance lb
      WHERE lb.company_id = ANY(${p.companyIds}::uuid[])
        AND lb.book::text = ANY(${p.books}::text[])
        AND lb.year * 100 + lb.month <= ${key}
        ${segmentFilter}
      GROUP BY lb.account_id, lb.currency`
    : [];

  const accounts = await db.account.findMany({ orderBy: [{ sortOrder: 'asc' }, { fullCode: 'asc' }] });
  const byId = new Map(accounts.map((a) => [a.id, a]));

  interface Acc {
    opening: Decimal;
    debit: Decimal;
    credit: Decimal;
    cur: Map<string, { orig: Decimal; usd: Decimal }>;
  }
  const agg = new Map<string, Acc>();
  const get = (id: string): Acc => {
    let a = agg.get(id);
    if (!a) {
      a = { opening: money(0), debit: money(0), credit: money(0), cur: new Map() };
      agg.set(id, a);
    }
    return a;
  };

  for (const r of raw) {
    // Acumula en la cuenta y en todos sus ancestros.
    let id: string | null = r.account_id;
    while (id) {
      const a = get(id);
      a.opening = a.opening.plus(money(r.opening));
      a.debit = a.debit.plus(money(r.debit));
      a.credit = a.credit.plus(money(r.credit));
      const c = a.cur.get(r.currency) ?? { orig: money(0), usd: money(0) };
      c.orig = c.orig.plus(money(r.opening_orig)).plus(money(r.period_orig));
      c.usd = c.usd.plus(money(r.opening)).plus(money(r.debit)).minus(money(r.credit));
      a.cur.set(r.currency, c);
      id = byId.get(id)?.parentId ?? null;
    }
  }

  const levelOf = (id: string): number => {
    let level = 0;
    let cur = byId.get(id)?.parentId;
    while (cur) {
      level++;
      cur = byId.get(cur)?.parentId;
    }
    return level;
  };

  // Orden jerárquico: cada padre seguido de sus hijos.
  const childrenOf = new Map<string | null, typeof accounts>();
  for (const a of accounts) {
    const list = childrenOf.get(a.parentId) ?? [];
    list.push(a);
    childrenOf.set(a.parentId, list);
  }
  const ordered: typeof accounts = [];
  const walk = (parent: string | null) => {
    for (const a of childrenOf.get(parent) ?? []) {
      ordered.push(a);
      walk(a.id);
    }
  };
  walk(null);

  const rows: TrialBalanceRow[] = [];
  let tOpen = money(0), tDebit = money(0), tCredit = money(0), tClose = money(0);
  const cls = { AC: money(0), PC: money(0), CC: money(0), CND: money(0), CNA: money(0) };

  for (const a of ordered) {
    const v = agg.get(a.id);
    const opening = v?.opening ?? money(0);
    const debit = v?.debit ?? money(0);
    const credit = v?.credit ?? money(0);
    const closing = opening.plus(debit).minus(credit);
    if (!p.includeZero && opening.isZero() && debit.isZero() && credit.isZero() && closing.isZero()) {
      const hasActivity = v && [...v.cur.values()].some((c) => !c.orig.isZero());
      if (!hasActivity) continue;
    }
    const classification = a.classification as Classification;
    rows.push({
      accountId: a.id,
      parentId: a.parentId,
      displayCode: a.displayCode,
      name: a.name,
      nature: a.nature,
      classification,
      postable: a.postable,
      level: levelOf(a.id),
      opening: opening.toFixed(4),
      debit: debit.toFixed(4),
      credit: credit.toFixed(4),
      closing: closing.toFixed(4),
      bcValue: (isNominal(classification) ? debit.minus(credit) : closing).toFixed(4),
      byCurrency: v
        ? [...v.cur.entries()]
            .map(([currency, c]) => ({ currency, closingOrig: c.orig.toFixed(4), closingUsd: c.usd.toFixed(4) }))
            .sort((x, y) => x.currency.localeCompare(y.currency))
        : [],
      anomaly: a.anomaly,
    });
    if (a.parentId === null) {
      tOpen = tOpen.plus(opening);
      tDebit = tDebit.plus(debit);
      tCredit = tCredit.plus(credit);
      tClose = tClose.plus(closing);
      cls[classification] = cls[classification].plus(closing);
    }
  }

  const assets = cls.AC;
  const liabilities = cls.PC.neg();
  const equity = cls.CC.neg();
  const income = cls.CNA.neg();
  const expenses = cls.CND;
  const difference = assets.minus(liabilities).minus(equity).minus(income.minus(expenses));

  return {
    year: p.year,
    month: p.month,
    rows,
    totals: { opening: tOpen.toFixed(4), debit: tDebit.toFixed(4), credit: tCredit.toFixed(4), closing: tClose.toFixed(4) },
    summary: {
      assets: assets.toFixed(4),
      liabilities: liabilities.toFixed(4),
      equity: equity.toFixed(4),
      income: income.toFixed(4),
      expenses: expenses.toFixed(4),
      difference: difference.toFixed(4),
      balanced: difference.abs().lte('0.005') && tClose.abs().lte('0.005'),
    },
  };
}

/** Ids de la cuenta y todos sus descendientes. */
export async function accountSubtree(db: Db, accountId: string): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE t AS (
      SELECT id FROM account WHERE id = ${accountId}::uuid
      UNION ALL SELECT a.id FROM account a JOIN t ON a.parent_id = t.id
    ) SELECT id FROM t`;
  return rows.map((r) => r.id);
}

export interface GeneralLedgerParams {
  companyIds: string[];
  accountId: string;
  from: Date;
  to: Date;
  books: ('BASE' | 'REAL' | 'FISCAL')[];
  page: number;
  pageSize: number;
}

/** Mayor de una cuenta (incluye subcuentas) con saldo inicial y saldo acumulado, paginado en servidor. */
export async function generalLedger(db: Db, p: GeneralLedgerParams) {
  const ids = await accountSubtree(db, p.accountId);
  const where: Prisma.JournalLineWhereInput = {
    accountId: { in: ids },
    companyId: { in: p.companyIds },
    entryDate: { gte: p.from, lte: p.to },
    entry: { book: { in: p.books } },
  };
  const [openingAgg, total] = await Promise.all([
    db.journalLine.aggregate({
      _sum: { amountUsd: true },
      where: { accountId: { in: ids }, companyId: { in: p.companyIds }, entryDate: { lt: p.from }, entry: { book: { in: p.books } } },
    }),
    db.journalLine.count({ where }),
  ]);
  const lines = await db.journalLine.findMany({
    where,
    include: { entry: { select: { number: true, memo: true, kind: true, status: true, companyId: true } }, account: { select: { displayCode: true, name: true } } },
    orderBy: [{ entryDate: 'asc' }, { entry: { number: 'asc' } }, { lineNo: 'asc' }],
    skip: (p.page - 1) * p.pageSize,
    take: p.pageSize,
  });
  // Saldo acumulado hasta el inicio de la página.
  let running = money(openingAgg._sum.amountUsd ?? 0);
  if (p.page > 1 && lines.length > 0) {
    // La suma de las filas anteriores se calcula en la base de datos.
    const prev = await db.$queryRaw<{ s: Prisma.Decimal | null }[]>`
      SELECT sum(x.amount_usd) AS s FROM (
        SELECT jl.amount_usd FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
        WHERE jl.account_id = ANY(${ids}::uuid[]) AND jl.company_id = ANY(${p.companyIds}::uuid[])
          AND jl.entry_date BETWEEN ${p.from} AND ${p.to} AND je.book::text = ANY(${p.books}::text[])
        ORDER BY jl.entry_date, je.number, jl.line_no
        LIMIT ${(p.page - 1) * p.pageSize}) x`;
    running = running.plus(money(prev[0]?.s ?? 0));
  }
  return {
    opening: money(openingAgg._sum.amountUsd ?? 0).toFixed(4),
    total,
    page: p.page,
    pageSize: p.pageSize,
    lines: lines.map((l) => {
      running = running.plus(money(l.amountUsd));
      return {
        id: l.id,
        entryId: l.entryId,
        number: l.entry.number,
        entryDate: l.entryDate.toISOString().slice(0, 10),
        memo: l.memo ?? l.entry.memo,
        account: `${l.account.displayCode} ${l.account.name}`,
        currency: l.currency,
        amount: l.amount.toFixed(4),
        rate: l.rate.toString(),
        amountUsd: l.amountUsd.toFixed(4),
        balance: running.toFixed(4),
        status: l.entry.status,
      };
    }),
  };
}
