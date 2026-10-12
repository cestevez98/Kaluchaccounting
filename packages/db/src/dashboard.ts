import { endOfMonth, money, roundAmount } from '@kaluch/shared';
import type Decimal from 'decimal.js';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { Tx } from './client';
import { AGING_BUCKETS } from './parties';
import { containerUtility } from './sales';
import { statementAlerts } from './statements';

type Db = PrismaClient | Tx;

/**
 * Datos del panel de dirección para un mes: resultado mensual del año, antigüedad de cobros y
 * pagos, utilidad por contenedor y por mercado, comisiones pendientes y alertas de los estados.
 */
export async function dashboardData(db: Db, p: { companyIds: string[]; year: number; month: number; eliminate?: boolean }) {
  const eom = endOfMonth(p.year, p.month);
  const eliminate = (p.eliminate ?? true) && p.companyIds.length > 1;

  // Resultado realizado por mes del año: ingresos y gastos sin las ventas y costos de exportación pendientes de
  // cierre (2900, 28xx: facturas emitidas que aún no son resultado) ni, en el consolidado, las operaciones internas.
  const rows = p.companyIds.length
    ? await db.$queryRaw<{ month: number; classification: string; v: Prisma.Decimal }[]>`
      SELECT lb.month, a.classification::text AS classification, sum(lb.debit_usd - lb.credit_usd) AS v
      FROM ledger_balance lb JOIN account a ON a.id = lb.account_id
      WHERE lb.company_id = ANY(${p.companyIds}::uuid[]) AND lb.book::text IN ('BASE', 'REAL')
        AND lb.year = ${p.year} AND lb.month BETWEEN 1 AND ${p.month}
        AND a.classification::text IN ('CND', 'CNA') AND NOT a.is_pending_export
        ${eliminate ? Prisma.sql`AND NOT a.is_intercompany` : Prisma.empty}
      GROUP BY 1, 2`
    : [];
  const monthly = Array.from({ length: p.month }, (_, i) => {
    const m = i + 1;
    const income = rows.filter((r) => r.month === m && r.classification === 'CNA').reduce((s, r) => s.minus(money(r.v)), money(0));
    const expenses = rows.filter((r) => r.month === m && r.classification === 'CND').reduce((s, r) => s.plus(money(r.v)), money(0));
    return { month: m, incomeUsd: income.toFixed(2), expensesUsd: expenses.toFixed(2), resultUsd: income.minus(expenses).toFixed(2) };
  });

  // Antigüedad de cobros y pagos en USD (por vencimiento o fecha del documento).
  const items = await db.openItem.findMany({
    where: { companyId: { in: p.companyIds }, status: { in: ['OPEN', 'PARTIAL'] }, docDate: { lte: new Date(`${eom}T00:00:00Z`) } },
    select: { side: true, docDate: true, dueDate: true, amount: true, amountUsd: true, openAmount: true, partyAccount: { select: { account: { select: { displayCode: true } } } } },
  });
  const asOf = new Date(`${eom}T00:00:00Z`).getTime();
  const aging = {
    RECEIVABLE: Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, money(0)])) as Record<string, Decimal>,
    PAYABLE: Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, money(0)])) as Record<string, Decimal>,
  };
  let commissionsPending = money(0);
  for (const it of items) {
    const days = Math.max(0, Math.floor((asOf - (it.dueDate ?? it.docDate).getTime()) / 86_400_000));
    const bucket = AGING_BUCKETS.find((b) => days <= b.max)!.key;
    const amount = money(it.amount);
    const usd = amount.isZero() ? money(0) : money(it.amountUsd).times(money(it.openAmount)).div(amount);
    aging[it.side][bucket] = aging[it.side][bucket]!.plus(usd);
    if (it.side === 'PAYABLE' && it.partyAccount.account.displayCode.startsWith('410')) commissionsPending = commissionsPending.plus(usd);
  }
  const agingOut = (side: 'RECEIVABLE' | 'PAYABLE') =>
    AGING_BUCKETS.map((b) => ({ key: b.key, label: b.label, usd: roundAmount(aging[side][b.key]!).toFixed(2) }));

  // Utilidad por contenedor (los de más utilidad y los de pérdida).
  const containers = (await Promise.all(p.companyIds.map((companyId) => containerUtility(db, { companyId })))).flat();
  const containerTotals = containers.reduce(
    (s, c) => ({ utility: s.utility.plus(money(c.utilityUsd)), revenue: s.revenue.plus(money(c.revenueUsd)), stock: s.stock.plus(money(c.stockUsd)) }),
    { utility: money(0), revenue: money(0), stock: money(0) },
  );

  // Utilidad por mercado: ingresos por inversión (930.999-x) menos gastos por inversión (843.999-x) del año.
  const marketRows = p.companyIds.length
    ? await db.$queryRaw<{ display_code: string; name: string; v: Prisma.Decimal }[]>`
      SELECT a.display_code, a.name, sum(lb.debit_usd - lb.credit_usd) AS v
      FROM ledger_balance lb JOIN account a ON a.id = lb.account_id
      WHERE lb.company_id = ANY(${p.companyIds}::uuid[]) AND lb.book::text IN ('BASE', 'REAL')
        AND lb.year = ${p.year} AND lb.month BETWEEN 1 AND ${p.month}
        AND (a.display_code LIKE '843.999-%' OR a.display_code LIKE '930.999-%')
      GROUP BY 1, 2`
    : [];
  const markets = new Map<string, { market: string; name: string; incomeUsd: Decimal; expensesUsd: Decimal }>();
  for (const r of marketRows) {
    const market = r.display_code.split('-').slice(1).join('-');
    const m = markets.get(market) ?? { market, name: '', incomeUsd: money(0), expensesUsd: money(0) };
    const v = money(r.v);
    if (r.display_code.startsWith('930')) m.incomeUsd = m.incomeUsd.minus(v);
    else m.expensesUsd = m.expensesUsd.plus(v);
    // El nombre del mercado sale de la cuenta ("Gastos por Inversión - Mercado Cerro" → "Mercado Cerro").
    m.name = m.name || r.name.split(' - ').slice(1).join(' - ') || r.name;
    markets.set(market, m);
  }

  return {
    year: p.year,
    month: p.month,
    asOf: eom,
    monthly,
    ytd: {
      incomeUsd: monthly.reduce((s, m) => s.plus(money(m.incomeUsd)), money(0)).toFixed(2),
      expensesUsd: monthly.reduce((s, m) => s.plus(money(m.expensesUsd)), money(0)).toFixed(2),
      resultUsd: monthly.reduce((s, m) => s.plus(money(m.resultUsd)), money(0)).toFixed(2),
    },
    aging: { receivable: agingOut('RECEIVABLE'), payable: agingOut('PAYABLE') },
    commissionsPendingUsd: roundAmount(commissionsPending).toFixed(2),
    containers: {
      count: containers.length,
      utilityUsd: containerTotals.utility.toFixed(2),
      revenueUsd: containerTotals.revenue.toFixed(2),
      stockUsd: containerTotals.stock.toFixed(2),
      top: [...containers]
        .sort((a, b) => money(b.utilityUsd).comparedTo(money(a.utilityUsd)))
        .slice(0, 8)
        .map((c) => ({ id: c.id, code: c.code, description: c.description, status: c.status, revenueUsd: c.revenueUsd, utilityUsd: c.utilityUsd, marginPct: c.marginPct, stockUsd: c.stockUsd })),
    },
    markets: [...markets.values()]
      .map((m) => ({ market: m.market, name: m.name, incomeUsd: m.incomeUsd.toFixed(2), expensesUsd: m.expensesUsd.toFixed(2), resultUsd: m.incomeUsd.minus(m.expensesUsd).toFixed(2) }))
      .sort((a, b) => money(b.resultUsd).comparedTo(money(a.resultUsd))),
    alerts: await statementAlerts(db, { companyIds: p.companyIds, year: p.year, month: p.month }),
    generatedAt: new Date().toISOString(),
  };
}
